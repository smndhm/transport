-- 0001 — create_team crée le profil de l'organisateur
--
-- Bug : team_members.profile_id référence profiles, mais create_team
-- insérait l'adhésion sans créer le profil. Un organisateur qui n'avait
-- jamais répondu à un sondage n'en avait pas, et la création d'équipe
-- échouait sur une violation de clé étrangère.
--
-- À exécuter sur une base déjà créée avec le schéma initial.
-- (db/schema.sql contient déjà la version corrigée pour une base neuve.)

begin;

drop function if exists public.create_team(text, text);

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
