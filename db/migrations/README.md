# Historique (période manuelle)

Ces six fichiers ont été exécutés à la main dans le SQL Editor de
Supabase, entre la mise en service de la base et le branchement du
déploiement automatique. Leur effet est replié dans
`supabase/migrations/20260922190000_schema_initial.sql`.

**Ils ne servent plus à rien** : ne les exécutez pas, ne les modifiez
pas. Ils sont conservés parce que chacun raconte un bug réel, et que le
`README.md` du dossier parent y renvoie.

| Fichier | Ce qu'il corrigeait |
|---|---|
| `0001_create_team_cree_le_profil.sql` | `create_team` créait l'adhésion sans créer le profil de l'organisateur : création d'équipe impossible |
| `0002_reponses_invitees.sql` | une réponse peut porter un nom libre au lieu d'un profil, pour saisir la voiture d'un parent qui a répondu par SMS |
| `0003_ordre_des_voitures.sql` | colonne d'ordre des réponses à un point de rdv |
| `0004_suppression_equipe.sql` | droit de supprimer une équipe |
| `0005_regles_des_reponses.sql` | réparation des règles d'écriture des réponses |
| `0006_regles_ouvertes.sql` | partage actuel coach / parent |
