/**
 * online-game.js
 * Mode en ligne : Socket.IO côté client.
 * Le serveur est autoritatif : il distribue les cartes et valide les actions.
 */

const OnlineGame = (() => {
  'use strict';

  let socket    = null;
  let myIndex   = -1;   // seat : 0 ou 1
  let roomCode  = '';
  let gameState = null; // état reçu du serveur

  // ─── INITIALISATION ────────────────────────────────────────────────────────

  function init() {
    // Connexion au même serveur qui a servi la page (pas de hardcode localhost)
    socket = io({ transports: ['websocket', 'polling'] });

    _bindSocketEvents();
    _showLobby();
  }

  // ─── LOBBY (créer / rejoindre) ─────────────────────────────────────────────

  function _showLobby() {
    UI.setWaiting(false);
    UI.clearActions();

    const lobby = document.getElementById('online-lobby');
    if (lobby) lobby.style.display = 'flex';

    // Bouton Créer
    const btnCreate = document.getElementById('btn-create-room');
    if (btnCreate) {
      btnCreate.onclick = () => {
        socket.emit('create_room');
        UI.notify('Création du salon…', 'info', 0);
      };
    }

    // Bouton Rejoindre
    const btnJoin = document.getElementById('btn-join-room');
    if (btnJoin) {
      btnJoin.onclick = () => {
        const input = document.getElementById('room-code-input');
        const code  = input ? input.value.trim().toUpperCase() : '';
        if (code.length < 4) {
          UI.notify('Entrez un code valide (4 lettres)', 'warning', 2000);
          return;
        }
        socket.emit('join_room', { code });
        UI.notify('Connexion au salon…', 'info', 0);
      };
    }
  }

  function _hideLobby() {
    const lobby = document.getElementById('online-lobby');
    if (lobby) lobby.style.display = 'none';
  }

  // ─── ÉVÉNEMENTS SOCKET ─────────────────────────────────────────────────────

  function _bindSocketEvents() {

    // ── Salon créé ────────────────────────────────────────────────────────────
    socket.on('room_created', ({ code, seat }) => {
      roomCode = code;
      myIndex  = seat; // 0
      _hideLobby();

      // Afficher le code à partager
      const codeDisplay = document.getElementById('room-code-display');
      const codeVal     = document.getElementById('room-code-value');
      if (codeDisplay) codeDisplay.style.display = 'block';
      if (codeVal)     codeVal.textContent = code;

      UI.setWaiting(true, `En attente de l'adversaire… Code : ${code}`);
      UI.notify(`Votre salon : ${code} — partagez ce code !`, 'info', 0);
    });

    // ── Salon rejoint ─────────────────────────────────────────────────────────
    socket.on('room_joined', ({ code, seat }) => {
      roomCode = code;
      myIndex  = seat; // 1
      _hideLobby();
      UI.setWaiting(true, 'Connecté — la partie va commencer…');
    });

    // ── Erreur de salon ───────────────────────────────────────────────────────
    socket.on('room_error', ({ message }) => {
      UI.notify(message, 'warning', 3000);
    });

    // ── Début de main ─────────────────────────────────────────────────────────
    socket.on('hand_start', (data) => {
      UI.setWaiting(false);
      gameState = data.state;           // état public (sans les cartes adverses)
      gameState.players[myIndex].holeCards = data.holeCards; // mes cartes privées

      UI.renderTable(gameState, myIndex);
      UI.clearNotif();

      const lbl = myIndex === data.state.dealerIndex ? 'Vous êtes le bouton (petite blind)' : 'Adversaire est le bouton (petite blind)';
      UI.notify(`Main #${data.state.handNumber} — ${lbl}`, 'info', 2500);

      setTimeout(() => _refreshActions(), 600);
    });

    // ── Mise à jour de l'état (après chaque action) ───────────────────────────
    socket.on('game_update', (data) => {
      gameState = data.state;
      if (data.holeCards) {
        gameState.players[myIndex].holeCards = data.holeCards;
      }

      UI.renderTable(gameState, myIndex);

      // Afficher le message de l'action adverse
      if (data.lastAction && data.lastAction.player !== myIndex) {
        const labels = {
          fold:  "L'adversaire se couche",
          check: "L'adversaire checke",
          call:  "L'adversaire suit",
          bet:   `L'adversaire mise ${data.lastAction.amount}`,
          raise: `L'adversaire relance de ${data.lastAction.amount}`,
          allin: "L'adversaire va au TAPIS !"
        };
        UI.notify(labels[data.lastAction.action] || data.lastAction.action, 'info', 2500);
      }

      if (data.newPhase) {
        const labels = { flop: 'Flop', turn: 'Turn', river: 'River' };
        UI.notify(`--- ${labels[data.newPhase] || data.newPhase} ---`, 'info', 1500);
      }

      setTimeout(() => _refreshActions(), 400);
    });

    // ── Showdown ──────────────────────────────────────────────────────────────
    socket.on('showdown', (data) => {
      gameState = data.state;
      // Injecter les cartes révélées des deux joueurs
      data.players.forEach(p => {
        gameState.players[p.index].holeCards = p.holeCards;
      });

      UI.renderTable(gameState, myIndex);
      UI.clearActions();

      data.players.forEach(p => {
        const who = p.index === myIndex ? 'Vous' : 'Adversaire';
        UI.notify(`${who} : ${p.bestHand.name}`, 'info', 0);
      });

      setTimeout(() => {
        if (data.tie) {
          UI.notify('Égalité ! Le pot est partagé.', 'info', 4000);
        } else if (data.winner === myIndex) {
          UI.notify(`Vous remportez ${data.amount} jetons ! 🎉`, 'win', 4000);
        } else {
          UI.notify(`L'adversaire remporte ${data.amount} jetons.`, 'lose', 4000);
        }
      }, 1200);
    });

    // ── Fin de partie ─────────────────────────────────────────────────────────
    socket.on('game_over', (data) => {
      gameState = data.state;
      const iWon = data.winner === myIndex;
      if (iWon) _addToWallet(5000);
      UI.updateWallet(_getWallet());

      setTimeout(() => {
        UI.showGameOver(iWon, _getWallet());
      }, 3000);
    });

    // ── Déconnexion de l'adversaire ───────────────────────────────────────────
    socket.on('opponent_disconnected', () => {
      UI.notify("L'adversaire s'est déconnecté.", 'warning', 0);
      UI.clearActions();
      UI.setWaiting(true, 'Adversaire déconnecté — en attente de reconnexion (60 s)…');
    });

    // ── Reconnexion de l'adversaire ───────────────────────────────────────────
    socket.on('opponent_reconnected', () => {
      UI.setWaiting(false);
      UI.notify("L'adversaire est de retour !", 'win', 2500);
      _refreshActions();
    });

    // ── Abandon (timeout dépassé) ─────────────────────────────────────────────
    socket.on('opponent_abandoned', () => {
      _addToWallet(5000);
      UI.updateWallet(_getWallet());
      UI.notify("L'adversaire a abandonné. +5 000 pièces !", 'win', 0);
      UI.clearActions();
    });

    // ── Erreur serveur ────────────────────────────────────────────────────────
    socket.on('error_msg', ({ message }) => {
      UI.notify(message, 'warning', 3000);
    });
  }

  // ─── ACTIONS DU JOUEUR ─────────────────────────────────────────────────────

  function _refreshActions() {
    if (!gameState) return;
    if (!['preflop','flop','turn','river'].includes(gameState.phase)) {
      UI.clearActions();
      return;
    }

    if (gameState.currentPlayer === myIndex) {
      // Recalculer les actions légales localement pour l'affichage
      const legal = PokerEngine.getLegalActions(gameState);
      UI.renderActions(legal, _handleAction);
    } else {
      UI.clearActions();
    }
  }

  function _handleAction({ action, amount }) {
    if (!socket) return;
    UI.clearActions();
    socket.emit('game_action', { action, amount });
  }

  // ─── PORTEFEUILLE ──────────────────────────────────────────────────────────

  function _getWallet()    { return parseInt(localStorage.getItem('pokerWallet') || '0'); }
  function _addToWallet(n) { localStorage.setItem('pokerWallet', _getWallet() + n); }

  // ─── API PUBLIQUE ──────────────────────────────────────────────────────────
  return { init };
})();
