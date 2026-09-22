-- Vérification du schéma sur un PostgreSQL local.
-- Les blocs marqués « doit échouer » provoquent volontairement une
-- erreur : c'est le résultat attendu, chacun est isolé par un savepoint.
\pset pager off
\set ON_ERROR_STOP off
begin;
\pset pager off

-- Deux comptes : l'organisateur et un parent.
insert into auth.users (id) values
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');

-- ---- L'organisateur crée son équipe --------------------------------
set role authenticated;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
-- Aucun profil préexistant : create_team doit le créer lui-même.
select 'équipe créée : ' || name || ' / jeton long de ' || length(join_token) || ' caractères' as "1. create_team"
from public.create_team('U13', '2026-2027', 'Simon');

select id as team from public.teams limit 1 \gset

-- ---- Un match avec deux points de rdv (entente) ---------------------
insert into public.matches (id, team_id, opponent, match_date, kickoff_time, venue, arrival_time, external_source, external_uid)
values ('aaaaaaaa-0000-0000-0000-000000000001', :'team', 'FC Entente', '2026-09-26', '15:00', 'Stade de Trifouillis', '14:15', 'kalisport', 'evt-1');

insert into public.meeting_points (id, match_id, name, departure_time, players_expected, position) values
  ('bbbbbbbb-0000-0000-0000-000000000001', 'aaaaaaaa-0000-0000-0000-000000000001', 'Gymnase A', '13:00', 3, 1),
  ('bbbbbbbb-0000-0000-0000-000000000002', 'aaaaaaaa-0000-0000-0000-000000000001', 'Salle B',   '13:10', 3, 2);

-- Un autre match, pour tester l'étanchéité entre matchs.
insert into public.matches (id, team_id, opponent, match_date)
values ('aaaaaaaa-0000-0000-0000-000000000002', :'team', 'FC Autre', '2026-10-03');
insert into public.meeting_points (id, match_id, name, players_expected)
values ('bbbbbbbb-0000-0000-0000-000000000009', 'aaaaaaaa-0000-0000-0000-000000000002', 'Ailleurs', 2);

-- ---- Le parent rejoint par le lien ---------------------------------
select join_token from public.teams limit 1 \gset
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select 'adhésion via jeton : ' || (public.join_team(:'join_token', 'Martin') is not null) as "2. join_team";

-- ---- Réponses -------------------------------------------------------
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into public.responses (match_id, meeting_point_id, profile_id, drives, seats, stays_if_unused)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', auth.uid(), true, 4, false);

set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into public.responses (match_id, meeting_point_id, profile_id, drives, seats, stays_if_unused)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000002', auth.uid(), false, 0, false);

-- ---- Le récapitulatif calculé par la base ---------------------------
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
select name, players_expected as joueurs, cars as voitures, seats_offered as places,
       adults_without_car as "sans voiture", people_to_take as "à prendre",
       players_covered as "joueurs couverts", spare_seats as "en trop"
from public.meeting_point_status
where match_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by position;

set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';

\echo '--- 1. Un point de rdv qui appartient à un AUTRE match : doit échouer'
savepoint s1;
insert into public.responses (match_id, meeting_point_id, profile_id, drives, seats)
values ('aaaaaaaa-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000001', auth.uid(), true, 2);
rollback to s1;

\echo '--- 2. Deux réponses de la même personne sur le même match : doit échouer'
savepoint s2;
insert into public.responses (match_id, meeting_point_id, profile_id, drives, seats)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'bbbbbbbb-0000-0000-0000-000000000001', auth.uid(), true, 2);
rollback to s2;

\echo '--- 3. Des places sans voiture : doit échouer'
savepoint s3;
insert into public.responses (match_id, meeting_point_id, profile_id, drives, seats)
values ('aaaaaaaa-0000-0000-0000-000000000002', 'bbbbbbbb-0000-0000-0000-000000000009', auth.uid(), false, 3);
rollback to s3;

