/**
 * local-game.js
 * Orchestre le mode local : moteur de jeu + IA + interface.
 * Tout tourne côté client, aucune connexion réseau.
 */

const LocalGame = (() => {
  'use strict';

  // ─── CONFIGURATION ─────────────────────────────────────────────────────────
  const CONFIG = {
    smallBlind:     1,
    bigBlind:       2,
    startingStack:  100,
    AI_DELAY_MS:    1000,   // délai avant que l'IA joue
    PHASE_DELAY_MS: 700,    // délai entre les phases
    NEXT_HAND_MS:   3200,   // délai avant la prochaine main
  };

  const PLAYER_INDEX = 0;
  const AI_INDEX     = 1;

  let state = null;
  let busy  = false;

  // ─── DÉMARRAGE ─────────────────────────────────────────────────────────────

  function init() {
    state = PokerEngine.createGame(CONFIG);
    busy  = false;
    UI.updateWallet(_getWallet());
    UI.hideGameOver();
    UI.setWaiting(false);
    UI.clearNotif();
    startNewHand();
  }

  function startNewHand() {
    if (state.gameOver) return;
    busy  = false;
    state = PokerEngine.startHand(state);

    UI.renderTable(state, PLAYER_INDEX);
    UI.clearActions();
    UI.clearNotif();

    // Notifier les blinds
    for (const ev of state.events.filter(e => e.type === 'blind')) {
      const who = ev.player === PLAYER_INDEX ? 'Vous' : 'L\'IA';
      const lbl = ev.blind === 'small' ? 'petite blind' : 'grosse blind';
      UI.notify(`${who} poste la ${lbl} : ${ev.amount} 🪙`, 'info', 2000);
    }

    setTimeout(promptOrAI, 500);
  }

  // ─── BOUCLE PRINCIPALE ─────────────────────────────────────────────────────

  function promptOrAI() {
    if (busy) return;
    if (!['preflop','flop','turn','river'].includes(state.phase)) return;

    UI.renderTable(state, PLAYER_INDEX);

    if (state.currentPlayer === PLAYER_INDEX) {
      UI.renderActions(PokerEngine.getLegalActions(state), onPlayerAction);
    } else {
      UI.clearActions();
      setTimeout(runAI, CONFIG.AI_DELAY_MS);
    }
  }

  // ─── ACTION DU JOUEUR ──────────────────────────────────────────────────────

  function onPlayerAction({ action, amount }) {
    if (busy) return;
    busy = true;
    UI.clearActions();

    try {
      state = PokerEngine.performAction(state, action, amount);
    } catch (e) {
      console.error('Action invalide :', e);
      busy = false;
      promptOrAI();
      return;
    }

    UI.renderTable(state, PLAYER_INDEX);
    _afterAction();
  }

  // ─── ACTION DE L'IA ────────────────────────────────────────────────────────

  function runAI() {
    if (busy) return;
    busy = true;

    const decision = PokerAI.decide(state, AI_INDEX);
    if (!decision) { busy = false; return; }

    // Construire le message affiché
    const msgs = {
      fold:  "L'IA se couche",
      check: "L'IA checke",
      call:  `L'IA suit (${state.toCall - state.players[AI_INDEX].currentBet})`,
      bet:   `L'IA mise (${decision.amount})`,
      raise: `L'IA relance (${decision.amount})`,
      allin: "L'IA va au TAPIS !"
    };
    UI.notify(msgs[decision.action] || decision.action, 'info', 2000);

    try {
      state = PokerEngine.performAction(state, decision.action, decision.amount);
    } catch (e) {
      console.error('Erreur IA :', e);
      busy = false;
      return;
    }

    UI.renderTable(state, PLAYER_INDEX);
    _afterAction();
  }

  // ─── TRAITEMENT APRÈS CHAQUE ACTION ───────────────────────────────────────

  function _afterAction() {
    // ── Fin de main : pot attribué (fold, showdown, égalité) ─────────────────
    const potEv = state.events.find(e => e.type === 'pot_awarded');
    if (potEv) {
      _handleEndOfHand(potEv);
      return;
    }

    // ── Nouvelle phase (flop / turn / river) ──────────────────────────────────
    const phaseEv = state.events.find(e => e.type === 'phase');
    if (phaseEv) {
      const labels = { flop: '🃏 Flop', turn: '🃏 Turn', river: '🃏 River' };
      UI.notify(labels[phaseEv.phase] || phaseEv.phase, 'info', 1500);
      setTimeout(() => {
        UI.renderTable(state, PLAYER_INDEX);
        busy = false;
        promptOrAI();
      }, CONFIG.PHASE_DELAY_MS);
      return;
    }

    // ── Simple action (pas de changement de phase) ────────────────────────────
    busy = false;
    promptOrAI();
  }

  // ─── FIN DE MAIN ───────────────────────────────────────────────────────────

  function _handleEndOfHand(potEv) {
    UI.clearActions();

    // Révéler les cartes de l'adversaire si c'était un showdown
    const showdownEv = state.events.find(e => e.type === 'showdown');
    if (showdownEv) {
      // Forcer phase='showdown' pour que renderTable révèle les cartes adverses
      UI.renderTable(Object.assign({}, state, { phase: 'showdown' }), PLAYER_INDEX);

      // Afficher les deux mains
      const p0 = showdownEv.players.find(p => p.index === PLAYER_INDEX);
      const p1 = showdownEv.players.find(p => p.index === AI_INDEX);
      if (p0) UI.notify(`Votre main : ${p0.bestHand.name}`, 'info', 0);
      setTimeout(() => {
        if (p1) UI.notify(`Main IA : ${p1.bestHand.name}`, 'info', 0);
      }, 900);
    }

    // Afficher le résultat après un court délai
    setTimeout(() => {
      if (potEv.tie) {
        UI.notify('Égalité ! Le pot est partagé.', 'info', 4000);
      } else if (potEv.player === PLAYER_INDEX) {
        UI.notify(`🏆 Vous remportez ${potEv.amount} jetons !`, 'win', 4000);
      } else {
        UI.notify(`L'IA remporte ${potEv.amount} jetons.`, 'lose', 4000);
      }

      // Fin de partie ?
      const goEv = state.events.find(e => e.type === 'game_over');
      if (goEv) {
        const iWon = goEv.winner === PLAYER_INDEX;
        if (iWon) _addToWallet(5000);
        setTimeout(() => {
          UI.showGameOver(iWon, _getWallet());
          UI.updateWallet(_getWallet());
        }, 2500);
      } else {
        setTimeout(startNewHand, CONFIG.NEXT_HAND_MS);
      }

      busy = false;
    }, showdownEv ? 1400 : 500);
  }

  // ─── PORTEFEUILLE ──────────────────────────────────────────────────────────

  function _getWallet()    { return parseInt(localStorage.getItem('pokerWallet') || '0'); }
  function _addToWallet(n) { localStorage.setItem('pokerWallet', _getWallet() + n); }

  // ─── API PUBLIQUE ──────────────────────────────────────────────────────────
  return { init };
})();
