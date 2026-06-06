/**
 * poker-engine.js
 * Moteur Texas Hold'em heads-up — module UMD (Node.js + navigateur)
 * Gère : deck, évaluation des mains, machine d'état du jeu, blinds, enchères
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.PokerEngine = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ─── CONSTANTES ────────────────────────────────────────────────────────────
  const SUITS  = ['♠', '♥', '♦', '♣'];
  const VALUES = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
  const NUM    = { '2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,
                   '10':10,'J':11,'Q':12,'K':13,'A':14 };
  const HAND_NAMES = [
    'Carte haute', 'Paire', 'Double paire', 'Brelan',
    'Quinte', 'Couleur', 'Full', 'Carré', 'Quinte Flush'
  ];
  const IS_RED = { '♥': true, '♦': true, '♠': false, '♣': false };

  // ─── DECK ──────────────────────────────────────────────────────────────────

  /** Crée un jeu de 52 cartes non mélangé */
  function createDeck() {
    const deck = [];
    for (const suit of SUITS)
      for (const value of VALUES)
        deck.push({ suit, value, num: NUM[value], red: IS_RED[suit] });
    return deck;
  }

  /** Mélange un tableau (Fisher-Yates) et retourne une copie */
  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ─── ÉVALUATION DES MAINS ──────────────────────────────────────────────────

  /** Génère toutes les combinaisons de k éléments parmi arr */
  function combinations(arr, k) {
    if (k === 0) return [[]];
    if (arr.length < k) return [];
    const [h, ...t] = arr;
    return [
      ...combinations(t, k - 1).map(c => [h, ...c]),
      ...combinations(t, k)
    ];
  }

  /**
   * Évalue exactement 5 cartes.
   * Retourne un tableau de scores comparables : [rang, kicker1, kicker2, ...]
   * Plus le tableau est "grand" lexicographiquement, meilleure est la main.
   */
  function evaluate5(cards) {
    const nums  = cards.map(c => c.num).sort((a, b) => b - a);
    const suits = cards.map(c => c.suit);
    const isFlush = new Set(suits).size === 1;

    // Groupes par occurrences : [[valeur, count], ...]
    const cnt = {};
    for (const n of nums) cnt[n] = (cnt[n] || 0) + 1;
    const groups = Object.entries(cnt)
      .map(([v, c]) => [+v, c])
      .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
    const gc = groups.map(g => g[1]);

    // Vérification de la quinte
    let straight = false;
    if (new Set(nums).size === 5) {
      if (nums[0] - nums[4] === 4) {
        straight = nums[0]; // quinte normale
      } else if (nums[0] === 14 && nums[1] === 5 &&
                 nums[2] === 4  && nums[3] === 3 && nums[4] === 2) {
        straight = 5; // la "roue" A-2-3-4-5
      }
    }

    if (isFlush && straight)              return [8, straight];                          // Quinte Flush
    if (gc[0] === 4)                      return [7, groups[0][0], groups[1][0]];        // Carré
    if (gc[0] === 3 && gc[1] === 2)       return [6, groups[0][0], groups[1][0]];        // Full
    if (isFlush)                          return [5, ...nums];                           // Couleur
    if (straight)                         return [4, straight];                          // Quinte
    if (gc[0] === 3)                      return [3, groups[0][0], groups[1][0], groups[2][0]]; // Brelan
    if (gc[0] === 2 && gc[1] === 2) {                                                    // Double paire
      const p1 = Math.max(groups[0][0], groups[1][0]);
      const p2 = Math.min(groups[0][0], groups[1][0]);
      return [2, p1, p2, groups[2][0]];
    }
    if (gc[0] === 2)  return [1, groups[0][0], groups[1][0], groups[2][0], groups[3][0]]; // Paire
    return [0, ...nums];                                                                  // Carte haute
  }

  /** Compare deux tableaux de scores ; retourne 1, -1 ou 0 */
  function compareScores(a, b) {
    const len = Math.max(a.length, b.length);
    for (let i = 0; i < len; i++) {
      const d = (a[i] || 0) - (b[i] || 0);
      if (d !== 0) return d > 0 ? 1 : -1;
    }
    return 0;
  }

  /**
   * Trouve la meilleure main de 5 cartes parmi 5 à 7 cartes données.
   * Retourne { score, cards, name }
   */
  function bestHand(cards) {
    const combos = cards.length === 5 ? [cards] : combinations(cards, 5);
    let bestScore = null, bestCards = null;
    for (const combo of combos) {
      const score = evaluate5(combo);
      if (!bestScore || compareScores(score, bestScore) > 0) {
        bestScore = score;
        bestCards = combo;
      }
    }
    return { score: bestScore, cards: bestCards, name: HAND_NAMES[bestScore[0]] };
  }

  // ─── MACHINE D'ÉTAT DU JEU ────────────────────────────────────────────────

  /**
   * Crée l'état initial d'une partie.
   * @param {Object} config  { smallBlind, bigBlind, startingStack }
   */
  function createGame(config = {}) {
    const cfg = {
      smallBlind:    config.smallBlind    || 1,
      bigBlind:      config.bigBlind      || 2,
      startingStack: config.startingStack || 100
    };
    return {
      phase: 'idle',          // idle | preflop | flop | turn | river | showdown | game_over
      deck: [],
      community: [],          // cartes communes
      players: [
        _newPlayer(cfg.startingStack),
        _newPlayer(cfg.startingStack)
      ],
      pot:           0,
      dealerIndex:   0,       // bouton / petite blind
      currentPlayer: -1,
      lastToAct:     -1,      // dernier joueur à avoir l'option ce tour
      toCall:        0,       // mise maximale en cours (pour égaliser)
      minRaise:      cfg.bigBlind,
      config:        cfg,
      handNumber:    0,
      gameOver:      false,
      winner:        null,
      events:        []       // événements produits par la dernière action
    };
  }

  function _newPlayer(stack) {
    return { stack, holeCards: [], currentBet: 0, folded: false, allIn: false };
  }

  function _clone(o) { return JSON.parse(JSON.stringify(o)); }

  // ─── DÉBUT DE MAIN ─────────────────────────────────────────────────────────

  /**
   * Lance une nouvelle main sur l'état donné.
   * Distribue les cartes et poste les blinds.
   * Retourne le nouvel état avec les événements générés.
   */
  function startHand(state) {
    let s = _clone(state);
    s.events = [];
    if (s.gameOver) return s;

    s.handNumber++;
    s.deck      = shuffle(createDeck());
    s.community = [];
    s.pot       = 0;
    s.phase     = 'preflop';

    // Réinitialiser chaque joueur et distribuer 2 cartes
    for (const p of s.players) {
      p.holeCards  = [s.deck.shift(), s.deck.shift()];
      p.currentBet = 0;
      p.folded     = false;
      p.allIn      = false;
    }

    s.events.push({
      type: 'hand_start',
      handNumber: s.handNumber,
      holeCards:  [s.players[0].holeCards, s.players[1].holeCards]
    });

    // ── Blinds heads-up ──────────────────────────────────────────────────────
    // Règle spéciale heads-up : le bouton (dealer) = petite blind
    const sbIdx = s.dealerIndex;
    const bbIdx = 1 - sbIdx;

    const sbAmt = Math.min(s.config.smallBlind, s.players[sbIdx].stack);
    s.players[sbIdx].stack      -= sbAmt;
    s.players[sbIdx].currentBet  = sbAmt;
    s.pot += sbAmt;
    if (s.players[sbIdx].stack === 0) s.players[sbIdx].allIn = true;
    s.events.push({ type: 'blind', player: sbIdx, amount: sbAmt, blind: 'small' });

    const bbAmt = Math.min(s.config.bigBlind, s.players[bbIdx].stack);
    s.players[bbIdx].stack      -= bbAmt;
    s.players[bbIdx].currentBet  = bbAmt;
    s.pot += bbAmt;
    if (s.players[bbIdx].stack === 0) s.players[bbIdx].allIn = true;
    s.events.push({ type: 'blind', player: bbIdx, amount: bbAmt, blind: 'big' });

    // Préflop : SB (bouton) parle en premier, BB a l'option en dernier
    s.currentPlayer = sbIdx;
    s.lastToAct     = bbIdx;
    s.toCall        = bbAmt;
    s.minRaise      = bbAmt;

    // Si les deux joueurs sont all-in dès les blinds, on déroule le board
    if (s.players[0].allIn && s.players[1].allIn) {
      s = _runOutBoard(s);
    }

    return s;
  }

  // ─── ACTIONS LÉGALES ───────────────────────────────────────────────────────

  /**
   * Retourne la liste des actions légales pour le joueur courant.
   * Chaque action : { action, amount? (fixe), min?, max? (plage) }
   */
  function getLegalActions(state) {
    const s = state;
    if (!['preflop','flop','turn','river'].includes(s.phase)) return [];
    const p = s.players[s.currentPlayer];
    if (!p || p.folded || p.allIn) return [];

    const toCall = s.toCall - p.currentBet; // montant à ajouter pour suivre
    const actions = [];

    // Se coucher
    actions.push({ action: 'fold' });

    // Checker ou suivre
    if (toCall <= 0) {
      actions.push({ action: 'check' });
    } else {
      actions.push({ action: 'call', amount: Math.min(toCall, p.stack) });
    }

    // Mise ou relance (si le joueur a plus que le montant à suivre)
    if (p.stack > toCall) {
      if (toCall === 0) {
        // Aucune mise en cours → bet
        const minBet = Math.min(s.minRaise, p.stack);
        actions.push({ action: 'bet', min: minBet, max: p.stack });
      } else {
        // Il y a une mise → raise
        const minRaise = Math.min(s.minRaise + toCall, p.stack);
        actions.push({ action: 'raise', min: minRaise, max: p.stack });
      }
    }

    // All-in toujours disponible si on a des jetons
    if (p.stack > 0) {
      actions.push({ action: 'allin', amount: p.stack });
    }

    return actions;
  }

  // ─── EFFECTUER UNE ACTION ──────────────────────────────────────────────────

  /**
   * Applique une action au joueur courant.
   * @param  {Object} state   État actuel (non muté)
   * @param  {string} action  'fold'|'check'|'call'|'bet'|'raise'|'allin'
   * @param  {number} amount  Montant (chips additionnels) pour bet/raise
   * @returns {Object}        Nouvel état avec s.events remplis
   */
  function performAction(state, action, amount) {
    let s = _clone(state);
    s.events = [];
    const pIdx   = s.currentPlayer;
    const p      = s.players[pIdx];
    const oppIdx = 1 - pIdx;
    const toCall = s.toCall - p.currentBet;

    switch (action) {

      case 'fold':
        p.folded = true;
        s.events.push({ type: 'action', player: pIdx, action: 'fold' });
        return _awardPot(s, oppIdx, 'fold');

      case 'check':
        if (toCall > 0) throw new Error('Impossible de checker : une mise est en cours');
        s.events.push({ type: 'action', player: pIdx, action: 'check' });
        return _advanceTurn(s, pIdx, false);

      case 'call': {
        const amt = Math.min(toCall, p.stack);
        p.stack      -= amt;
        p.currentBet += amt;
        s.pot        += amt;
        if (p.stack === 0) p.allIn = true;
        s.events.push({ type: 'action', player: pIdx, action: 'call', amount: amt });
        return _advanceTurn(s, pIdx, false);
      }

      case 'bet': {
        // amount = chips à ajouter (currentBet repart de 0 chaque street)
        const amt = Math.max(s.minRaise, Math.min(amount || s.minRaise, p.stack));
        p.stack      -= amt;
        p.currentBet += amt;
        s.pot        += amt;
        s.toCall      = p.currentBet;
        s.minRaise    = amt;
        s.lastToAct   = oppIdx;
        if (p.stack === 0) p.allIn = true;
        s.events.push({ type: 'action', player: pIdx, action: 'bet', amount: amt });
        s.currentPlayer = oppIdx;
        if (s.players[oppIdx].allIn || s.players[oppIdx].folded)
          return _nextPhase(s);
        return s;
      }

      case 'raise': {
        // amount = chips additionnels à engager (call inclus)
        const extra = Math.min(amount || (s.minRaise + toCall), p.stack);
        p.stack      -= extra;
        p.currentBet += extra;
        s.pot        += extra;
        const raised = p.currentBet - s.toCall;
        if (raised > 0) s.minRaise = raised;
        s.toCall    = Math.max(s.toCall, p.currentBet);
        s.lastToAct = oppIdx;
        if (p.stack === 0) p.allIn = true;
        s.events.push({ type: 'action', player: pIdx, action: 'raise', amount: extra });
        s.currentPlayer = oppIdx;
        if (s.players[oppIdx].allIn || s.players[oppIdx].folded)
          return _nextPhase(s);
        return s;
      }

      case 'allin': {
        const amt  = p.stack;
        p.stack    = 0;
        p.currentBet += amt;
        s.pot     += amt;
        p.allIn    = true;
        const aggressive = p.currentBet > s.toCall;
        if (aggressive) {
          s.minRaise  = p.currentBet - s.toCall;
          s.toCall    = p.currentBet;
          s.lastToAct = oppIdx;
        }
        s.events.push({ type: 'action', player: pIdx, action: 'allin', amount: amt });
        return _advanceTurn(s, pIdx, aggressive);
      }

      default:
        throw new Error('Action inconnue : ' + action);
    }
  }

  // ─── FONCTIONS INTERNES ────────────────────────────────────────────────────

  /**
   * Avance le tour après une action passive (check/call) ou agressive (bet/raise/allin).
   * Règle principale :
   *   - Agressif  → l'adversaire doit répondre (il devient currentPlayer)
   *   - Passif    → fin du tour si justActed === lastToAct ET mises égales
   */
  function _advanceTurn(s, justActed, aggressive) {
    const oppIdx = 1 - justActed;

    if (aggressive) {
      if (s.players[oppIdx].allIn || s.players[oppIdx].folded)
        return _nextPhase(s);
      s.currentPlayer = oppIdx;
      return s;
    }

    // Action passive : vérifier si le tour d'enchères est terminé
    const betsEqual = s.players[0].currentBet === s.players[1].currentBet;
    const roundOver = (justActed === s.lastToAct) && betsEqual;

    if (roundOver) return _nextPhase(s);

    s.currentPlayer = oppIdx;
    if (s.players[oppIdx].allIn || s.players[oppIdx].folded)
      return _nextPhase(s);
    return s;
  }

  /** Passe à la phase suivante et distribue les cartes communes */
  function _nextPhase(s) {
    // Remettre les mises à zéro pour le nouveau tour
    s.players[0].currentBet = 0;
    s.players[1].currentBet = 0;
    s.toCall   = 0;
    s.minRaise = s.config.bigBlind;

    switch (s.phase) {
      case 'preflop':
        s.deck.shift(); // carte brûlée
        s.community = [s.deck.shift(), s.deck.shift(), s.deck.shift()];
        s.phase = 'flop';
        break;
      case 'flop':
        s.deck.shift();
        s.community.push(s.deck.shift());
        s.phase = 'turn';
        break;
      case 'turn':
        s.deck.shift();
        s.community.push(s.deck.shift());
        s.phase = 'river';
        break;
      case 'river':
        return _doShowdown(s);
      default:
        return s;
    }

    s.events.push({ type: 'phase', phase: s.phase, community: s.community });

    // Post-flop : le joueur hors bouton parle en premier (lastToAct = dealer)
    const first = 1 - s.dealerIndex;
    const last  = s.dealerIndex;
    s.lastToAct = last;

    if (!s.players[first].folded && !s.players[first].allIn) {
      s.currentPlayer = first;
    } else if (!s.players[last].folded && !s.players[last].allIn) {
      s.currentPlayer = last;
    } else {
      // Les deux sont all-in : continuer à distribuer les cartes
      return _nextPhase(s);
    }

    return s;
  }

  /** Distribue toutes les cartes communes restantes sans enchères (cas all-in) */
  function _runOutBoard(s) {
    while (s.community.length < 5) {
      s.deck.shift(); // brûler
      if (s.community.length === 0) {
        s.community = [s.deck.shift(), s.deck.shift(), s.deck.shift()];
        s.events.push({ type: 'phase', phase: 'flop', community: [...s.community] });
      } else {
        s.community.push(s.deck.shift());
        const ph = s.community.length === 4 ? 'turn' : 'river';
        s.events.push({ type: 'phase', phase: ph, community: [...s.community] });
      }
    }
    return _doShowdown(s);
  }

  /** Évalue les mains des deux joueurs et attribue le pot */
  function _doShowdown(s) {
    s.phase = 'showdown';

    const h0 = bestHand([...s.players[0].holeCards, ...s.community]);
    const h1 = bestHand([...s.players[1].holeCards, ...s.community]);
    const cmp = compareScores(h0.score, h1.score);
    const tie = cmp === 0;
    const winnerIdx = tie ? null : (cmp > 0 ? 0 : 1);

    s.events.push({
      type: 'showdown',
      players: [
        { index: 0, holeCards: s.players[0].holeCards, bestHand: h0 },
        { index: 1, holeCards: s.players[1].holeCards, bestHand: h1 }
      ],
      winner: winnerIdx,
      tie
    });

    if (tie) {
      const potVal = s.pot;
      const half   = Math.floor(potVal / 2);
      s.players[0].stack += half;
      s.players[1].stack += potVal - half;
      s.pot = 0;
      s.events.push({ type: 'pot_awarded', winner: null, tie: true, amount: potVal });
      return _checkGameOver(s);
    }

    return _awardPot(s, winnerIdx, 'showdown');
  }

  /** Attribue le pot au vainqueur */
  function _awardPot(s, winnerIdx, reason) {
    const amount = s.pot;
    s.players[winnerIdx].stack += amount;
    s.pot = 0;
    s.events.push({ type: 'pot_awarded', player: winnerIdx, amount, reason });
    return _checkGameOver(s);
  }

  /** Vérifie si la partie est terminée (un joueur à 0 jeton) */
  function _checkGameOver(s) {
    if (s.players[0].stack === 0 || s.players[1].stack === 0) {
      const gameWinner = s.players[0].stack > 0 ? 0 : 1;
      s.gameOver = true;
      s.winner   = gameWinner;
      s.phase    = 'game_over';
      s.events.push({ type: 'game_over', winner: gameWinner });
    } else {
      // Préparer la main suivante : rotation du bouton
      s.dealerIndex = 1 - s.dealerIndex;
      s.phase       = 'idle';
    }
    return s;
  }

  // ─── API PUBLIQUE ──────────────────────────────────────────────────────────
  return {
    // Construction
    createGame,
    startHand,
    // Jeu
    getLegalActions,
    performAction,
    // Utilitaires d'évaluation
    bestHand,
    compareScores,
    // Constantes
    HAND_NAMES,
    IS_RED,
    // Bas niveau (utile pour le serveur)
    createDeck,
    shuffle
  };
});
