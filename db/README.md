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

## Où vit le schéma

Dans **`supabase/migrations/`**, à la racine du dépôt — l'emplacement
que l'intégration GitHub de Supabase surveille. Chaque fichier y porte
un horodatage `AAAAMMJJhhmmss_nom.sql` et n'est appliqué qu'une fois :
Supabase tient la liste dans `supabase_migrations.schema_migrations`.

| Fichier | Objet |
|---|---|
| `20260922190000_schema_initial.sql` | tout le schéma : tables, vues, fonctions, règles d'accès. C'est la référence |
| `20260922190100_temps_reel.sql` | publication temps réel sur `matches`, `meeting_points` et `responses` |

`supabase/config.toml` désigne le projet. Côté tableau de bord, le champ
**« Working directory »** de l'intégration attend le dossier *qui
contient* `supabase/` — ici la racine du dépôt, donc un champ vide.
Y mettre `supabase` fait chercher `supabase/supabase/migrations/` :
aucune migration trouvée, et le déploiement annonce « All migrations are
up to date » sans rien appliquer ni rien signaler. Attention à ne pas lui prêter
plus de pouvoir qu'il n'en a : sur la branche de production, le
déploiement annonce « Skipping configuration for protected branch » et
n'applique que les migrations. Les réglages qu'il décrit — au premier
chef **les connexions anonymes**, sans lesquelles plus personne ne lit
ni n'écrit quoi que ce soit — sont donc une mémoire de ce que le projet
doit avoir, à rétablir à la main si besoin.

## Ajouter une évolution

1. Créer `supabase/migrations/<horodatage>_ce_que_ça_fait.sql`.
2. La rendre **rejouable** : voir plus bas, c'est la règle qui a coûté
   le plus cher ici.
3. `db/test/run.sh` pour la valider sur un PostgreSQL jetable — il
   applique tout dans l'ordre, **rejoue une seconde fois**, puis lance
   les contrôles.
4. Pousser. Supabase applique ce qui manque.

Pour la première fois seulement, sur la base déjà en service :
`db/mise-a-niveau.sql` l'amène au schéma de référence et déclare
l'historique comme appliqué, pour que le premier déploiement ne tente
pas de recréer l'existant.

L'app, elle, tolère une base en retard : si une colonne apportée par une
migration manque, elle la retire de sa requête et continue, en masquant
la fonctionnalité concernée. Le déploiement du code ne casse donc pas
l'app si le SQL arrive une minute plus tard.

### L'historique d'avant

`db/migrations/0001` à `0006` sont les migrations de la période
manuelle, repliées dans le schéma initial. Elles restent pour
l'histoire ; on n'en exécute plus aucune.

## Qui a le droit de quoi

| | coach (`organizer`) | parent (`member`) | non-membre |
|---|---|---|---|
| voir l'équipe, les matchs, les réponses | ✔ | ✔ | ✘ |
| créer / modifier / supprimer un match | ✔ | ✘ | ✘ |
| renommer ou supprimer l'équipe, gérer les adhésions | ✔ | ✘ | ✘ |
| poser et corriger un point de rdv | ✔ | ✔ | ✘ |
| ajouter, corriger, supprimer **n'importe quelle** voiture | ✔ | ✔ | ✘ |

Le partage s'arrête là volontairement. Entre parents d'une même équipe,
une restriction d'écriture ne protège de rien — personne n'a intérêt à
saboter le covoiturage de son enfant — et elle coûte cher : une
correction refusée ne lève aucune erreur (voir plus bas), donc elle
échoue sans un mot. Le vrai filtre est le **lien d'invitation** : sans
lui on n'est membre de rien, et sans adhésion on ne lit ni n'écrit quoi
que ce soit. C'est le même compromis que le `?admin` de l'app.

Le rôle reste enregistré dans `team_members` : il décide de ce que
l'app affiche et de ce que la base autorise sur les matchs et l'équipe.

