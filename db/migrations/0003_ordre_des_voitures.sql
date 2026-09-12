-- 0003 — ordre des réponses à un point de rdv
--
-- L'organisateur décide quelles voitures partent en priorité. Les places
-- sont ensuite affectées dans cet ordre jusqu'à couvrir le besoin ; les
-- voitures au-delà ne sont pas nécessaires.
--
-- Rejouable sans risque.

begin;

alter table public.responses
  add column if not exists position smallint not null default 0;

create index if not exists responses_order_idx
  on public.responses (meeting_point_id, position, created_at);

commit;

-- Vérification : doit renvoyer une ligne.
select 'colonne ' || column_name as objet
from information_schema.columns
where table_name = 'responses' and column_name = 'position';
