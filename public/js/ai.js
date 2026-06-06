/**
 * ai.js
 * Intelligence artificielle pour le mode local — module UMD
 * Stratégie : force de main + cotes du pot + bluff occasionnel
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./poker-engine.js'));
  } else {
    root.PokerAI = factory(root.PokerEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PokerEngine) {
  'use strict';

  // ─── FORCE PRÉFLOP ─────────────────────────────────────────────────────────
  /**
   * Évalue la force des 2 cartes de départ (0 = nulle, 1 = maximale).
   * Basé sur une table simplifiée des mains heads-up.
   */
  function preflopStrength(holeCards) {
    const [c1, c2] = holeCards;
    const hi     = Math.max(c1.num, c2.num);
    const lo     = Math.min(c1.num, c2.num);
    const suited = c1.suit === c2.suit;
    const paired = c1.num  === c2.num;
    const gap    = hi - lo;

    if (paired) {
      if (hi >= 14) return 0.95; // AA
      if (hi >= 13) return 0.91; // KK
      if (hi >= 12) return 0.86; // QQ
      if (hi >= 11) return 0.82; // JJ
      if (hi >= 10) return 0.76; // TT
      if (hi >=  8) return 0.66; // 88-99
      if (hi >=  6) return 0.56; // 66-77
      return 0.46;               // 22-55
    }

    // Mains non pairées
    if (hi === 14) {
      if (lo === 13) return suited ? 0.82 : 0.76; // AK
      if (lo === 12) return suited ? 0.74 : 0.67; // AQ
      if (lo === 11) return suited ? 0.69 : 0.61; // AJ
      if (lo >= 9)   return suited ? 0.63 : 0.54; // AT, A9
      if (lo >= 7)   return suited ? 0.56 : 0.45; // A7-A8
      return                suited ? 0.49 : 0.37; // A2-A6
    }
    if (hi === 13) {
      if (lo === 12) return suited ? 0.66 : 0.59; // KQ
      if (lo === 11) return suited ? 0.61 : 0.53; // KJ
      if (lo === 10) return suited ? 0.56 : 0.48; // KT
      return                suited ? 0.45 : 0.36; // K2-K9
    }
    if (hi === 12 && lo >= 10) return suited ? 0.59 : 0.51; // QJ, QT
    if (hi === 11 && lo === 10) return suited ? 0.56 : 0.48; // JT

    // Connecteurs assortis
    if (suited && gap === 1) return 0.43;
    if (suited && gap === 2) return 0.37;
    if (suited && gap === 3) return 0.33;

    // Reste — main faible
    return Math.max(0.15, 0.38 - gap * 0.04 - (suited ? -0.04 : 0));
  }

  // ─── FORCE POSTFLOP ────────────────────────────────────────────────────────
  /**
   * Évalue la force de la main après distribution de cartes communes (0–1).
   */
  function postflopStrength(holeCards, community) {
    const { score } = PokerEngine.bestHand([...holeCards, ...community]);
    const rank = score[0]; // 0-8

    // Force de base par rang
    const base = [0.10, 0.32, 0.52, 0.66, 0.76, 0.83, 0.89, 0.95, 0.99][rank];

    // Léger bonus selon la valeur du kicker principal (0–0.04)
    const bonus = ((score[1] || 0) / 14) * 0.04;

    return Math.min(0.99, base + bonus);
  }

  // ─── DÉCISION ──────────────────────────────────────────────────────────────
  /**
   * Choisit l'action de l'IA.
   * @param {Object} state          État du jeu (lecture seule)
   * @param {number} aiPlayerIndex  Index du joueur IA (0 ou 1)
   * @returns {{ action, amount? }}
   */
  function decide(state, aiPlayerIndex) {
    const legal = PokerEngine.getLegalActions(state);
    if (!legal.length) return null;

    const community  = state.community;
    const holeCards  = state.players[aiPlayerIndex].holeCards;
    const pot        = state.pot || 1;
    const toCall     = state.toCall - state.players[aiPlayerIndex].currentBet;
    const stack      = state.players[aiPlayerIndex].stack;

    // ── Force de la main ──────────────────────────────────────────────────────
    const strength = community.length === 0
      ? preflopStrength(holeCards)
      : postflopStrength(holeCards, community);

    // ── Cotes du pot (pot odds) ───────────────────────────────────────────────
    // Proportion minimale de victoires nécessaire pour justifier un call
    const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;

    // ── Aléatoire pour la variante et le bluff ────────────────────────────────
    const rand        = Math.random();
    const bluffChance = 0.10; // 10 % de bluff

    // ── Index des actions disponibles ─────────────────────────────────────────
    const has = (a) => legal.some(x => x.action === a);
    const get = (a) => legal.find(x => x.action === a);

    // ─────────────────────────────────────────────────────────────────────────
    // MAIN FORTE (> 0.78) → jouer de manière agressive
    // ─────────────────────────────────────────────────────────────────────────
    if (strength > 0.78) {
      if (has('raise')) {
        const ra  = get('raise');
        // Mise de 2/3 du pot, mais au moins le minimum
        const amt = Math.max(ra.min, Math.min(Math.round(pot * 0.75), ra.max));
        return { action: 'raise', amount: amt };
      }
      if (has('bet')) {
        const ba  = get('bet');
        const amt = Math.max(ba.min, Math.min(Math.round(pot * 0.67), ba.max));
        return { action: 'bet', amount: amt };
      }
      if (has('call'))  return { action: 'call' };
      return { action: 'check' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MAIN MOYENNE (0.45 – 0.78) → appel ou mise modérée
    // ─────────────────────────────────────────────────────────────────────────
    if (strength > 0.45) {
      // Parfois initier une mise avec une main correcte (value bet)
      if (has('check') && rand < 0.38 && has('bet')) {
        const ba  = get('bet');
        const amt = Math.max(ba.min, Math.min(Math.round(pot * 0.45), ba.max));
        return { action: 'bet', amount: amt };
      }
      if (has('check')) return { action: 'check' };

      // Suivre si la main vaut le prix
      if (has('call') && strength > potOdds) return { action: 'call' };
      return { action: 'fold' };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // MAIN FAIBLE (< 0.45) → coucher ou bluffer
    // ─────────────────────────────────────────────────────────────────────────
    if (rand < bluffChance) {
      // Bluff : mise de continuation ou relance surprise
      if (has('bet')) {
        const ba  = get('bet');
        const amt = Math.max(ba.min, Math.min(Math.round(pot * 0.65), ba.max));
        return { action: 'bet', amount: amt };
      }
      if (has('raise')) {
        const ra = get('raise');
        return { action: 'raise', amount: ra.min };
      }
    }

    if (has('check')) return { action: 'check' };

    // Suivre si les cotes le justifient (tirage possible)
    if (has('call') && strength > potOdds * 0.75) return { action: 'call' };

    return { action: 'fold' };
  }

  // ─── API PUBLIQUE ──────────────────────────────────────────────────────────
  return { decide, preflopStrength, postflopStrength };
});
