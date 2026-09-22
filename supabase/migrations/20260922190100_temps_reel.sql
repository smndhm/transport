-- Active le temps réel sur les tables qui changent pendant un sondage.
-- Équivalent des cases à cocher du tableau de bord (Database →
-- Publications), mais indépendant de la version de l'interface.
-- Rejouable sans risque : n'ajoute que ce qui manque.

do $$
declare
  t text;
begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;

  foreach t in array array['matches', 'meeting_points', 'responses'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
