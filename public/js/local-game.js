/**
 * local-game.js
 * Orchestre le mode local : moteur de jeu + IA + interface.
 * Tout tourne côté client, aucune connexion réseau.
 */

const LocalGame = (() => {
  'use strict';

  // ─── CONFIGURATION ─────────────────────────────────────────────────────────
  const CONFIG = {
    smallBlind:    1,
    bigBlind:      2,
    startingStack: 100,
    AI_DELAY_MS:   1200,  // délai avant que l'IA joue (ms)
    PHASE_DELAY_MS: 800,  // délai entre les phases
  };

  const PLAYER_INDEX = 0; // L'humain est toujours le joueur 0
  const AI_INDEX     = 1;

  let state    = null;   // état courant du jeu
  let busy     = false;  // verrou pour éviter les double-clics

  // ─── DÉMARRAGE ─────────────────────────────────────────────────────────────

  function init() {
    state = PokerEngine.createGame(CONFIG);
    UI.updateWallet(getWallet());
    UI.hideGameOver();
    UI.setWaiting(false);
    startNewHand();
  }

  function startNewHand() {
    if (state.gameOver) return;
    busy  = false;
    state = PokerEngine.startHand(state);

    UI.renderTable(state, PLAYER_INDEX);
    UI.clearNotif();

    // Notifier les blinds
    const evBlinds = state.events.filter(e => e.type === 'blind');
    evBlinds.forEach(b => {
      const who = b.player === PLAYER_INDEX ? 'Vous' : 'L\'IA';
      const lbl = b.blind === 'small' ? 'petite blind' : 'grosse blind';
      UI.notify(`${who} poste la ${lbl} : ${b.amount} jeton(s)`, 'info', 2000);
    });

    // Si des cartes communes ont été distribuées immédiatement (double all-in)
    processEvents(state.events);

    setTimeout(promptOrAI, 600);
  }

  // ─── BOUCLE PRINCIPALE ─────────────────────────────────────────────────────

  /** Affiche les boutons si c'est au joueur, sinon fait jouer l'IA */
  function promptOrAI() {
    if (busy) return;
    if (!['preflop','flop','turn','river'].includes(state.phase)) return;

    UI.renderTable(state, PLAYER_INDEX);

    if (state.currentPlayer === PLAYER_INDEX) {
      // Tour du joueur humain
      const legal = PokerEngine.getLegalActions(state);
      UI.renderActions(legal, handlePlayerAction);
    } else {
      // Tour de l'IA
      UI.clearActions();
      setTimeout(runAI, CONFIG.AI_DELAY_MS);
    }
  }

  // ─── ACTION DU JOUEUR ──────────────────────────────────────────────────────

  function handlePlayerAction({ action, amount }) {
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
    processEvents(state.events);
    afterAction();
  }

  // ─── ACTION DE L'IA ────────────────────────────────────────────────────────

  function runAI() {
    if (busy) return;
    busy = true;

    const decision = PokerAI.decide(state, AI_INDEX);
    if (!decision) { busy = false; return; }

    // Afficher ce que fait l'IA
    const labels = {
      fold:  "L'IA se couche",
      check: "L'IA checke",
      call:  `L'IA suit`,
      bet:   `L'IA mise`,
      raise: `L'IA relance`,
      allin: "L'IA va au TAPIS !"
    };
    let msg = labels[decision.action] || decision.action;
    if (decision.amount) msg += ` (${decision.amount})`;
    UI.notify(msg, 'info', 2500);

    try {
      state = PokerEngine.performAction(state, decision.action, decision.amount);
    } catch (e) {
      console.error('Erreur IA :', e);
      busy = false;
      return;
    }

    UI.renderTable(state, PLAYER_INDEX);
    processEvents(state.events);
    afterAction();
  }

  // ─── APRÈS CHAQUE ACTION ───────────────────────────────────────────────────

  function afterAction() {
    const phase = state.phase;

    if (phase === 'showdown' || phase === 'game_over') {
      handleEndOfHand();
      return;
    }

    // Changement de phase → afficher les nouvelles cartes communes
    const phaseEv = state.events.find(e => e.type === 'phase');
    if (phaseEv) {
      const labels = { flop: 'Flop', turn: 'Turn', river: 'River' };
      UI.notify(`--- ${labels[phaseEv.phase] || phaseEv.phase} ---`, 'info', 1500);
      setTimeout(() => {
        UI.renderTable(state, PLAYER_INDEX);
        busy = false;
        promptOrAI();
      }, CONFIG.PHASE_DELAY_MS);
    } else {
      busy = false;
      promptOrAI();
    }
  }

  // ─── FIN DE MAIN ───────────────────────────────────────────────────────────

  function handleEndOfHand() {
    UI.clearActions();
    UI.renderTable(state, PLAYER_INDEX); // révèle les cartes si showdown

    // Construire le message de résultat
    const potEv     = state.events.find(e => e.type === 'pot_awarded');
    const showdownEv = state.events.find(e => e.type === 'showdown');

    if (showdownEv) {
      // Abattage : afficher les mains
      showdownEv.players.forEach(p => {
        const who  = p.index === PLAYER_INDEX ? 'Vous' : "L'IA";
        UI.notify(`${who} : ${p.bestHand.name}`, 'info', 0);
      });
    }

    setTimeout(() => {
      if (potEv) {
        if (potEv.tie) {
          UI.notify('Égalité ! Le pot est partagé.', 'info', 3000);
        } else if (potEv.player === PLAYER_INDEX) {
          UI.notify(`Vous remportez ${potEv.amount} jetons ! 🎉`, 'win', 3000);
        } else {
          UI.notify(`L'IA remporte ${potEv.amount} jetons.`, 'lose', 3000);
        }
      }

      // Fin de partie ?
      const goEv = state.events.find(e => e.type === 'game_over');
      if (goEv) {
        const iWon = goEv.winner === PLAYER_INDEX;
        if (iWon) addToWallet(5000);
        setTimeout(() => {
          UI.showGameOver(iWon, getWallet());
          UI.updateWallet(getWallet());
        }, 2500);
      } else {
        // Prochaine main automatiquement
        setTimeout(startNewHand, 3000);
      }
      busy = false;
    }, 800);
  }

  // ─── TRAITEMENT DES ÉVÉNEMENTS ─────────────────────────────────────────────

  /** Traite les événements produits par le moteur (pour les messages) */
  function processEvents(events) {
    for (const ev of events) {
      if (ev.type === 'phase') {
        UI.renderTable(state, PLAYER_INDEX);
      }
    }
  }

  // ─── PORTEFEUILLE (localStorage) ───────────────────────────────────────────

  function getWallet()      { return parseInt(localStorage.getItem('pokerWallet') || '0'); }
  function addToWallet(n)   { localStorage.setItem('pokerWallet', getWallet() + n); }

  // ─── API PUBLIQUE ──────────────────────────────────────────────────────────
  return { init };
})();