## Dédoublonnage de l'import : pourquoi pas de `ON CONFLICT`

`matches_external_uid_key` est un index **partiel** (`where external_uid
is not null`) : il ne contraint que les matchs importés, pas ceux créés
à la main. PostgreSQL n'accepte d'utiliser un index partiel pour un
`ON CONFLICT` que si la requête répète sa condition — ce que PostgREST
ne sait pas envoyer, d'où l'erreur `42P10` (« no unique or exclusion
constraint matching the ON CONFLICT specification ») au moindre import.

L'app lit donc les `external_uid` déjà présents et n'insère que les
nouveaux. L'index reste le garde-fou : si deux appareils importent en
même temps, l'insertion perdante échoue en `23505` et l'app relit avant
de réessayer. `db/test/import.sql` rejoue les cinq cas sur un vrai
PostgreSQL.

## Une table sans GRANT est muette

Depuis le 30 octobre 2026, Supabase n'accorde plus d'office l'accès à
l'API aux nouvelles tables du schéma `public`. Une table créée sans
`grant` existe, se remplit en SQL, et reste pourtant injoignable depuis
l'app : `permission denied`.

**Toute migration qui crée une table doit donc accorder ses droits**,
dans le même fichier :

```sql
grant select, insert, update, delete on public.ma_table to authenticated;
grant select, insert, update, delete on public.ma_table to service_role;
```

`anon` n'est pas servi : l'app ouvre une session anonyme avant toute
requête, elle parle donc toujours en tant qu'`authenticated`, et aucune
règle RLS ne vise `anon`.

Un `grant` n'ouvre rien de plus : il donne accès à la table, les règles
RLS décident ensuite ligne par ligne. Il faut les deux.

`db/test/run.sh` n'accorde volontairement aucun droit sur nos tables —
il ne fournit que ce que la plateforme fournit, l'accès aux schémas et à
`auth.users`. Un `grant` oublié fait donc échouer le banc d'essai avec
le même `permission denied` que la vraie base.

## Une migration doit se rejouer sans erreur

`create policy` n'a pas de variante `if not exists` : chaque création
doit être précédée de son `drop policy if exists`, **y compris pour une
règle que le fichier vient d'introduire**. Sans cela, le fichier
fonctionne une fois puis échoue — et comme tout est dans un `begin …
commit`, l'échec annule aussi les créations qui avaient réussi avant
lui. C'est ce qui a manqué à 0002 (`responses_identity`) puis à 0006
(`responses_write`). Contrôle : appliquer le fichier deux fois de suite
sur une base neuve, puis une troisième sur une base à laquelle il manque
une seule des règles.

## Un DELETE refusé par RLS ne lève pas d'erreur

Pour un `INSERT` ou un `UPDATE`, une règle violée renvoie `42501`. Pour
un `SELECT` ou un `DELETE`, non : les lignes non couvertes par une règle
sont simplement invisibles, et le `DELETE` efface zéro ligne en
annonçant un succès. L'app ne teste donc pas l'erreur mais ce qui a
réellement été supprimé ou modifié (`.delete().select()`,
`.update().select()`), sans quoi elle annoncerait des changements qui
n'ont pas eu lieu. C'est vrai pour les équipes comme pour les réponses :
un parent qui touche la réponse d'un autre ne reçoit aucune erreur, la
ligne lui est simplement invisible.

## Vérifier avant de pousser

`db/test/run.sh` monte un PostgreSQL jetable, applique les migrations
dans l'ordre, **les rejoue une seconde fois** pour prouver qu'elles sont
idempotentes, puis rejoue une série de contrôles : intégrité entre matchs et points de rdv,
unicité des réponses, dédoublonnage de l'import Kalisport, et surtout les
règles d'accès (un non-membre ne voit rien ; un parent corrige n'importe
quelle voiture et pose un point de rdv, mais ne touche ni au calendrier
ni à l'équipe).

Les blocs marqués « doit échouer » affichent une erreur : c'est le
résultat attendu.
