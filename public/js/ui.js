/**
 * ui.js
 * Toutes les manipulations DOM : cartes, table, actions, notifications,
 * animations de jetons, annonces de phase, explosions de victoire.
 */

const UI = (() => {
  'use strict';

  // ─── État interne pour détecter les changements de mise ────────────────────
  let _lastBets       = [0, 0];
  let _lastHandNumber = 0;

  // ═══════════════════════════════════════════════════════════════════════════
  //  JETONS (CHIPS)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Décompose un montant en jetons de couleurs.
   * Retourne un tableau [{denom, colorClass}] (max 7 jetons affichés).
   */
  function _chipsFor(amount) {
    const denoms = [500, 100, 25, 10, 5, 1];
    const cls    = { 500:'chip-500', 100:'chip-100', 25:'chip-25', 10:'chip-10', 5:'chip-5', 1:'chip-1' };
    const result = [];
    let rem = amount;
    for (const d of denoms) {
      const n = Math.min(Math.floor(rem / d), 3);
      for (let i = 0; i < n; i++) result.push({ denom: d, colorClass: cls[d] });
      rem -= n * d;
      if (result.length >= 7) break;
    }
    return result;
  }

  /**
   * Crée un élément .chips-stack rempli de jetons colorés.
   */
  function _makeChipStack(amount, sizeClass = 'chip-sm') {
    const wrap = document.createElement('div');
    wrap.classList.add('chips-stack');
    for (const { colorClass } of _chipsFor(amount)) {
      const c = document.createElement('span');
      c.classList.add('chip', sizeClass, colorClass);
      wrap.appendChild(c);
    }
    return wrap;
  }

  /**
   * Anime des jetons volant d'une zone vers le pot.
   * @param {string} fromId  ID de l'élément source ('my-zone' ou 'opp-zone')
   */
  function _flyChipsToPot(fromId) {
    const fromEl = document.getElementById(fromId);
    const toEl   = document.getElementById('pot-amount');
    if (!fromEl || !toEl) return;

    const fromRect = fromEl.getBoundingClientRect();
    const toRect   = toEl.getBoundingClientRect();

    const chipColors = ['chip-5','chip-10','chip-25','chip-100'];
    const count = 4 + Math.floor(Math.random() * 3);

    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const chip = document.createElement('div');
        chip.classList.add('chip', 'chip-flying', chipColors[i % chipColors.length]);

        // Position de départ (centre de la zone joueur + léger aléatoire)
        const sx = fromRect.left + fromRect.width  * 0.5 - 10 + (Math.random() - 0.5) * 30;
        const sy = fromRect.top  + fromRect.height * 0.5 - 10 + (Math.random() - 0.5) * 20;
        chip.style.left = sx + 'px';
        chip.style.top  = sy + 'px';

        // Destination (centre du pot)
        const tx = toRect.left + toRect.width  * 0.5 - sx - 10;
        const ty = toRect.top  + toRect.height * 0.5 - sy - 10;
        chip.style.setProperty('--tx', tx + 'px');
        chip.style.setProperty('--ty', ty + 'px');

        document.body.appendChild(chip);
        setTimeout(() => chip.remove(), 700);
      }, i * 65);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  CARTES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Crée un élément DOM représentant une carte.
   * @param {Object|null} card      { suit, value, red }
   * @param {boolean}     faceDown  Forcer le dos de carte
   * @param {string}      animClass Classe CSS d'animation ('deal-top'|'deal-bottom'|'flip-in'|'')
   * @param {number}      delay     Délai d'animation en ms
   */
  function makeCardEl(card, faceDown = false, animClass = '', delay = 0) {
    const el = document.createElement('div');
    el.classList.add('card');

    if (animClass) {
      el.classList.add(animClass);
      if (delay) el.style.animationDelay = delay + 'ms';
    }

    if (!card || faceDown) {
      el.classList.add('face-down');
      el.innerHTML = `<div class="card-back-pattern"></div>`;
      return el;
    }

    el.classList.add(card.red ? 'red' : 'black');
    el.innerHTML = `
      <span class="card-corner top-left">
        <span class="card-val">${card.value}</span>
        <span class="card-suit-sm">${card.suit}</span>
      </span>
      <span class="card-center-suit">${card.suit}</span>
      <span class="card-corner bot-right">
        <span class="card-val">${card.value}</span>
        <span class="card-suit-sm">${card.suit}</span>
      </span>`;
    return el;
  }

  /**
   * Vide un conteneur et y insère une rangée de cartes avec animation.
   * @param {HTMLElement} container
   * @param {Array}       cards       Tableau de cartes (ou null/vide pour placeholders)
   * @param {boolean}     faceDown
   * @param {boolean}     animate     Si true, joue l'animation de distribution
   * @param {boolean}     isOpp       true = cartes adversaire (animate depuis le haut)
   */
  function renderCards(container, cards, faceDown = false, animate = false, isOpp = false) {
    container.innerHTML = '';

    if (!cards || cards.length === 0) {
      const slots = parseInt(container.dataset.slots) || 2;
      for (let i = 0; i < slots; i++) {
        const ph = document.createElement('div');
        ph.classList.add('card', 'card-placeholder');
        container.appendChild(ph);
      }
      return;
    }

    const isCommunity = container.id === 'community-cards';
    cards.forEach((c, idx) => {
      let animClass = '';
      let delay     = 0;
      if (animate) {
        if (isCommunity)    { animClass = 'flip-in';      delay = idx * 90; }
        else if (isOpp)     { animClass = 'deal-top';     delay = idx * 120; }
        else                { animClass = 'deal-bottom';  delay = idx * 120; }
      }
      container.appendChild(makeCardEl(c, faceDown, animClass, delay));
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  RENDU DE LA TABLE
  // ═══════════════════════════════════════════════════════════════════════════

  function renderTable(state, myIndex) {
    const oppIndex = 1 - myIndex;
    const me       = state.players[myIndex];
    const opp      = state.players[oppIndex];

    // ── Détecter la nouvelle main pour réinitialiser les mises suivies ──────
    const isNewHand = state.handNumber !== _lastHandNumber;
    if (isNewHand) {
      _lastBets[0]     = 0;
      _lastBets[1]     = 0;
      _lastHandNumber  = state.handNumber;
    }

    // ── Jetons volants si une mise a augmenté ─────────────────────────────────
    if (!isNewHand) {
      if (me.currentBet  > _lastBets[myIndex])  _flyChipsToPot('my-zone');
      if (opp.currentBet > _lastBets[oppIndex]) _flyChipsToPot('opp-zone');
    }
    _lastBets[myIndex]  = me.currentBet;
    _lastBets[oppIndex] = opp.currentBet;

    // ── Cartes du joueur humain (bas) ─────────────────────────────────────────
    const myCards = document.getElementById('my-cards');
    if (myCards) {
      myCards.dataset.slots = 2;
      const prevCount = myCards.querySelectorAll('.card:not(.card-placeholder)').length;
      const doAnim    = isNewHand && me.holeCards && me.holeCards.length > 0;
      renderCards(myCards, me.holeCards, false, doAnim, false);
    }

    // ── Infos joueur humain ───────────────────────────────────────────────────
    _setText('my-stack',  me.stack    + ' 🪙');
    _setChipBet('my-bet', me.currentBet);
    _setText('my-status', me.folded ? 'Couché' : (me.allIn ? 'TAPIS !' : ''));

    const myZone = document.getElementById('my-zone');
    if (myZone) myZone.classList.toggle('is-allin', !!me.allIn);

    // ── Cartes adversaire (haut) ──────────────────────────────────────────────
    const oppCards = document.getElementById('opp-cards');
    if (oppCards) {
      oppCards.dataset.slots = 2;
      const reveal  = (state.phase === 'showdown' || state.phase === 'game_over');
      const doAnim  = isNewHand && !reveal;
      renderCards(oppCards, opp.holeCards.length ? opp.holeCards : null, !reveal, doAnim, true);
    }

    _setText('opp-stack',  opp.stack    + ' 🪙');
    _setChipBet('opp-bet', opp.currentBet);
    _setText('opp-status', opp.folded ? 'Couché' : (opp.allIn ? 'TAPIS !' : ''));

    const oppZone = document.getElementById('opp-zone');
    if (oppZone) oppZone.classList.toggle('is-allin', !!opp.allIn);

    // ── Cartes communes ───────────────────────────────────────────────────────
    const communityEl = document.getElementById('community-cards');
    if (communityEl) {
      communityEl.dataset.slots = 5;
      const prevLen = communityEl.querySelectorAll('.card:not(.card-placeholder)').length;
      const newLen  = state.community ? state.community.length : 0;
      const doAnim  = newLen > prevLen;
      renderCards(communityEl, state.community, false, doAnim, false);
    }

    // ── Pot + jetons visuels ──────────────────────────────────────────────────
    _renderPot(state.pot || 0);

    // ── Indicateur de tour ────────────────────────────────────────────────────
    const isMyTurn = state.currentPlayer === myIndex &&
                     ['preflop','flop','turn','river'].includes(state.phase);
    const turnEl = document.getElementById('turn-indicator');
    if (turnEl) {
      turnEl.textContent = _turnText(state, myIndex);
      turnEl.className   = 'turn-indicator' + (isMyTurn ? ' my-turn' : '');
    }

    // ── Numéro de main ────────────────────────────────────────────────────────
    _setText('hand-number', state.handNumber ? `Main #${state.handNumber}` : '');

    // ── Bouton dealer ─────────────────────────────────────────────────────────
    const dMe  = document.getElementById('dealer-me');
    const dOpp = document.getElementById('dealer-opp');
    if (dMe)  dMe.style.display  = state.dealerIndex === myIndex  ? '' : 'none';
    if (dOpp) dOpp.style.display = state.dealerIndex === oppIndex ? '' : 'none';
  }

  /** Affiche le pot avec jetons colorés + montant */
  function _renderPot(amount) {
    // Ligne de jetons au-dessus du montant
    const potArea = document.querySelector('.pot-area');
    if (!potArea) return;

    // Créer ou réutiliser le conteneur de jetons
    let chipsRow = document.getElementById('chips-pot-row');
    if (!chipsRow) {
      chipsRow = document.createElement('div');
      chipsRow.id = 'chips-pot-row';
      chipsRow.classList.add('pot-chips-row');
      potArea.insertBefore(chipsRow, potArea.firstChild);
    }
    chipsRow.innerHTML = '';

    if (amount > 0) {
      for (const { colorClass } of _chipsFor(amount)) {
        const c = document.createElement('span');
        c.classList.add('chip', 'chip-md', colorClass);
        chipsRow.appendChild(c);
      }
    }

    _setText('pot-amount', amount + ' 🪙');
  }

  /** Affiche la mise d'un joueur avec jetons colorés */
  function _setChipBet(elemId, amount) {
    const el = document.getElementById(elemId);
    if (!el) return;
    el.innerHTML = '';
    if (!amount || amount <= 0) return;

    const label = document.createTextNode(`Mise : ${amount} `);
    el.appendChild(label);

    const chips = _makeChipStack(amount, 'chip-sm');
    chips.style.display = 'inline-flex';
    el.appendChild(chips);
  }

  function _turnText(state, myIndex) {
    if (state.phase === 'idle')      return 'Prête pour la prochaine main…';
    if (state.phase === 'showdown')  return '🃏 Abattage !';
    if (state.phase === 'game_over') return 'Partie terminée';
    if (state.currentPlayer === myIndex) return '🟢 À vous de jouer !';
    return '⌛ Tour de l\'adversaire…';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  ANIMATIONS SPECTACULAIRES
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Grosse annonce de phase au centre de l'écran (FLOP / TURN / RIVER).
   */
  function announcePhase(phaseName) {
    const labels = { flop: 'FLOP', turn: 'TURN', river: 'RIVER' };
    const label  = labels[phaseName];
    if (!label) return;

    const el = document.createElement('div');
    el.classList.add('phase-announce');
    el.textContent = label;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 1500);
  }

  /**
   * Explosion dorée + confetti quand le joueur remporte un pot.
   */
  function triggerWinBurst() {
    // Halo radial
    const burst = document.createElement('div');
    burst.classList.add('win-burst');
    document.body.appendChild(burst);
    setTimeout(() => burst.remove(), 1000);

    // Confetti
    const colors = ['#f4d03f','#2ecc71','#e74c3c','#3498db','#9b59b6','#ffffff','#f39c12'];
    for (let i = 0; i < 40; i++) {
      setTimeout(() => {
        const p = document.createElement('div');
        p.classList.add('confetti-piece');
        const size = 7 + Math.random() * 9;
        const dur  = 1.2 + Math.random() * 0.8;
        p.style.cssText = `
          left:${15 + Math.random() * 70}%;
          top:${10 + Math.random() * 30}%;
          width:${size}px;
          height:${size}px;
          background:${colors[Math.floor(Math.random() * colors.length)]};
          border-radius:${Math.random() > 0.5 ? '50%' : '2px'};
          --dx:${(Math.random() - 0.5) * 220}px;
          --dy:${120 + Math.random() * 280}px;
          --rot:${Math.random() * 900}deg;
          --dur:${dur}s;
        `;
        document.body.appendChild(p);
        setTimeout(() => p.remove(), (dur + 0.2) * 1000);
      }, Math.random() * 600);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  BOUTONS D'ACTION
  // ═══════════════════════════════════════════════════════════════════════════

  function renderActions(actions, callback) {
    const container = document.getElementById('action-buttons');
    if (!container) return;
    container.innerHTML = '';
    if (!actions || actions.length === 0) return;

    actions.forEach(a => {
      switch (a.action) {
        case 'fold':
          container.appendChild(_btn('Se coucher', 'btn-fold', () => callback({ action: 'fold' })));
          break;
        case 'check':
          container.appendChild(_btn('Checker', 'btn-check', () => callback({ action: 'check' })));
          break;
        case 'call':
          container.appendChild(_btn(`Suivre (${a.amount})`, 'btn-call', () => callback({ action: 'call' })));
          break;
        case 'bet':
          container.appendChild(_buildBetPanel('bet', a, callback));
          break;
        case 'raise':
          container.appendChild(_buildBetPanel('raise', a, callback));
          break;
        case 'allin':
          container.appendChild(_btn(`⚡ TAPIS ! (${a.amount})`, 'btn-allin', () => callback({ action: 'allin' })));
          break;
      }
    });
  }

  function _buildBetPanel(type, a, callback) {
    const label = type === 'bet' ? 'Miser' : 'Relancer';
    const wrap  = document.createElement('div');
    wrap.classList.add('bet-panel');

    const slider = document.createElement('input');
    slider.type  = 'range';
    slider.min   = a.min;
    slider.max   = a.max;
    slider.value = a.min;
    slider.classList.add('bet-slider');

    const display = document.createElement('span');
    display.classList.add('bet-display');
    display.textContent = a.min;

    const btn = _btn(`${label} (${a.min})`, `btn-${type}`, () => {
      callback({ action: type, amount: parseInt(slider.value) });
    });

    slider.addEventListener('input', () => {
      display.textContent = slider.value;
      btn.textContent = `${label} (${slider.value})`;
    });

    wrap.appendChild(slider);
    wrap.appendChild(display);
    wrap.appendChild(btn);
    return wrap;
  }

  function _btn(text, cssClass, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    b.classList.add('action-btn', cssClass);
    b.addEventListener('click', onClick);
    return b;
  }

  function clearActions() {
    const c = document.getElementById('action-buttons');
    if (c) c.innerHTML = '';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  NOTIFICATIONS
  // ═══════════════════════════════════════════════════════════════════════════

  let _notifTimer = null;

  function notify(msg, type = 'info', duration = 3000) {
    const el = document.getElementById('notification');
    if (!el) return;
    el.textContent = msg;
    el.className   = `show ${type}`;
    el.id          = 'notification';    // garder l'id intact

    // Notification plus grosse pour les victoires de pot
    if (type === 'win' && msg.includes('🏆')) el.classList.add('win-big');

    if (_notifTimer) clearTimeout(_notifTimer);
    if (duration > 0) {
      _notifTimer = setTimeout(() => el.classList.remove('show'), duration);
    }
  }

  function clearNotif() {
    const el = document.getElementById('notification');
    if (el) el.classList.remove('show');
  }

  // ═══════════════════════════════════════════════════════════════════════════
  //  UTILITAIRES
  // ═══════════════════════════════════════════════════════════════════════════

  function _setText(id, txt) {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  function updateWallet(amount) {
    const el = document.getElementById('wallet-display');
    if (el) el.textContent = `Portefeuille : ${amount} 💰`;
  }

  function showGameOver(winnerIsMe, coins) {
    const panel = document.getElementById('game-over-panel');
    if (!panel) return;
    const title = panel.querySelector('#go-title');
    const sub   = panel.querySelector('#go-subtitle');
    if (title) title.textContent = winnerIsMe ? '🏆 Victoire !' : '💀 Défaite…';
    if (sub) sub.textContent = winnerIsMe
      ? `+5 000 pièces ajoutées à votre portefeuille ! (total : ${coins} 💰)`
      : 'Vous avez tout perdu. Retentez votre chance !';
    panel.style.display = 'flex';
    if (winnerIsMe) triggerWinBurst();
  }

  function hideGameOver() {
    const panel = document.getElementById('game-over-panel');
    if (panel) panel.style.display = 'none';
  }

  function setWaiting(visible, msg = 'En attente…') {
    const el = document.getElementById('waiting-overlay');
    if (!el) return;
    el.style.display = visible ? 'flex' : 'none';
    const txt = el.querySelector('#waiting-msg');
    if (txt) txt.textContent = msg;
  }

  // ─── API PUBLIQUE ──────────────────────────────────────────────────────────
  return {
    renderTable,
    renderCards,
    renderActions,
    clearActions,
    notify,
    clearNotif,
    updateWallet,
    showGameOver,
    hideGameOver,
    setWaiting,
    makeCardEl,
    announcePhase,
    triggerWinBurst
  };
})();