\echo '--- 4. Réimport du même événement Kalisport : doit échouer'
savepoint s4;
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
insert into public.matches (team_id, opponent, match_date, external_source, external_uid)
select team_id, 'FC Entente (doublon)', '2026-09-26', 'kalisport', 'evt-1' from public.matches limit 1;
rollback to s4;

\echo '--- 5. Un parent tente de créer un match : doit échouer (RLS)'
savepoint s5;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
insert into public.matches (team_id, opponent, match_date)
select team_id, 'Match pirate', '2026-11-01' from public.matches limit 1;
rollback to s5;

\echo '--- 6. Un inconnu (pas membre) lit les matchs : doit renvoyer 0 ligne'
set request.jwt.claim.sub = '33333333-3333-3333-3333-333333333333';
select count(*) as "matchs visibles par un non-membre" from public.matches;

\echo '--- 7. Le parent, lui, voit bien les matchs de son équipe'
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
select count(*) as "matchs visibles par le parent" from public.matches;

\echo '--- 8. Le parent modifie SA réponse : doit réussir'
update public.responses set drives = true, seats = 2 where profile_id = auth.uid();
select drives, seats from public.responses where profile_id = auth.uid();

\echo '--- 9. Le parent corrige la réponse du coach : doit réussir'
with u as (update public.responses set seats = 6
  where profile_id = '11111111-1111-1111-1111-111111111111' returning id)
select count(*) as "lignes corrigées" from u;

\echo '--- 9 bis. Le parent pose un point de rdv oublié : doit réussir'
insert into public.meeting_points (match_id, name, departure_time, players_expected)
values ('aaaaaaaa-0000-0000-0000-000000000001', 'École du bourg', '13:15', 2);
select count(*) as "points de rdv du match" from public.meeting_points
where match_id = 'aaaaaaaa-0000-0000-0000-000000000001';

\echo '--- 9 ter. Mais il ne supprime pas le match : 0 ligne (RLS)'
with d as (delete from public.matches
  where id = 'aaaaaaaa-0000-0000-0000-000000000001' returning id)
select count(*) as "matchs supprimés par le parent" from d;

\echo '--- 10. L organisateur corrige la réponse du parent : doit réussir'
set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
update public.responses set seats = 5 where profile_id = '22222222-2222-2222-2222-222222222222';
select p.display_name, r.drives, r.seats from public.responses r join public.profiles p on p.id = r.profile_id order by p.display_name;

\echo '--- 11. Suppression d un point de rdv : les réponses survivent, détachées'
delete from public.meeting_points where id = 'bbbbbbbb-0000-0000-0000-000000000002';
select p.display_name, r.meeting_point_id is null as "détaché"
from public.responses r join public.profiles p on p.id = r.profile_id
where r.match_id = 'aaaaaaaa-0000-0000-0000-000000000001' order by p.display_name;

-- ---- Suppression d'une équipe ---------------------------------------
-- Une équipe en double doit pouvoir disparaître, avec tout ce qui en
-- dépend, et seulement à la main de son organisateur.
set role authenticated;
set request.jwt.claim.sub = '22222222-2222-2222-2222-222222222222';
with d as (delete from public.teams where id = :'team' returning id)
select 'lignes supprimées par le parent : ' || count(*) as "12. un parent ne supprime pas l'équipe" from d;

set request.jwt.claim.sub = '11111111-1111-1111-1111-111111111111';
with d as (delete from public.teams where id = :'team' returning id)
select 'lignes supprimées par l''organisateur : ' || count(*) as "13. l'organisateur supprime son équipe" from d;

-- Compté hors RLS : une ligne invisible n'est pas une ligne supprimée.
reset role;
select 'équipes : ' || (select count(*) from public.teams)
    || ' · adhésions : ' || (select count(*) from public.team_members)
    || ' · matchs : ' || (select count(*) from public.matches)
    || ' · points : ' || (select count(*) from public.meeting_points)
    || ' · réponses : ' || (select count(*) from public.responses)
  as "14. la cascade a tout emporté";

rollback;
