\set ON_ERROR_STOP 0
-- Reproduit le 42P10 : l'index unique de l'import est partiel, PostgreSQL
-- refuse de l'utiliser pour un ON CONFLICT sans sa condition.
insert into public.teams (id, name) values ('11111111-1111-1111-1111-111111111111', 'U13');

\echo '--- 1. ON CONFLICT comme le faisait PostgREST (doit échouer en 42P10) ---'
insert into public.matches (team_id, opponent, match_date, external_source, external_uid)
values ('11111111-1111-1111-1111-111111111111', 'FC Alpha', '2026-10-03', 'kalisport', 'evt-1')
on conflict (team_id, external_source, external_uid) do nothing;

\echo '--- 2. Avec la condition de l index (ce que PostgREST ne sait pas envoyer) ---'
insert into public.matches (team_id, opponent, match_date, external_source, external_uid)
values ('11111111-1111-1111-1111-111111111111', 'FC Alpha', '2026-10-03', 'kalisport', 'evt-1')
on conflict (team_id, external_source, external_uid) where external_uid is not null do nothing;

\echo '--- 3. La nouvelle voie : lire les uid connus, insérer le reste ---'
select external_uid from public.matches
where team_id = '11111111-1111-1111-1111-111111111111'
  and external_source = 'kalisport' and external_uid is not null;

insert into public.matches (team_id, opponent, match_date, external_source, external_uid)
values ('11111111-1111-1111-1111-111111111111', 'FC Beta', '2026-10-10', 'kalisport', 'evt-2');

\echo '--- 4. Le garde-fou tient toujours (doit échouer en 23505) ---'
insert into public.matches (team_id, opponent, match_date, external_source, external_uid)
values ('11111111-1111-1111-1111-111111111111', 'FC Beta', '2026-10-10', 'kalisport', 'evt-2');

\echo '--- 5. Deux matchs créés à la main (uid null) cohabitent ---'
insert into public.matches (team_id, opponent, match_date) values
  ('11111111-1111-1111-1111-111111111111', 'FC Manuel', '2026-11-07'),
  ('11111111-1111-1111-1111-111111111111', 'FC Manuel', '2026-11-07');

select opponent, external_uid from public.matches order by match_date, opponent;
