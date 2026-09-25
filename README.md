# 🚌 Transport

Petite app pour organiser les déplacements aux matchs : qui vient, qui conduit, combien de places — sans se perdre dans les fils WhatsApp.

En service sur une vraie base, avec synchronisation en direct entre les téléphones.

## Comment ça s'utilise

Le **coach** ouvre l'app avec `?admin` dans l'URL, crée sa catégorie (U11, U13…) et partage **un seul lien d'invitation** aux parents. Ce lien fait tout : il inscrit l'appareil dans l'équipe, et la liste des matchs apparaît. Plus rien à repartager ensuite — les réponses de chacun arrivent en direct chez les autres.

Le paramètre `?admin` n'est pas une sécurité, juste une adresse non communiquée ; le mode est mémorisé sur l'appareil. Le bouton **« 👁 Voir comme un parent »** le met en pause pour vérifier ce que l'équipe voit.

### Qui peut quoi

| | coach | parent |
|---|---|---|
| créer, modifier, supprimer un match | ✔ | ✘ |
| créer, renommer, supprimer une catégorie | ✔ | ✘ |
| poser et corriger un point de rdv | ✔ | ✔ |
| ajouter, corriger, supprimer **n'importe quelle** voiture | ✔ | ✔ |

Entre parents d'une même équipe, rien n'est verrouillé : c'est un covoiturage entre familles, pas un registre. Le vrai filtre est le lien d'invitation.

## Ce que l'app sait faire

- **Hiérarchie** catégorie → matchs → points de rdv. Chaque match porte une heure d'arrivée sur place (pour ceux qui s'y rendent seuls) et un ou plusieurs points de rdv — plusieurs dans le cas d'une entente — avec pour chacun son heure de départ et son nombre de joueurs à prendre. L'app ne sert que pour les matchs à l'extérieur
- **Import Kalisport** : lien d'export du calendrier (`webcal://` ou `https://`), fichier `.ics` ou copier-coller, avec détection des matchs déjà importés. Si le serveur accepte le lien (CORS), il est mémorisé et un bouton « Actualiser » resynchronise en un clic
- **Répondre en trois champs** : on arrive sur le récapitulatif du match, et un bouton « ➕ Ajouter ma réponse » ouvre le formulaire — nom de l'accompagnateur, je conduis oui/non, et si oui le nombre de places **sans compter son enfant joueur**. Un parent sans voiture compte dans les personnes à prendre. Le point de départ n'est demandé que si le match a plusieurs rdv
- **Trop de voitures ?** Le conducteur dit s'il vient quand même ou s'il peut rester au parking. Le coach ordonne les voitures avec ↑↓ ; les places sont affectées dans cet ordre jusqu'à couvrir le besoin, et une voiture au-delà s'affiche « non nécessaire »
- **Répondre pour quelqu'un d'autre** : un parent qui a répondu par SMS, ou la seconde voiture d'une famille, se saisit depuis n'importe quel téléphone
- **Récapitulatif** par match et par point de rdv : voitures, places libres contre personnes à prendre, places en trop, conducteurs prêts à laisser leur voiture. Vert dès que les joueurs sont couverts, avec une note si des accompagnateurs restent à caser
- **Hors ligne** : la dernière vue connue reste lisible, et l'app dit clairement quand l'affichage n'est pas à jour plutôt que d'annoncer un succès en l'air

## Comment c'est fait

App 100 % statique — HTML/CSS/JS vanilla, zéro build, zéro dépendance côté code. Deux fichiers portent tout : `app.js` (les écrans) et `data.js` (la base).

Les données vivent dans **Supabase** (PostgreSQL + PostgREST + temps réel). Pas de mot de passe : chaque appareil ouvre une session anonyme qui lui donne une identité stable, et les règles d'accès de la base s'appuient dessus. Le schéma, les règles et leur justification sont dans **[`db/README.md`](db/README.md)**.

Si la base est injoignable, l'app bascule sur le stockage local et continue d'afficher la dernière version connue.

## Déploiement

Tout part de `main`, automatiquement :

| | où | déclencheur |
|---|---|---|
| l'app | GitHub Pages | `.github/workflows/deploy.yml` |
| le schéma | Supabase | intégration GitHub, dossier `supabase/` |

## Développement local

```bash
python3 -m http.server 8000     # puis ouvrir http://localhost:8000/?admin
```

Pour valider une évolution du schéma sans toucher à la base en service :

```bash
db/test/run.sh                  # PostgreSQL jetable, migrations + contrôles
```

## Pistes pour la suite

- [ ] Affectation nominative des passagers aux voitures
- [ ] Relances des familles qui n'ont pas répondu
- [ ] Liste de l'équipe pré-remplie depuis Kalisport
- [ ] Synchro Kalisport automatique (lien iCal en secret du dépôt, plus d'import manuel)
- [ ] Trajet retour distinct de l'aller
