# ♠ Poker Texas Hold'em — Heads-Up

Jeu de poker Texas Hold'em jouable dans le navigateur.
- **Mode Local** : vous affrontez une IA directement dans le navigateur (aucune connexion requise).
- **Mode En Ligne** : créez un salon et partagez le code avec un ami via Socket.IO.

## Structure du projet

```
POKER JEU/
├── server.js               ← Serveur Express + Socket.IO (sert aussi le frontend)
├── package.json
├── .gitignore
├── render.yaml             ← Config déploiement Render
└── public/
    ├── index.html          ← Page d'accueil
    ├── game.html           ← Table de jeu
    ├── css/style.css
    └── js/
        ├── poker-engine.js ← Moteur de poker (UMD, client + serveur)
        ├── ai.js           ← Intelligence artificielle
        ├── ui.js           ← Rendu DOM
        ├── local-game.js   ← Orchestration mode local
        └── online-game.js  ← Orchestration mode en ligne
```

## Lancer en local

```bash
npm install
npm start
# Ouvrir http://localhost:3000
```

## Règles implémentées

- Heads-up (2 joueurs), démarrage à 100 jetons chacun
- Blinds : petite blind = 1, grosse blind = 2
- Spécificité heads-up : le bouton = petite blind, parle en premier preflop
- Actions : fold, check, call, bet, raise, all-in
- Évaluation stricte : carte haute → quinte flush royale, kickers inclus
- Pot de 5 000 pièces virtuelles pour le gagnant de la partie

## Déploiement sur Render

Voir la section **Déploiement** dans le guide fourni.
