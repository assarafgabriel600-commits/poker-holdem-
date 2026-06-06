/**
 * online-game.js
 * Mode en ligne : Socket.IO côté client.
 * Le serveur est autoritatif : il distribue les cartes et valide les actions.
 */

const OnlineGame = (() => {
  'use strict';

  let socket    = null;
  let myIndex   = -1;
  let roomCode  = '';
  let gameState = null;

  // ─── INITIALISATION ────────────────────────────────────────────────────────

  function init() {
    // Se connecter au même serveur qui a servi la page (aucun chemin en dur)
    socket = io({ transports: ['websocket', 'polling'] });
    _bindSocketEvents();
    _showLobby();
  }

  // ─── LOBBY ─────────────────────────────────────────────────────────────────

  function _showLobby() {
    UI.setWaiting(false);
    UI.clearActions();
    const lobby = document.getElementById('online-lobby');
    if (lobby) lobby.style.display = 'flex';

    const btnCreate = document.getElementById('btn-create-room');
    if (btnCreate) btnCreate.onclick = () => {
      socket.emit('create_room');
      UI.notify('Création du salon…', 'info', 0);
    };

    const btnJoin = document.getElementById('btn-join-room');
    if (btnJoin) btnJoin.onclick = () => {
      const code = (document.getElementById('room-code-input')?.value || '').trim().toUpperCase();
      if (code.length < 4) { UI.notify('Code invalide (4 lettres min)', 'warning', 2500); return; }
      socket.emit('join_room', { code });
      UI.notify('Connexion au salon…', 'info', 0);
    };

    const input = document.getElementById('room-code-input');
    if (input) input.addEventListener('keydown', e => {
      if (e.key === 'Enter') document.getElementById('btn-join-room')?.click();
    });
  }

  function _hideLobby() {
    const lobby = document.getElementById('online-lobby');
    if (lobby) lobby.style.display = 'none';
  }

  // ─── ÉVÉNEMENTS SOCKET ─────────────────────────────────────────────────────

  function _bindSocketEvents() {

    // ── Salon créé ────────────────────────────────────────────────────────────
    socket.on('room_created', ({ code, seat }) => {
      roomCode = code; myIndex = seat;
      _hideLobby();
      const d = document.getElementById('room-code-display');
      const v = document.getElementById('room-code-value');
      if (d) d.style.display = 'block';
      if (v) v.textContent = code;
      UI.setWaiting(true, `En attente de l'adversaire… Code : ${code}`);
      UI.notify(`Salon créé : ${code} — partagez ce code !`, 'info', 0);
    });

    // ── Salon rejoint ─────────────────────────────────────────────────────────
    socket.on('room_joined', ({ code, seat }) => {
      roomCode = code; myIndex = seat;
      _hideLobby();
      UI.setWaiting(true, 'Connecté — la partie va commencer…');
    });

    // ── Erreur salon ──────────────────────────────────────────────────────────
    socket.on('room_error', ({ message }) => UI.notify(message, 'warning', 3500));

    // ── Début de main ─────────────────────────────────────────────────────────
    socket.on('hand_start', ({ state, holeCards }) => {
      UI.setWaiting(false);
      gameState = state;
      gameState.players[myIndex].holeCards = holeCards;
      UI.renderTable(gameState, myIndex);
      UI.clearNotif();
      const lbl = myIndex === state.dealerIndex
        ? 'Vous êtes le bouton (petite blind)'
        : 'Adversaire est le bouton';
      UI.notify(`Main #${state.handNumber} — ${lbl}`, 'info', 2500);
      setTimeout(_refreshActions, 600);
    });

    // ── Mise à jour après action ───────────────────────────────────────────────
    socket.on('game_update', ({ state, holeCards, lastAction, newPhase }) => {
      gameState = state;
      if (holeCards) gameState.players[myIndex].holeCards = holeCards;
      UI.renderTable(gameState, myIndex);

      if (lastAction && lastAction.player !== myIndex) {
        const msgs = {
          fold:  "L'adversaire se couche",
          check: "L'adversaire checke",
          call:  "L'adversaire suit",
          bet:   `L'adversaire mise ${lastAction.amount}`,
          raise: `L'adversaire relance ${lastAction.amount}`,
          allin: "L'adversaire va au TAPIS !"
        };
        UI.notify(msgs[lastAction.action] || lastAction.action, 'info', 2500);
      }

      if (newPhase) {
        const labels = { flop: '🃏 Flop', turn: '🃏 Turn', river: '🃏 River' };
        UI.notify(labels[newPhase] || newPhase, 'info', 1500);
      }

      setTimeout(_refreshActions, 400);
    });

    // ── Showdown ──────────────────────────────────────────────────────────────
    socket.on('showdown', ({ state, players, winner, tie, amount }) => {
      gameState = state;
      // Injecter les cartes révélées
      players.forEach(p => {
        gameState.players[p.index].holeCards = p.holeCards;
      });
      // Forcer phase='showdown' pour révéler les cartes adverses dans l'UI
      UI.renderTable(Object.assign({}, gameState, { phase: 'showdown' }), myIndex);
      UI.clearActions();

      // Afficher les deux mains
      const me  = players.find(p => p.index === myIndex);
      const opp = players.find(p => p.index !== myIndex);
      if (me)  UI.notify(`Votre main : ${me.bestHand.name}`,       'info', 0);
      setTimeout(() => {
        if (opp) UI.notify(`Main adverse : ${opp.bestHand.name}`, 'info', 0);
      }, 900);

      setTimeout(() => {
        if (tie)              UI.notify('Égalité ! Pot partagé.',        'info', 4000);
        else if (winner === myIndex) UI.notify(`🏆 Vous gagnez ${amount} jetons !`, 'win',  4000);
        else                  UI.notify(`Adversaire gagne ${amount} jetons.`,  'lose', 4000);
      }, 1400);
    });

    // ── Fin de partie ─────────────────────────────────────────────────────────
    socket.on('game_over', ({ state: s, winner }) => {
      gameState = s;
      const iWon = winner === myIndex;
      if (iWon) _addToWallet(5000);
      UI.updateWallet(_getWallet());
      setTimeout(() => UI.showGameOver(iWon, _getWallet()), 3000);
    });

    // ── Déconnexion adversaire ────────────────────────────────────────────────
    socket.on('opponent_disconnected', () => {
      UI.notify("L'adversaire s'est déconnecté…", 'warning', 0);
      UI.clearActions();
      UI.setWaiting(true, 'Adversaire déconnecté — reconnexion possible 60 s');
    });

    socket.on('opponent_reconnected', () => {
      UI.setWaiting(false);
      UI.notify("L'adversaire est de retour !", 'win', 2500);
      _refreshActions();
    });

    socket.on('opponent_abandoned', () => {
      _addToWallet(5000);
      UI.updateWallet(_getWallet());
      UI.notify("L'adversaire a abandonné. +5 000 pièces !", 'win', 0);
      UI.clearActions();
    });

    socket.on('error_msg', ({ message }) => UI.notify(message, 'warning', 3000));
  }

  // ─── ACTIONS DU JOUEUR ─────────────────────────────────────────────────────

  function _refreshActions() {
    if (!gameState) return;
    if (!['preflop','flop','turn','river'].includes(gameState.phase)) {
      UI.clearActions(); return;
    }
    if (gameState.currentPlayer === myIndex) {
      UI.renderActions(PokerEngine.getLegalActions(gameState), _handleAction);
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
