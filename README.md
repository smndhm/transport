# 🚌 Transport

Petite app pour organiser les déplacements aux matchs : qui vient, qui conduit, combien de places — sans se perdre dans les fils WhatsApp.

**POC — itération 2.**

## Fonctionnalités actuelles

- Créer un match (adversaire, date/heure, domicile ou extérieur, lieu)
- Importer les matchs depuis Kalisport : lien d'export du calendrier (webcal:// ou https://), fichier .ics ou copier-coller, avec détection des doublons au ré-import
- Si le lien du calendrier est accepté par le serveur (CORS), il est mémorisé et un bouton « Actualiser » synchronise les matchs en un clic
- Chaque joueur répond : présent/absent, je peux conduire, nombre de places passagers
- Récapitulatif : nombre de présents, voitures, places dispo vs passagers à transporter
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
