-- Mise à niveau de la base en service, à exécuter UNE fois dans le SQL
-- Editor de Supabase avant de brancher l'intégration GitHub.
--
-- Elle fait deux choses :
--
--   1. elle amène la base au schéma de référence, quel que soit l'état
--      exact où elle se trouve (colonne d'ordre des voitures, règle de
--      suppression d'équipe, partage coach/parent) ;
--   2. elle déclare l'historique des migrations comme déjà appliqué,
--      pour que le premier déploiement automatique n'essaie pas de
--      recréer ce qui existe.
--
-- Chaque instruction est rejouable : la relancer ne coûte rien.

begin;

-- ---- 1. Colonne d'ordre des voitures (ex-migration 0003) ------------
alter table public.responses
  add column if not exists position smallint not null default 0;

create index if not exists responses_order_idx
  on public.responses (meeting_point_id, position, created_at);

-- ---- 2. Suppression d'une équipe (ex-migration 0004) ----------------
-- Sans cette règle, le DELETE n'efface rien et ne lève aucune erreur.
drop policy if exists teams_delete on public.teams;
create policy teams_delete on public.teams
  for delete to authenticated using (public.is_team_organizer(id));

-- ---- 3. Partage coach / parent (ex-migration 0006) ------------------
-- Un parent pose un point de rdv et corrige n'importe quelle voiture ;
-- le calendrier et l'équipe restent au coach.
drop policy if exists points_write on public.meeting_points;
create policy points_write on public.meeting_points
  for all to authenticated
  using (public.is_team_member(public.match_team(match_id)))
  with check (public.is_team_member(public.match_team(match_id)));

drop policy if exists responses_own on public.responses;
drop policy if exists responses_organizer on public.responses;
drop policy if exists responses_write on public.responses;
create policy responses_write on public.responses
  for all to authenticated
  using (public.is_team_member(public.match_team(match_id)))
  with check (public.is_team_member(public.match_team(match_id)));

-- ---- 4. Historique des migrations -----------------------------------
-- La table que tient l'outil de déploiement. Elle existe déjà sur un
-- projet Supabase récent ; on la crée au cas où, avec sa vraie forme.
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (
  version     text primary key,
  statements  text[],
  name        text
);

-- Le schéma de référence et le temps réel sont déjà en place : on les
-- déclare appliqués plutôt que de les laisser rejouer.
insert into supabase_migrations.schema_migrations (version, name) values
  ('20260922190000', 'schema_initial'),
  ('20260922190100', 'temps_reel')
on conflict (version) do nothing;

commit;

-- ---- Vérification ---------------------------------------------------
-- Attendu : la colonne position, 11 règles dont teams_delete en coach
-- et points_write / responses_write en membre, et deux migrations
-- déclarées appliquées.
select 'colonne position' as objet,
       count(*)::text as resultat
from information_schema.columns
where table_schema = 'public' and table_name = 'responses' and column_name = 'position'
union all
select 'règles d''accès', count(*)::text
from pg_policies
where schemaname = 'public'
  and tablename in ('teams', 'team_members', 'matches', 'meeting_points', 'responses')
union all
select 'migrations déclarées', string_agg(version, ', ' order by version)
from supabase_migrations.schema_migrations;
