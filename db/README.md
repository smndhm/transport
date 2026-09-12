# Base de données

Schéma relationnel PostgreSQL, destiné à Supabase (mais portable tel quel
sur un Postgres auto-hébergé : rien n'est propriétaire hormis `auth.uid()`).

## Le modèle en une phrase

Une **équipe** (catégorie U11, U13…) réunit des **membres** et des
**matchs** ; un match a un ou plusieurs **points de rdv** ; chaque membre
dépose une **réponse** par match, rattachée au point d'où il part.

```
teams ──< team_members >── profiles
  │                           │
  └──< matches ──< meeting_points ──< responses >──┘
```

Ce qui n'est volontairement pas modélisé : les joueurs eux-mêmes. Leur
convocation vit dans Kalisport ; le schéma ne retient que le nombre de
joueurs attendus à chaque point de rdv.

## Mise en place sur Supabase

1. Créer le projet en choisissant une **région européenne**.
2. Activer les connexions anonymes : *Authentication → Providers →
   Anonymous sign-ins*. C'est ce qui donne à chaque appareil un
   `auth.uid()` stable, sans mot de passe à retenir.
3. Coller `schema.sql` dans le *SQL Editor* et l'exécuter.
4. Activer le temps réel en exécutant `realtime.sql` dans le *SQL
   Editor*. L'emplacement de ce réglage dans l'interface change selon
   les versions du tableau de bord ; le script, lui, est stable et
   rejouable.
5. Récupérer l'URL du projet et la clé publique `anon` pour l'app.

## Migrations

L'app tolère une base en retard : si une colonne apportée par une
migration manque, elle la retire de sa requête et continue, en masquant
la fonctionnalité concernée. Le déploiement du code ne casse donc plus
l'app en attendant l'exécution du SQL — mais la fonctionnalité n'arrive
qu'une fois la migration passée.

`schema.sql` crée une base neuve. Sur une base déjà en service, il ne
faut plus le rejouer : chaque évolution passe par un fichier numéroté
dans `migrations/`, à exécuter dans l'ordre.

| Fichier | Objet |
|---|---|
| `0001_create_team_cree_le_profil.sql` | `create_team` créait l'adhésion sans créer le profil de l'organisateur, ce qui faisait échouer la création d'équipe |
| `0002_reponses_invitees.sql` | une réponse peut désormais porter un nom libre au lieu d'un profil, pour saisir la voiture d'un parent qui a répondu autrement |
| `0003_ordre_des_voitures.sql` | ordre des réponses à un point de rdv, pour affecter les places aux voitures prioritaires |

## Vérifier le schéma avant de l'appliquer

`db/test/run.sh` monte un PostgreSQL jetable, applique le schéma et
rejoue une série de contrôles : intégrité entre matchs et points de rdv,
unicité des réponses, dédoublonnage de l'import Kalisport, et surtout les
règles d'accès (un non-membre ne voit rien, un parent ne peut pas créer
de match ni modifier la réponse d'un autre, l'organisateur si).

Les blocs marqués « doit échouer » affichent une erreur : c'est le
résultat attendu.
