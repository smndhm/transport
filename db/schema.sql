-- Transport — schéma relationnel (PostgreSQL 15+ / Supabase)
--
-- Modèle : une équipe (catégorie) réunit des membres et des matchs ;
-- un match a un ou plusieurs points de rdv ; chaque membre dépose une
-- réponse par match, rattachée au point d'où il part.
--
-- Identité : pas de mot de passe. Chaque appareil ouvre une session
-- anonyme Supabase (à activer dans Authentication > Providers), qui
-- donne un auth.uid() stable. Le lien partagé porte le jeton de
-- l'équipe ; join_team() échange ce jeton contre une adhésion. Les
-- règles RLS s'appuient ensuite sur auth.uid(), ce qui fonctionne
-- aussi sur les abonnements temps réel.
--
-- Ce que le schéma NE modélise pas, volontairement : les joueurs
-- eux-mêmes. Leur convocation est gérée dans Kalisport ; ici on ne
-- retient que le nombre de joueurs attendus à chaque point de rdv.

-- Tout est dans une transaction : si une seule instruction échoue, rien
-- n'est créé et le script peut être relancé tel quel après correction.
begin;

create extension if not exists pgcrypto with schema extensions;

-- Jeton d'invitation : aléatoire, non devinable, sûr en URL.
create or replace function public.gen_token(n int default 18)
returns text language sql volatile as $$
  select replace(replace(encode(extensions.gen_random_bytes(n), 'base64'), '+', '-'), '/', '_');
$$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

create type public.member_role as enum ('organizer', 'parent');

-- ---------------------------------------------------------------- --
-- Personnes
-- ---------------------------------------------------------------- --

-- Une ligne par appareil/personne. Les préférences voiture vivent ici
-- plutôt que recopiées dans chaque réponse : c'est une propriété de la
-- personne, pas du match.
create table public.profiles (
  id                       uuid primary key references auth.users (id) on delete cascade,
  display_name             text not null check (length(btrim(display_name)) between 1 and 60),
  default_seats            smallint not null default 3 check (default_seats between 0 and 8),
  default_stays_if_unused  boolean not null default false,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

-- ---------------------------------------------------------------- --
-- Équipes et adhésions
-- ---------------------------------------------------------------- --

create table public.teams (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) between 1 and 40),  -- U11, U13…
  season      text check (season is null or length(season) <= 20),
  join_token  text not null unique default public.gen_token(),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- Table de jonction : qui appartient à quelle équipe, et à quel titre.
create table public.team_members (
  team_id     uuid not null references public.teams (id) on delete cascade,
  profile_id  uuid not null references public.profiles (id) on delete cascade,
  role        public.member_role not null default 'parent',
  joined_at   timestamptz not null default now(),
  primary key (team_id, profile_id)
);

create index team_members_profile_idx on public.team_members (profile_id);

-- ---------------------------------------------------------------- --
-- Matchs
-- ---------------------------------------------------------------- --

