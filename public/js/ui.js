/**
 * ui.js
 * Toutes les manipulations DOM : affichage des cartes, de la table,
 * des boutons d'action et des notifications.
 */

const UI = (() => {
  'use strict';

  // ─── RENDU D'UNE CARTE ─────────────────────────────────────────────────────

  /**
   * Crée un élément DOM représentant une carte.
   * @param {Object|null} card  { suit, value, red } ou null pour face cachée
   * @param {boolean} faceDown  Forcer le dos de carte
   */
  function makeCardEl(card, faceDown = false) {
    const el = document.createElement('div');
    el.classList.add('card');

    if (!card || faceDown) {
      el.classList.add('face-down');
      el.innerHTML = `<div class="card-back-pattern"></div>`;
      return el;
    }

    el.classList.add(card.red ? 'red' : 'black');
    // Valeur en haut à gauche + symbole au centre
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

  /** Vide un conteneur et y insère une rangée de cartes */
  function renderCards(container, cards, faceDown = false) {
    container.innerHTML = '';
    if (!cards || cards.length === 0) {
      // Afficher des espaces réservés vides
      for (let i = 0; i < (container.dataset.slots || 2); i++) {
        const ph = document.createElement('div');
        ph.classList.add('card', 'card-placeholder');
        container.appendChild(ph);
      }
      return;
    }
    cards.forEach(c => container.appendChild(makeCardEl(c, faceDown)));
  }

  // ─── RENDU DE LA TABLE ─────────────────────────────────────────────────────

  /**
   * Met à jour l'affichage complet de la table.
   * @param {Object} state   État du jeu
   * @param {number} myIndex Index du joueur humain (0 ou 1)
   */
  function renderTable(state, myIndex) {
    const oppIndex = 1 - myIndex;
    const me  = state.players[myIndex];
    const opp = state.players[oppIndex];

    // ── Joueur humain (bas) ───────────────────────────────────────────────────
    const myCards = document.getElementById('my-cards');
    if (myCards) {
      myCards.dataset.slots = 2;
      renderCards(myCards, me.holeCards, false);
    }
    _setText('my-stack',      me.stack    + ' 🪙');
    _setText('my-bet',        me.currentBet > 0 ? `Mise : ${me.currentBet}` : '');
    _setText('my-status',     me.folded ? 'Couché' : (me.allIn ? 'TAPIS !' : ''));

    // ── Adversaire (haut) ─────────────────────────────────────────────────────
    const oppCards = document.getElementById('opp-cards');
    if (oppCards) {
      oppCards.dataset.slots = 2;
      // Révéler les cartes seulement au showdown
      const reveal = (state.phase === 'showdown' || state.phase === 'game_over');
      renderCards(oppCards, opp.holeCards.length ? opp.holeCards : null, !reveal);
    }
    _setText('opp-stack', opp.stack + ' 🪙');
    _setText('opp-bet',   opp.currentBet > 0 ? `Mise : ${opp.currentBet}` : '');
    _setText('opp-status', opp.folded ? 'Couché' : (opp.allIn ? 'TAPIS !' : ''));

    // ── Cartes communes ───────────────────────────────────────────────────────
    const communityEl = document.getElementById('community-cards');
    if (communityEl) {
      communityEl.dataset.slots = 5;
      renderCards(communityEl, state.community);
    }

    // ── Pot ───────────────────────────────────────────────────────────────────
    _setText('pot-amount', state.pot + ' 🪙');

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
    const dealerMeEl  = document.getElementById('dealer-me');
    const dealerOppEl = document.getElementById('dealer-opp');
    if (dealerMeEl)  dealerMeEl.style.display  = state.dealerIndex === myIndex  ? '' : 'none';
    if (dealerOppEl) dealerOppEl.style.display  = state.dealerIndex === oppIndex ? '' : 'none';
  }

  function _turnText(state, myIndex) {
    if (state.phase === 'idle')      return 'Prêt pour la prochaine main…';
    if (state.phase === 'showdown')  return 'Abattage !';
    if (state.phase === 'game_over') return 'Partie terminée';
    if (state.currentPlayer === myIndex) return '🟢 À vous de jouer !';
    return '⌛ Tour de l\'adversaire…';
  }

  // ─── BOUTONS D'ACTION ──────────────────────────────────────────────────────

  /**
   * Affiche les boutons d'action légaux.
   * @param {Array}    actions   Résultat de getLegalActions()
   * @param {Function} callback  callback({ action, amount })
   */
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
          container.appendChild(_btn(`TAPIS ! (${a.amount})`, 'btn-allin', () => callback({ action: 'allin' })));
          break;
      }
    });
  }

  /** Panneau slider pour mise / relance */
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

    slider.addEventListener('input', () => {
      display.textContent = slider.value;
    });

    const btn = _btn(`${label} (${a.min})`, `btn-${type}`, () => {
      callback({ action: type, amount: parseInt(slider.value) });
    });

    // Mettre à jour le label du bouton quand le slider change
    slider.addEventListener('input', () => {
      btn.textContent = `${label} (${slider.value})`;
    });

    wrap.appendChild(slider);
    wrap.appendChild(display);
    wrap.appendChild(btn);
    return wrap;
  }

  /** Crée un bouton simple */
  function _btn(text, cssClass, onClick) {
    const b = document.createElement('button');
    b.textContent = text;
    b.classList.add('action-btn', cssClass);
    b.addEventListener('click', onClick);
    return b;
  }

  /** Cache les boutons d'action */
  function clearActions() {
    const c = document.getElementById('action-buttons');
    if (c) c.innerHTML = '';
  }

  // ─── NOTIFICATIONS ─────────────────────────────────────────────────────────

  let _notifTimer = null;

  /**
   * Affiche un message flottant centré sur la table.
   * @param {string}  msg       Texte à afficher
   * @param {string}  type      'info'|'win'|'lose'|'warning'
   * @param {number}  duration  Durée en ms (0 = permanent jusqu'à dismiss)
   */
  function notify(msg, type = 'info', duration = 3000) {
    const el = document.getElementById('notification');
    if (!el) return;
    el.textContent  = msg;
    el.className    = `notification show ${type}`;
    if (_notifTimer) clearTimeout(_notifTimer);
    if (duration > 0) {
      _notifTimer = setTimeout(() => {
        el.classList.remove('show');
      }, duration);
    }
  }

  /** Retire la notification */
  function clearNotif() {
    const el = document.getElementById('notification');
    if (el) el.classList.remove('show');
  }

  // ─── UTILITAIRES ───────────────────────────────────────────────────────────

  function _setText(id, txt) {
    const el = document.getElementById(id);
    if (el) el.textContent = txt;
  }

  /** Met à jour le solde du portefeuille affiché dans game.html */
  function updateWallet(amount) {
    const el = document.getElementById('wallet-display');
    if (el) el.textContent = `Portefeuille : ${amount} 💰`;
  }

  /** Affiche / cache le panneau de résultat de fin de partie */
  function showGameOver(winnerIsMe, coins) {
    const panel = document.getElementById('game-over-panel');
    if (!panel) return;
    const title  = panel.querySelector('#go-title');
    const sub    = panel.querySelector('#go-subtitle');
    if (title) title.textContent = winnerIsMe ? '🏆 Victoire !' : '💀 Défaite…';
    if (sub)   sub.textContent   = winnerIsMe
      ? `+5 000 pièces ajoutées à votre portefeuille ! (total : ${coins} 💰)`
      : 'Vous avez tout perdu. Retentez votre chance !';
    panel.style.display = 'flex';
  }

  function hideGameOver() {
    const panel = document.getElementById('game-over-panel');
    if (panel) panel.style.display = 'none';
  }

  /** Active/désactive l'overlay "en attente" */
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
    makeCardEl
  };
})();
