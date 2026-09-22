-- 0004 — l'organisateur peut supprimer une équipe
--
-- Une équipe créée en double (un bouton tapé deux fois sur un réseau
-- lent) restait à vie dans le sélecteur : aucune règle ne permettait de
-- supprimer la ligne, et un DELETE sans règle ne lève pas d'erreur — il
-- ne supprime simplement rien. L'app croyait donc avoir supprimé.
--
-- La suppression emporte en cascade les adhésions, les matchs, leurs
-- points de rdv et les réponses : c'est déjà ce que déclarent les clés
-- étrangères du schéma, il ne manquait que le droit.

begin;

drop policy if exists teams_delete on public.teams;
create policy teams_delete on public.teams
  for delete to authenticated using (public.is_team_organizer(id));

commit;

-- Vérification : doit renvoyer la règle.
select policyname as "règle", cmd as "opération"
from pg_policies
where tablename = 'teams' and policyname = 'teams_delete';
