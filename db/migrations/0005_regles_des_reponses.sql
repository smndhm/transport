-- 0005 — remettre d'aplomb les règles d'accès aux réponses
--
-- Symptôme : « Suppression impossible — cette réponse n'est pas la
-- vôtre », y compris pour l'organisateur de l'équipe, et y compris sur
-- une réponse qu'il a lui-même saisie.
--
-- Deux règles gouvernent les réponses : responses_own (chacun gère la
-- sienne et celles qu'il a saisies) et responses_organizer (l'organisateur
-- gère tout). Si l'une manque — la migration 0002 s'interrompant avant
-- d'avoir recréé responses_own, par exemple — la base ne refuse rien :
-- elle rend simplement les lignes invisibles à l'écriture. Zéro ligne
-- modifiée, aucune erreur.
--
-- Ce fichier recrée les deux dans leur état attendu. Rejouable sans
-- risque, y compris sur une base déjà correcte.

begin;

drop policy if exists responses_own on public.responses;
create policy responses_own on public.responses
  for all to authenticated
  using (
    public.is_team_member(public.match_team(match_id))
    and (profile_id = auth.uid() or created_by = auth.uid())
  )
  with check (
    public.is_team_member(public.match_team(match_id))
    and (
      profile_id = auth.uid()
      or (profile_id is null and created_by = auth.uid())
    )
  );

drop policy if exists responses_organizer on public.responses;
create policy responses_organizer on public.responses
  for all to authenticated
  using (public.is_team_organizer(public.match_team(match_id)))
  with check (public.is_team_organizer(public.match_team(match_id)));

commit;

-- Vérification : doit renvoyer les trois règles (lecture + les deux
-- d'écriture). Si responses_read manque aussi, rejouez schema.sql sur
-- une base neuve : la vôtre a trop dérivé.
select policyname as "règle", cmd as "opération"
from pg_policies
where tablename = 'responses'
order by policyname;
