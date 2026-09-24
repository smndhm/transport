-- Droits explicites sur les tables exposées par l'API
--
-- Jusqu'ici, Supabase accordait automatiquement l'accès à l'API à toute
-- nouvelle table du schéma public. À partir du 30 octobre 2026, ce n'est
-- plus le cas : une table créée sans GRANT reste injoignable depuis
-- supabase-js, avec une erreur « permission denied ».
--
-- Les tables déjà en service conservent leurs droits, l'app ne risque
-- rien. Mais le schéma initial, lui, comptait sur cet automatisme : un
-- projet neuf, une branche de prévisualisation ou un « supabase db
-- reset » produiraient désormais une base muette. Ce fichier rend les
-- droits explicites, ici et partout où les migrations seront rejouées.
--
-- Rien n'est ouvert au passage : les règles RLS restent seules juges de
-- ce que chacun voit. Un GRANT ouvre la porte de l'immeuble, les règles
-- gardent celle des appartements — sans les deux, rien ne passe.
--
-- anon n'est pas servi volontairement : l'app ouvre une session anonyme
-- avant toute requête, donc elle parle toujours en tant
-- qu'authenticated, et aucune règle RLS ne vise anon.
--
-- Rejouable sans risque.

grant select, insert, update, delete on public.profiles       to authenticated;
grant select, insert, update, delete on public.teams          to authenticated;
grant select, insert, update, delete on public.team_members   to authenticated;
grant select, insert, update, delete on public.matches        to authenticated;
grant select, insert, update, delete on public.meeting_points to authenticated;
grant select, insert, update, delete on public.responses      to authenticated;

-- Les vues de récapitulatif sont en lecture seule (security_invoker :
-- elles appliquent les règles de qui les interroge).
grant select on public.meeting_point_status to authenticated;
grant select on public.match_status         to authenticated;

-- service_role court-circuite les règles RLS : réservé au serveur, il
-- n'est jamais utilisé par l'app, mais le tableau de bord et les outils
-- d'administration s'en servent.
grant select, insert, update, delete on all tables in schema public to service_role;
