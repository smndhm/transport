-- Migration de vérification du déploiement automatique.
--
-- Elle ne change aucune donnée, aucune colonne, aucune règle d'accès :
-- elle pose un commentaire sur une table. Son seul rôle est de prouver
-- qu'un push arrive bien jusqu'à la base, et de laisser une trace
-- vérifiable une fois arrivée.
--
-- Rejouable : « comment on » écrase la valeur précédente.

comment on table public.responses is
  'Une réponse par accompagnateur et par match : conduit ou non, places offertes sans compter son enfant joueur. Déploiement automatique vérifié le 22/09/2026.';
