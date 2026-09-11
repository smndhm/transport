# 🚌 Transport

Petite app pour organiser les déplacements aux matchs : qui vient, qui conduit, combien de places — sans se perdre dans les fils WhatsApp.

**POC — itération 2.**

## Fonctionnalités actuelles

- Deux usages : l'**organisateur** ouvre l'app avec `?admin` dans l'URL (création de match, import Kalisport, modification, suppression) et partage les liens ; les **parents** ouvrent le lien reçu, le match s'ajoute à leur liste et ils n'ont qu'à répondre. Ce n'est pas une sécurité, juste un paramètre non communiqué — le mode est mémorisé sur l'appareil, `?admin=0` le désactive
- Hiérarchie : catégorie (U11, U13…) → matchs → points de rdv. La liste des matchs est regroupée par catégorie ; chaque match porte une heure d'arrivée sur place (pour ceux qui s'y rendent seuls) et un ou plusieurs points de rdv — plusieurs dans le cas d'une entente
- Créer un match à l'extérieur (catégorie, adversaire, date/heure, lieu, heure sur place, et autant de points de rdv que nécessaire avec pour chacun son heure de départ et son nombre de joueurs à prendre) — l'app ne sert que pour les déplacements
- Importer les matchs depuis Kalisport : lien d'export du calendrier (webcal:// ou https://), fichier .ics ou copier-coller, avec détection des doublons au ré-import
- Si le lien du calendrier est accepté par le serveur (CORS), il est mémorisé et un bouton « Actualiser » synchronise les matchs en un clic
- Une réponse par accompagnateur : nom, je conduis (oui/non), et si oui le nombre de places (sans compter son enfant joueur) et ce qu'il fait si sa voiture n'est finalement pas utile (venir quand même ou rester) ; le point de départ est demandé seulement quand le match en compte plusieurs
- Les infos voiture sont mémorisées d'un match sur l'autre ; une fois répondu, le formulaire laisse place à un bouton « Modifier ma réponse », et chaque réponse de la liste s'édite d'un simple toucher
- Récapitulatif : voitures, et places libres vs personnes à prendre (les joueurs annoncés + les accompagnateurs sans voiture) — vert dès que les joueurs sont couverts, avec une note si des accompagnateurs restent à caser, plus un bilan par point de rdv qui signale les places en trop, nomme les conducteurs prêts à laisser leur voiture et liste les réponses rattachées à ce point
- Partage du sondage par lien (à coller dans WhatsApp) — pas de compte, pas de serveur

## Comment ça marche (mode POC)

App 100 % statique (HTML/CSS/JS vanilla, zéro dépendance, zéro build). Les données sont stockées dans le navigateur (`localStorage`). Le bouton **Partager** encode le sondage complet dans l'URL : la personne qui ouvre le lien récupère les réponses existantes et ajoute la sienne, puis repartage le lien mis à jour.

C'est le compromis assumé du POC : pas de synchro temps réel, le lien fait office de "base de données qui circule". Un vrai backend viendra dans une itération future.

## Déploiement

Déployé automatiquement sur **GitHub Pages** à chaque push (workflow `.github/workflows/deploy.yml`).

> Si le premier déploiement échoue : dans les réglages du dépôt, **Settings → Pages → Source → GitHub Actions**, puis relancer le workflow.

## Développement local

Aucun outillage nécessaire :

```bash
# ouvrir index.html directement, ou :
python3 -m http.server 8000
```

## Pistes pour les prochaines itérations

- [ ] Backend léger pour une vraie synchro des réponses (plus besoin de repartager le lien)
- [ ] Affectation des passagers aux voitures
- [ ] Heure et lieu de rendez-vous pour le départ
- [ ] Notifications / relances des joueurs qui n'ont pas répondu
- [ ] Liste de l'équipe pré-remplie
- [ ] Synchro Kalisport automatique via GitHub Actions (lien iCal en secret du dépôt, plus besoin d'import manuel)