-- Date et heures séparées : l'heure d'un match est une heure locale, et
-- elle est parfois inconnue à la création. Un timestamptz forcerait une
-- précision qu'on n'a pas et introduirait des pièges de fuseau.
create table public.matches (
  id               uuid primary key default gen_random_uuid(),
  team_id          uuid not null references public.teams (id) on delete cascade,
  opponent         text not null check (length(btrim(opponent)) between 1 and 120),
  match_date       date not null,
  kickoff_time     time,
  venue            text,
  arrival_time     time,          -- heure sur place, pour ceux qui y vont seuls
  external_source  text,          -- 'kalisport' pour un match importé
  external_uid     text,          -- UID iCal, pour ne pas réimporter en double
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index matches_team_date_idx on public.matches (team_id, match_date);

-- Dédoublonnage de l'import : ne contraint que les matchs importés.
create unique index matches_external_uid_key
  on public.matches (team_id, external_source, external_uid)
  where external_uid is not null;

-- ---------------------------------------------------------------- --
-- Points de rdv
-- ---------------------------------------------------------------- --

create table public.meeting_points (
  id                uuid not null default gen_random_uuid(),
  match_id          uuid not null references public.matches (id) on delete cascade,
  name              text not null check (length(btrim(name)) between 1 and 120),
  departure_time    time,
  players_expected  smallint not null default 0 check (players_expected between 0 and 60),
  position          smallint not null default 1,
  primary key (id),
  -- Référence par (match, point) : permet la clé étrangère composite
  -- des réponses ci-dessous.
  unique (match_id, id)
);

create index meeting_points_match_idx on public.meeting_points (match_id, position);

-- ---------------------------------------------------------------- --
-- Réponses
-- ---------------------------------------------------------------- --

-- Une réponse porte soit un profil (celui qui répond pour lui-même),
-- soit un nom libre : l'organisateur saisit la voiture d'un parent qui a
-- répondu par SMS, et une famille peut engager deux voitures depuis un
-- seul téléphone. created_by retient qui l'a saisie.
create table public.responses (
  id                uuid primary key default gen_random_uuid(),
  match_id          uuid not null references public.matches (id) on delete cascade,
  meeting_point_id  uuid,
  profile_id        uuid references public.profiles (id) on delete cascade,
  guest_name        text,
  created_by        uuid not null default auth.uid() references public.profiles (id) on delete set null,
  drives            boolean not null,
  seats             smallint not null default 0 check (seats between 0 and 8),
  stays_if_unused   boolean not null default false,
  -- Ordre de départ décidé par l'organisateur : les places sont affectées
  -- dans cet ordre jusqu'à couvrir le besoin.
  position          smallint not null default 0,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  -- Un profil ou un nom libre, jamais les deux ni aucun.
  constraint responses_identity check (
    (profile_id is not null and guest_name is null)
    or (profile_id is null and guest_name is not null and length(btrim(guest_name)) between 1 and 60)
  ),

  -- Une seule réponse par personne identifiée et par match. Les NULL
  -- étant distincts, plusieurs réponses au nom d'invités restent permises.
  unique (match_id, profile_id),

  -- Pas de places annoncées sans voiture.
  constraint responses_seats_need_car check (drives or seats = 0),

  -- Le point de départ choisi appartient forcément à CE match : c'est la
  -- clé étrangère composite qui l'interdit, pas le code de l'app.
  constraint responses_point_belongs_to_match
    foreign key (match_id, meeting_point_id)
    references public.meeting_points (match_id, id)
    on delete set null (meeting_point_id)
);

create index responses_match_idx on public.responses (match_id);
create index responses_point_idx on public.responses (meeting_point_id);
create index responses_profile_idx on public.responses (profile_id);
create index responses_created_by_idx on public.responses (created_by);
create index responses_order_idx on public.responses (meeting_point_id, position, created_at);

create trigger profiles_touch       before update on public.profiles       for each row execute function public.touch_updated_at();
create trigger teams_touch          before update on public.teams          for each row execute function public.touch_updated_at();
create trigger matches_touch        before update on public.matches        for each row execute function public.touch_updated_at();
create trigger responses_touch      before update on public.responses      for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------- --
-- Le récapitulatif, calculé par la base
-- ---------------------------------------------------------------- --

-- security_invoker : la vue applique les règles RLS de celui qui
-- l'interroge, au lieu de celles de son propriétaire.
create view public.meeting_point_status with (security_invoker = true) as
select
  mp.id                as meeting_point_id,
  mp.match_id,
  mp.name,
  mp.departure_time,
  mp.position,
  mp.players_expected,
  count(*) filter (where r.drives)                          as cars,
  coalesce(sum(r.seats) filter (where r.drives), 0)         as seats_offered,
  count(*) filter (where r.drives is false)                 as adults_without_car,
  mp.players_expected + count(*) filter (where r.drives is false) as people_to_take,
  -- Le feu vert ne dépend que des joueurs : un accompagnateur sans
  -- voiture compte dans les personnes à prendre, mais ne bloque pas.
  coalesce(sum(r.seats) filter (where r.drives), 0) >= mp.players_expected as players_covered,
  greatest(
    coalesce(sum(r.seats) filter (where r.drives), 0)
      - (mp.players_expected + count(*) filter (where r.drives is false)),
    0
  )                                                          as spare_seats
from public.meeting_points mp
left join public.responses r on r.meeting_point_id = mp.id
group by mp.id, mp.match_id, mp.name, mp.departure_time, mp.position, mp.players_expected;

create view public.match_status with (security_invoker = true) as
select
  m.id as match_id,
  m.team_id,
  coalesce(sum(s.cars), 0)           as cars,
  coalesce(sum(s.seats_offered), 0)  as seats_offered,
  coalesce(sum(s.people_to_take), 0) as people_to_take,
  coalesce(bool_and(s.players_covered), true) as players_covered
from public.matches m
left join public.meeting_point_status s on s.match_id = m.id
group by m.id, m.team_id;

-- ---------------------------------------------------------------- --
-- Sécurité
-- ---------------------------------------------------------------- --

-- security definer : ces fonctions lisent team_members sans repasser
-- par ses propres règles RLS, ce qui éviterait une récursion.
create or replace function public.is_team_member(p_team uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team and profile_id = auth.uid()
  );
$$;

create or replace function public.is_team_organizer(p_team uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.team_members
    where team_id = p_team and profile_id = auth.uid() and role = 'organizer'
  );
$$;

create or replace function public.match_team(p_match uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select team_id from public.matches where id = p_match;
$$;

alter table public.profiles      enable row level security;
alter table public.teams         enable row level security;
alter table public.team_members  enable row level security;
alter table public.matches       enable row level security;
alter table public.meeting_points enable row level security;
alter table public.responses     enable row level security;

-- Profils : chacun le sien, plus ceux des coéquipiers (pour afficher
-- les noms dans la liste des réponses).
create policy profiles_self on public.profiles
  for all to authenticated using (id = auth.uid()) with check (id = auth.uid());

create policy profiles_teammates on public.profiles
  for select to authenticated using (
    exists (
      select 1 from public.team_members mine
      join public.team_members theirs on theirs.team_id = mine.team_id
      where mine.profile_id = auth.uid() and theirs.profile_id = profiles.id
    )
  );

-- Équipes : visibles par leurs membres, modifiables par l'organisateur.
create policy teams_read on public.teams
  for select to authenticated using (public.is_team_member(id));
create policy teams_write on public.teams
  for update to authenticated using (public.is_team_organizer(id)) with check (public.is_team_organizer(id));
-- La suppression emporte en cascade adhésions, matchs, points et réponses.
create policy teams_delete on public.teams
  for delete to authenticated using (public.is_team_organizer(id));

create policy members_read on public.team_members
  for select to authenticated using (public.is_team_member(team_id));
create policy members_admin on public.team_members
  for all to authenticated using (public.is_team_organizer(team_id)) with check (public.is_team_organizer(team_id));

-- Matchs : le calendrier appartient au coach. Lui seul en crée, en
-- modifie et en supprime — le mode ?admin devient une vraie autorisation.
create policy matches_read on public.matches
  for select to authenticated using (public.is_team_member(team_id));
create policy matches_write on public.matches
  for all to authenticated using (public.is_team_organizer(team_id)) with check (public.is_team_organizer(team_id));

-- Points de rdv : n'importe quel membre peut en poser un et le corriger.
-- Un point oublié n'a pas à attendre le coach.
create policy points_read on public.meeting_points
  for select to authenticated using (public.is_team_member(public.match_team(match_id)));
create policy points_write on public.meeting_points
  for all to authenticated using (public.is_team_member(public.match_team(match_id)))
  with check (public.is_team_member(public.match_team(match_id)));

-- Réponses : tout membre de l'équipe voit et corrige n'importe quelle
-- voiture, y compris celle d'un autre parent. C'est un covoiturage entre
-- familles, pas un registre : le filtre, c'est le lien d'invitation.
create policy responses_read on public.responses
  for select to authenticated using (public.is_team_member(public.match_team(match_id)));
create policy responses_write on public.responses
  for all to authenticated
  using (public.is_team_member(public.match_team(match_id)))
  with check (public.is_team_member(public.match_team(match_id)));

-- ---------------------------------------------------------------- --
-- Rejoindre une équipe depuis un lien partagé
-- ---------------------------------------------------------------- --

-- Seul point d'entrée pour un nouvel arrivant : le jeton ne permet que
-- d'adhérer, jamais de lister les équipes.
create or replace function public.join_team(p_token text, p_display_name text default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_team uuid;
begin
  if auth.uid() is null then
    raise exception 'Session requise';
  end if;

  select id into v_team from public.teams where join_token = p_token;
  if v_team is null then
    raise exception 'Lien invalide ou expiré';
  end if;

  insert into public.profiles (id, display_name)
  values (auth.uid(), coalesce(nullif(btrim(p_display_name), ''), 'Parent'))
  on conflict (id) do update
    set display_name = coalesce(nullif(btrim(excluded.display_name), ''), profiles.display_name);

  insert into public.team_members (team_id, profile_id, role)
  values (v_team, auth.uid(), 'parent')
  on conflict (team_id, profile_id) do nothing;

  return v_team;
end $$;

revoke all on function public.join_team(text, text) from public;
grant execute on function public.join_team(text, text) to authenticated;

-- Crée une équipe et fait de son auteur l'organisateur.
-- Le profil est créé au passage : team_members le référence, et un
-- organisateur qui n'a encore jamais répondu n'en a pas.
create or replace function public.create_team(
  p_name text,
  p_season text default null,
  p_display_name text default null
)
returns public.teams language plpgsql security definer set search_path = public as $$
declare
  v_team public.teams;
begin
  if auth.uid() is null then
    raise exception 'Session requise';
  end if;

  insert into public.profiles (id, display_name)
  values (auth.uid(), coalesce(nullif(btrim(p_display_name), ''), 'Organisateur'))
  on conflict (id) do update
    set display_name = coalesce(nullif(btrim(excluded.display_name), ''), profiles.display_name);

  insert into public.teams (name, season) values (btrim(p_name), nullif(btrim(p_season), ''))
  returning * into v_team;

  insert into public.team_members (team_id, profile_id, role)
  values (v_team.id, auth.uid(), 'organizer');

  return v_team;
end $$;

revoke all on function public.create_team(text, text, text) from public;
grant execute on function public.create_team(text, text, text) to authenticated;

commit;

-- ------------------------------------------------------------------ --
-- Pour repartir de zéro (efface TOUTES les données) : exécuter ceci
-- avant de rejouer le script.
--
--   drop view if exists public.match_status, public.meeting_point_status;
--   drop table if exists public.responses, public.meeting_points,
--                        public.matches, public.team_members,
--                        public.teams, public.profiles cascade;
--   drop function if exists public.join_team(text, text),
--                           public.create_team(text, text),
--                           public.is_team_member(uuid),
--                           public.is_team_organizer(uuid),
--                           public.match_team(uuid),
--                           public.touch_updated_at(),
--                           public.gen_token(int);
--   drop type if exists public.member_role;
-- ------------------------------------------------------------------ --
