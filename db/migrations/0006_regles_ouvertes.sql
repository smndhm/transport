-- 0006 — ce que la base autorise à un parent
--
-- Le schéma réservait à l'organisateur toute écriture sauf sa propre
-- réponse. En pratique c'est du frottement : un parent qui voit une
-- erreur dans une voiture ne peut pas la corriger, et un point de rdv
-- oublié attend le coach.
--
-- Pire : une écriture refusée par ces règles ne lève aucune erreur, elle
-- ne touche simplement rien. Une correction qui ne corrige rien, sans un
-- mot, coûte plus cher qu'elle ne protège.
--
-- Nouveau partage :
--   · le coach (organisateur) fait tout — matchs, équipe, adhésions ;
--   · un parent pose un point de rdv, ajoute une voiture, la modifie,
--     la supprime, y compris celle d'un autre parent.
-- La lecture ne change pas : il faut être membre, donc avoir reçu le
-- lien d'invitation. C'est lui le vrai filtre, comme ?admin dans l'app.
--
-- Il recouvre la migration 0005. Rejouable sans risque.

begin;

-- Points de rdv : n'importe quel membre peut en poser un et le corriger.
drop policy if exists points_write on public.meeting_points;
create policy points_write on public.meeting_points
  for all to authenticated
  using (public.is_team_member(public.match_team(match_id)))
  with check (public.is_team_member(public.match_team(match_id)));

-- Réponses : les deux règles d'écriture fusionnent en une, sans
-- distinction d'auteur — chacun peut corriger la voiture d'un autre.
drop policy if exists responses_own on public.responses;
drop policy if exists responses_organizer on public.responses;
create policy responses_write on public.responses
  for all to authenticated
  using (public.is_team_member(public.match_team(match_id)))
  with check (public.is_team_member(public.match_team(match_id)));

-- Le reste ne bouge pas : matchs, équipe et adhésions restent au coach.
-- (teams_write, teams_delete, members_admin, matches_write inchangées.)

commit;

-- Vérification : points_write et responses_write doivent citer
-- is_team_member, matches_write et teams_delete is_team_organizer.
select tablename as "table", policyname as "règle", cmd as "opération",
       case when qual like '%is_team_organizer%' then 'organisateur'
            when qual like '%is_team_member%' then 'membre'
            else qual end as "qui"
from pg_policies
where schemaname = 'public'
  and tablename in ('teams', 'team_members', 'matches', 'meeting_points', 'responses')
order by tablename, policyname;
