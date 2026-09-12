-- 0002 — réponses saisies au nom de quelqu'un d'autre
--
-- Une réponse était forcément rattachée à un profil, donc à un appareil.
-- Or l'organisateur doit pouvoir saisir la voiture d'un parent qui a
-- répondu par SMS, et une famille peut engager deux voitures depuis un
-- seul téléphone.
--
-- Une réponse porte donc soit un profil (celui qui répond pour lui-même),
-- soit un nom libre (« invité »), jamais les deux. created_by retient qui
-- l'a saisie, pour qu'il puisse la corriger ensuite.

begin;

alter table public.responses
  alter column profile_id drop not null,
  add column if not exists guest_name text,
  add column if not exists created_by uuid references public.profiles (id) on delete set null;

update public.responses set created_by = profile_id where created_by is null;

alter table public.responses
  alter column created_by set default auth.uid(),
  alter column created_by set not null;

alter table public.responses
  add constraint responses_identity check (
    (profile_id is not null and guest_name is null)
    or (profile_id is null and guest_name is not null and length(btrim(guest_name)) between 1 and 60)
  );

-- unique (match_id, profile_id) tient toujours : PostgreSQL considère les
-- NULL comme distincts, donc plusieurs invités par match sont permis,
-- mais une seule réponse par personne identifiée.

create index if not exists responses_created_by_idx on public.responses (created_by);

-- Chacun gère sa réponse et celles qu'il a saisies ; l'organisateur, tout.
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

commit;
