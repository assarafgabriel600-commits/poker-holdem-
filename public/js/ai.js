/**
 * ai.js — IA Virtuose du Poker (Texas Hold'em Heads-Up)
 *
 * Stratégies implémentées :
 *  - Évaluation précise préflop (Chen formula adaptée + position)
 *  - Détection des tirages : flush draw, OESD, gutshot, backdoor, combo draw
 *  - Analyse de la texture du board (wet/dry, monotone, pairé, coordiné)
 *  - Continuation bet (c-bet) adaptatif
 *  - Check-raise avec les mains fortes et les semi-bluffs
 *  - Mise polarisée : grosses mises value/bluff, petites mises médium
 *  - Overbet (>pot) avec les monstres ou en bluff sur rivière
 *  - Slowplay avec les sets et les nuts (10 %)
 *  - 3-bet préflop agressif + bluffs 3-bet avec connecteurs assortis
 *  - Probe bet au turn après check du flop
 *  - Bluff de rivière avec les tirages ratés (blocker conscient)
 *  - Cotes du pot + cotes implicites
 *  - Variante aléatoire pour rester imprévisible
 */

(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./poker-engine.js'));
  } else {
    root.PokerAI = factory(root.PokerEngine);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (PokerEngine) {
  'use strict';

  // ═══════════════════════════════════════════════════════════════════════════
  //  ÉVALUATION PRÉFLOP
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Force préflop raffinée (0–1).
   * Tient compte : paire, hauteur, assorti, connectivité, position.
   */
  function preflopStrength(holeCards, isButton) {
    const [c1, c2]  = holeCards;
    const hi        = Math.max(c1.num, c2.num);
    const lo        = Math.min(c1.num, c2.num);
    const suited    = c1.suit === c2.suit;
    const paired    = hi === lo;
    const gap       = hi - lo;

    let equity;

    // ── Paires ────────────────────────────────────────────────────────────────
    if (paired) {
      const tier = [22,33,44,55,66,77,88,99,10,11,12,13,14].indexOf(hi);
      equity = 0.46 + (hi / 14) * 0.50;                   // 52 % (22) → 96 % (AA)
    } else {
      // ── Score de base : (hi + lo - 4) / 24 ──────────────────────────────────
      equity = Math.min(0.82, (hi + lo - 4) / 24 * 0.75);

      // Bonus as
      if (hi === 14) equity += 0.08;

      // Bonus roi
      if (hi === 13 && lo >= 10) equity += 0.04;

      // Bonus assorti
      if (suited) equity += gap <= 2 ? 0.06 : 0.04;

      // Bonus connexion (OESD possible)
      if (!suited) {
        if (gap === 1)       equity += 0.03;
        else if (gap === 2)  equity += 0.015;
      }
    }

    // Bonus position : le bouton peut jouer plus large
    if (isButton) equity = Math.min(0.97, equity + 0.035);

    return Math.min(0.97, Math.max(0.12, equity));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DÉTECTION DES TIRAGES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Detecte les tirages dans la main de l'IA.
   * Retourne { flushDraw, oesd, gutshot, backdoorFlush, backdoorStraight,
   *            comboDraws, outs }
   */
  function detectDraws(holeCards, community) {
    const all   = [...holeCards, ...community];
    const nums  = all.map(c => c.num);
    const suits = all.map(c => c.suit);

    // ── Tirage couleur ────────────────────────────────────────────────────────
    const suitCount = {};
    for (const s of suits) suitCount[s] = (suitCount[s] || 0) + 1;
    const maxSuit        = Math.max(...Object.values(suitCount));
    const flushDraw      = maxSuit === 4;
    const backdoorFlush  = maxSuit === 3 && community.length < 4;

    // ── Tirages de quinte ─────────────────────────────────────────────────────
    const uniq = [...new Set(nums.map(n => n === 14 ? [14, 1] : [n]).flat())].sort((a,b)=>a-b);
    let oesd   = false;
    let gutshot = false;
    let backdoorStraight = false;

    // Fenêtre glissante de 5 valeurs
    for (let low = 1; low <= 10; low++) {
      const window = [low, low+1, low+2, low+3, low+4];
      const hits   = window.filter(n => uniq.includes(n)).length;
      const gaps   = window.filter(n => !uniq.includes(n));

      if (hits === 4) {
        const missingPos = gaps[0] - low; // 0=bas, 4=haut
        if (missingPos === 0 || missingPos === 4) oesd    = true;
        else                                      gutshot = true;
      } else if (hits === 3 && community.length < 4) {
        backdoorStraight = true;
      }
    }

    // ── Outs totaux ───────────────────────────────────────────────────────────
    let outs = 0;
    if (flushDraw)  outs += 9;
    if (oesd)       outs += 8;
    if (gutshot)    outs += 4;
    const comboDraws = flushDraw && (oesd || gutshot);
    if (comboDraws) outs = Math.min(outs, 15); // ne pas doubler-compter

    return { flushDraw, oesd, gutshot, backdoorFlush, backdoorStraight, comboDraws, outs };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ANALYSE DE LA TEXTURE DU BOARD
  // ═══════════════════════════════════════════════════════════════════════════

  function boardTexture(community) {
    if (!community.length) return { wet: false, dry: true, paired: false, monotone: false, coordinated: false };

    const nums  = community.map(c => c.num).sort((a,b)=>a-b);
    const suits = community.map(c => c.suit);

    // Pairé
    const cnt = {};
    for (const n of nums) cnt[n] = (cnt[n]||0)+1;
    const paired = Object.values(cnt).some(v => v >= 2);

    // Monotone (3+ cartes de même couleur)
    const sc = {};
    for (const s of suits) sc[s] = (sc[s]||0)+1;
    const monotone = Object.values(sc).some(v => v >= 3);
    const twoFlush = Object.values(sc).some(v => v >= 2);

    // Coordiné (cards consécutives ou proches)
    const uniq = [...new Set(nums)].sort((a,b)=>a-b);
    let maxConsec = 1, cur = 1;
    for (let i = 1; i < uniq.length; i++) {
      if (uniq[i] - uniq[i-1] <= 2) { cur++; maxConsec = Math.max(maxConsec, cur); }
      else cur = 1;
    }
    const coordinated = maxConsec >= (community.length >= 3 ? 2 : 2);
    const highCards   = nums.filter(n => n >= 10).length;

    const wet = (monotone || twoFlush) && (coordinated || highCards >= 2);
    const dry = !monotone && !coordinated && !twoFlush;

    return { wet, dry, paired, monotone, twoFlush, coordinated, highCards };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  FORCE POSTFLOP COMPLÈTE
  // ═══════════════════════════════════════════════════════════════════════════

  function postflopEval(holeCards, community) {
    const { score } = PokerEngine.bestHand([...holeCards, ...community]);
    const rank      = score[0]; // 0-8

    // Force brute de la main faite
    const madeStrength = [0.10, 0.34, 0.54, 0.67, 0.77, 0.83, 0.90, 0.95, 0.99][rank];
    const nutBonus     = ((score[1] || 0) / 14) * 0.04;
    const made         = Math.min(0.99, madeStrength + nutBonus);

    // Tirages
    const draws = community.length < 5 ? detectDraws(holeCards, community) : { outs: 0, comboDraws: false, flushDraw: false, oesd: false, gutshot: false };

    // Équité de tirage (règle des outs × 2 par carte restante)
    const cardsRemaining = 5 - community.length;
    const drawEq = Math.min(0.55, draws.outs * cardsRemaining * 0.022);

    // Équité globale = meilleure combinaison made + draw
    const equity = rank >= 2
      ? made                                          // main faite correcte → ignorer les draws
      : Math.max(made, made * 0.5 + drawEq);         // main faible → valoriser les draws

    return { equity, made, rank, draws, score };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UTILITAIRE DE MISE
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calcule un montant de mise en chips additionnels.
   * @param {string} sizing  '1/3'|'1/2'|'2/3'|'pot'|'3/2pot'|'2pot'|'min'
   */
  function betSize(pot, stack, legalAction, sizing) {
    if (!legalAction) return 0;
    const min = legalAction.min || 0;
    const max = legalAction.max || stack;

    const targets = {
      '1/3':   Math.round(pot * 0.33),
      '1/2':   Math.round(pot * 0.50),
      '2/3':   Math.round(pot * 0.67),
      '3/4':   Math.round(pot * 0.75),
      'pot':   pot,
      '3/2pot':Math.round(pot * 1.50),
      '2pot':  Math.round(pot * 2.0),
    };

    const target = targets[sizing] || targets['2/3'];
    return Math.max(min, Math.min(max, target));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DÉCISION PRÉFLOP
  // ═══════════════════════════════════════════════════════════════════════════

  function _decidePre(state, aiIdx, strength, isButton, rand) {
    const legal  = PokerEngine.getLegalActions(state);
    const has    = (a) => legal.some(x => x.action === a);
    const get    = (a) => legal.find(x => x.action === a);
    const pot    = state.pot || 1;
    const toCall = state.toCall - state.players[aiIdx].currentBet;
    const stack  = state.players[aiIdx].stack;
    const holeCards = state.players[aiIdx].holeCards;
    const hi = Math.max(...holeCards.map(c=>c.num));
    const lo = Math.min(...holeCards.map(c=>c.num));
    const suited = holeCards[0].suit === holeCards[1].suit;

    // ── Mains premium → always 3-bet / raise ──────────────────────────────────
    if (strength >= 0.85) {
      if (has('raise')) {
        const ra  = get('raise');
        // Varier la taille pour cacher la force
        const sz  = rand < 0.3 ? '3/4' : 'pot';
        return { action: 'raise', amount: betSize(pot, stack, ra, sz) };
      }
      if (has('bet')) {
        const ba = get('bet');
        return { action: 'bet', amount: betSize(pot, stack, ba, rand < 0.3 ? '3/4' : 'pot') };
      }
      if (has('call')) return { action: 'call' };
      return { action: 'check' };
    }

    // ── Mains fortes → raise fréquent ─────────────────────────────────────────
    if (strength >= 0.68) {
      if (has('raise') && rand < 0.78) {
        const ra = get('raise');
        return { action: 'raise', amount: betSize(pot, stack, ra, '2/3') };
      }
      if (has('bet') && rand < 0.78) {
        const ba = get('bet');
        return { action: 'bet', amount: betSize(pot, stack, ba, '2/3') };
      }
      if (has('call')) return { action: 'call' };
      if (has('check')) return { action: 'check' };
      return { action: 'fold' };
    }

    // ── Mains moyennes → mixe call/raise/fold ─────────────────────────────────
    if (strength >= 0.50) {
      const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
      if (potOdds < strength * 0.85) {
        // Parfois relancer avec des mains moyennes pour voler les blinds
        if (has('raise') && rand < 0.35) {
          const ra = get('raise');
          return { action: 'raise', amount: betSize(pot, stack, ra, '1/2') };
        }
        if (has('bet') && rand < 0.35) {
          const ba = get('bet');
          return { action: 'bet', amount: betSize(pot, stack, ba, '1/2') };
        }
        if (has('call')) return { action: 'call' };
        if (has('check')) return { action: 'check' };
      }
      if (has('check')) return { action: 'check' };
      return { action: 'fold' };
    }

    // ── Mains faibles mais jouables (connecteurs assortis en position) ─────────
    if (strength >= 0.38 && isButton) {
      const potOdds = toCall > 0 ? toCall / (pot + toCall) : 0;
      if (has('check')) return { action: 'check' };
      // Steal : relancer en bouton pour voler les blinds (30 %)
      if (has('raise') && rand < 0.30 && toCall === 0) {
        const ra = get('raise');
        return { action: 'raise', amount: betSize(pot, stack, ra, '1/2') };
      }
      if (has('call') && potOdds < 0.28) return { action: 'call' };
      return { action: 'fold' };
    }

    // ── Bluff 3-bet (bluff de relance) : connecteurs assortis ─────────────────
    if (suited && Math.abs(hi - lo) <= 2 && rand < 0.18 && has('raise')) {
      const ra = get('raise');
      return { action: 'raise', amount: betSize(pot, stack, ra, '2/3') };
    }

    // ── Mains indéfendables ───────────────────────────────────────────────────
    if (has('check')) return { action: 'check' };
    return { action: 'fold' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  DÉCISION POSTFLOP
  // ═══════════════════════════════════════════════════════════════════════════

  function _decidePost(state, aiIdx, evalResult, isIP, street, rand) {
    const legal   = PokerEngine.getLegalActions(state);
    const has     = (a) => legal.some(x => x.action === a);
    const get     = (a) => legal.find(x => x.action === a);

    const { equity, made, rank, draws } = evalResult;
    const community  = state.community;
    const pot        = state.pot || 1;
    const toCall     = state.toCall - state.players[aiIdx].currentBet;
    const stack      = state.players[aiIdx].stack;
    const potOdds    = toCall > 0 ? toCall / (pot + toCall) : 0;
    const spr        = stack / pot;                          // stack-to-pot ratio
    const board      = boardTexture(community);

    // ── Helpers de mise ───────────────────────────────────────────────────────
    const makeBet = (sz) => {
      const ba = get('bet');
      return ba ? { action: 'bet',   amount: betSize(pot, stack, ba, sz) } : null;
    };
    const makeRaise = (sz) => {
      const ra = get('raise');
      return ra ? { action: 'raise', amount: betSize(pot, stack, ra, sz) } : null;
    };

    // ════════════════════════════════════════════════════════════════════════
    //  MAIN MONSTRE (full, carré, quinte flush) → rank ≥ 6
    // ════════════════════════════════════════════════════════════════════════
    if (rank >= 6) {
      // Slowplay 15 % : check pour induire une mise adverse
      if (rand < 0.15 && has('check')) return { action: 'check' };

      // Overbet pour extraire le maximum
      if (has('raise')) return makeRaise(rand < 0.4 ? '3/2pot' : 'pot');
      if (has('bet'))   return makeBet(rand < 0.4 ? '3/2pot' : 'pot');
      if (has('call'))  return { action: 'call' };
      return { action: 'check' };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  COULEUR / QUINTE / BRELAN FORT → rank 3-5
    // ════════════════════════════════════════════════════════════════════════
    if (rank >= 3) {
      // Parfois check-raise sur le flop/turn (30 %)
      if (rand < 0.30 && has('check') && street !== 'river') {
        return { action: 'check' }; // tendance au check-raise au prochain tour
      }
      if (has('raise')) return makeRaise(rand < 0.45 ? '2/3' : 'pot');
      if (has('bet'))   return makeBet(rand < 0.45 ? '2/3' : 'pot');
      if (has('call'))  return { action: 'call' };
      return { action: 'check' };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  DOUBLE PAIRE → rank 2
    // ════════════════════════════════════════════════════════════════════════
    if (rank === 2) {
      if (has('raise')) return makeRaise('2/3');
      if (has('bet'))   return makeBet('2/3');
      if (has('call'))  return { action: 'call' };
      return { action: 'check' };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  PAIRE → rank 1
    // ════════════════════════════════════════════════════════════════════════
    if (rank === 1) {
      const pairVal    = evalResult.score[1]; // valeur de la paire
      const isTopPair  = pairVal >= community.map(c=>c.num).sort((a,b)=>b-a)[0];
      const isOverpair = community.every(c => c.num < pairVal);
      const kicker     = evalResult.score[2] || 0;
      const goodKicker = kicker >= 11; // J ou plus

      // Overpair → valeur bet forte
      if (isOverpair) {
        if (has('raise')) return makeRaise(rand < 0.5 ? '2/3' : 'pot');
        if (has('bet'))   return makeBet(rand < 0.5 ? '2/3' : 'pot');
        if (has('call'))  return { action: 'call' };
        return { action: 'check' };
      }

      // Top pair bon kicker
      if (isTopPair && goodKicker) {
        if (has('raise')) return makeRaise('2/3');
        if (has('bet'))   return makeBet(rand < 0.5 ? '1/2' : '2/3');
        if (has('call') && potOdds < 0.38) return { action: 'call' };
        if (has('check'))  return { action: 'check' };
        return { action: 'fold' };
      }

      // Top pair kicker moyen
      if (isTopPair) {
        if (has('bet') && rand < 0.55) return makeBet('1/2');
        if (has('call') && potOdds < 0.30) return { action: 'call' };
        if (has('check')) return { action: 'check' };
        return { action: 'fold' };
      }

      // Paire médiane ou basse — défense et pot control
      if (has('check'))               return { action: 'check' };
      if (has('call') && potOdds < 0.22) return { action: 'call' };
      return { action: 'fold' };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  CARTE HAUTE (rank 0) — tirages et bluffs
    // ════════════════════════════════════════════════════════════════════════

    // ── COMBO DRAW (flush + quinte) → very strong semi-bluff ──────────────────
    if (draws.comboDraws) {
      if (has('raise')) return makeRaise(rand < 0.55 ? '2/3' : 'pot');
      if (has('bet'))   return makeBet(rand < 0.55 ? '2/3' : 'pot');
      if (has('call') && potOdds < 0.45) return { action: 'call' };
      if (has('check')) return { action: 'check' };
      return { action: 'fold' };
    }

    // ── FLUSH DRAW ─────────────────────────────────────────────────────────────
    if (draws.flushDraw) {
      if (street === 'river') {
        // Tirage raté sur river → bluff avec la bonne fréquence
        if (rand < 0.42 && has('bet')) return makeBet(rand < 0.5 ? '2/3' : '3/2pot');
        if (rand < 0.42 && has('raise')) return makeRaise('2/3');
        if (has('check')) return { action: 'check' };
        return { action: 'fold' };
      }
      // Semi-bluff fréquent au flop/turn
      if (rand < 0.65) {
        if (has('raise')) return makeRaise(rand < 0.4 ? '1/2' : '2/3');
        if (has('bet'))   return makeBet(rand < 0.4 ? '1/2' : '2/3');
      }
      if (has('call') && potOdds < 0.35) return { action: 'call' };
      if (has('check')) return { action: 'check' };
      return potOdds < 0.22 ? { action: 'call' } : { action: 'fold' };
    }

    // ── OESD (quinte bilatérale) ───────────────────────────────────────────────
    if (draws.oesd) {
      if (street === 'river') {
        // Tirage raté → bluff 38 %
        if (rand < 0.38 && has('bet')) return makeBet('2/3');
        if (has('check')) return { action: 'check' };
        return { action: 'fold' };
      }
      if (rand < 0.55) {
        if (has('raise')) return makeRaise('1/2');
        if (has('bet'))   return makeBet('1/2');
      }
      if (has('call') && potOdds < 0.33) return { action: 'call' };
      if (has('check')) return { action: 'check' };
      return { action: 'fold' };
    }

    // ── GUTSHOT ────────────────────────────────────────────────────────────────
    if (draws.gutshot) {
      if (street === 'river') {
        if (rand < 0.28 && has('bet')) return makeBet('1/2');
        if (has('check')) return { action: 'check' };
        return { action: 'fold' };
      }
      if (rand < 0.35) {
        if (has('bet')) return makeBet('1/3');
      }
      if (has('call') && potOdds < 0.22) return { action: 'call' };
      if (has('check')) return { action: 'check' };
      return { action: 'fold' };
    }

    // ── BACKDOOR DRAWS : sondes et mises de position ───────────────────────────
    if ((draws.backdoorFlush || draws.backdoorStraight) && street === 'flop') {
      // Probe bet petite sur board sec en position
      if (isIP && board.dry && rand < 0.50) {
        if (has('bet')) return makeBet('1/3');
      }
      if (has('check')) return { action: 'check' };
      if (has('call') && potOdds < 0.18) return { action: 'call' };
      return { action: 'fold' };
    }

    // ════════════════════════════════════════════════════════════════════════
    //  AIR PUR — bluff ou abandon
    // ════════════════════════════════════════════════════════════════════════

    // Continuation bet (c-bet) sur board sec en position
    const isCbet = street === 'flop' && isIP && board.dry && rand < 0.60;
    if (isCbet && has('bet')) return makeBet('1/2');

    // Probe bet au turn après vérification (20 %)
    const isProbe = street === 'turn' && isIP && rand < 0.22;
    if (isProbe && has('bet')) return makeBet('1/2');

    // Bluff de river sur board pairé (range avantage) (20 %)
    if (street === 'river' && board.paired && rand < 0.20 && has('bet')) {
      return makeBet(rand < 0.5 ? '2/3' : '3/2pot');
    }

    // Bluff de river sur board coordonné (bluff de tirage raté) (15 %)
    if (street === 'river' && rand < 0.15 && has('bet')) {
      return makeBet('2/3');
    }

    // Défaut : checker ou se coucher
    if (has('check')) return { action: 'check' };
    if (has('call') && potOdds < 0.15) return { action: 'call' };
    return { action: 'fold' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  POINT D'ENTRÉE PRINCIPAL
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Choisit l'action de l'IA.
   * @param  {Object} state      État du jeu
   * @param  {number} aiIdx      Index du joueur IA (0 ou 1)
   * @returns {{ action, amount? }}
   */
  function decide(state, aiIdx) {
    const legal = PokerEngine.getLegalActions(state);
    if (!legal.length) return null;

    const me         = state.players[aiIdx];
    const community  = state.community;
    const isButton   = state.dealerIndex === aiIdx; // bouton = dernier à parler post-flop
    // En heads-up, "isIP" (en position) = être le bouton post-flop
    const isIP       = isButton;
    const rand       = Math.random();

    const street = community.length === 0 ? 'preflop'
                 : community.length === 3 ? 'flop'
                 : community.length === 4 ? 'turn'
                 :                          'river';

    // ── Préflop ───────────────────────────────────────────────────────────────
    if (street === 'preflop') {
      const strength = preflopStrength(me.holeCards, isButton);
      return _decidePre(state, aiIdx, strength, isButton, rand);
    }

    // ── Postflop ──────────────────────────────────────────────────────────────
    const evalResult = postflopEval(me.holeCards, community);
    return _decidePost(state, aiIdx, evalResult, isIP, street, rand);
  }

  // ─── API PUBLIQUE ──────────────────────────────────────────────────────────
  return { decide, preflopStrength, postflopEval, detectDraws, boardTexture };
});
