/**
 * server.js
 * Serveur Express + Socket.IO — sert le frontend ET gère le mode en ligne.
 * Conçu pour Render (offre gratuite) : PORT via process.env.PORT.
 */

'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

// ── Moteur de poker (partagé avec le client via UMD) ──────────────────────────
const PokerEngine = require('./public/js/poker-engine.js');

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const GAME_CONFIG = { smallBlind: 1, bigBlind: 2, startingStack: 100 };
const RECONNECT_TIMEOUT_MS = 60_000; // 60 s pour se reconnecter

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Route de santé (AVANT le static middleware)
app.get('/health', (_req, res) => res.send('OK'));

// Servir le dossier public (HTML, CSS, JS client)
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
console.log(`[Static] Dossier servi : ${publicDir}`);

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors: { origin: '*' },              // tolérant en dev ; restreindre en prod si besoin
  pingTimeout:  60_000,
  pingInterval: 25_000
});

// ─── ÉTAT DES SALONS ──────────────────────────────────────────────────────────
/**
 * rooms : Map<code, Room>
 * Room = {
 *   code,
 *   sockets: [socketId|null, socketId|null],  // seat 0 et seat 1
 *   state: GameState,
 *   reconnectTimers: [timer|null, timer|null]
 * }
 */
const rooms = new Map();

// ─── GÉNÉRATION DU CODE ───────────────────────────────────────────────────────
function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sans I, O, 0, 1 (ambigus)
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

// ─── UTILITAIRES ──────────────────────────────────────────────────────────────

/** Retourne le seat (0 ou 1) d'un socket dans un salon, ou -1 si absent */
function getSeat(room, socketId) {
  return room.sockets.indexOf(socketId);
}

/** Construit la vue publique de l'état (sans les cartes privées de l'adversaire) */
function publicState(state, forSeat) {
  const s = JSON.parse(JSON.stringify(state));
  const oppSeat = 1 - forSeat;
  // Masquer les cartes du joueur adverse
  s.players[oppSeat].holeCards = [];
  return s;
}

/** Envoie l'état mis à jour aux deux joueurs avec leurs cartes privées */
function broadcastUpdate(room, lastAction, newPhase) {
  const { state, sockets } = room;
  for (let seat = 0; seat < 2; seat++) {
    const sid = sockets[seat];
    if (!sid) continue;
    io.to(sid).emit('game_update', {
      state:      publicState(state, seat),
      holeCards:  state.players[seat].holeCards,
      lastAction: lastAction || null,
      newPhase:   newPhase   || null
    });
  }
}

/** Lance une nouvelle main et notifie les deux joueurs */
function dealNewHand(room) {
  room.state = PokerEngine.startHand(room.state);
  const { state, sockets } = room;

  for (let seat = 0; seat < 2; seat++) {
    const sid = sockets[seat];
    if (!sid) continue;
    io.to(sid).emit('hand_start', {
      state:     publicState(state, seat),
      holeCards: state.players[seat].holeCards
    });
  }

  // Si un joueur all-in dès le départ (cartes communes distribuées d'emblée)
  const phaseEvents = state.events.filter(e => e.type === 'phase');
  if (phaseEvents.length > 0) {
    setTimeout(() => handlePostAction(room, null, phaseEvents[0].phase), 800);
  }
}

/**
 * Traite les événements produits après une action (changement de phase,
 * showdown, fin de partie).
 */
function handlePostAction(room, lastAction, newPhase) {
  const { state, sockets } = room;

  // Showdown
  const sdEv = state.events.find(e => e.type === 'showdown');
  if (sdEv) {
    for (const sid of sockets) {
      if (!sid) continue;
      io.to(sid).emit('showdown', {
        state:   publicState(state, sockets.indexOf(sid)),
        players: sdEv.players,    // cartes révélées des deux joueurs
        winner:  sdEv.winner,
        tie:     sdEv.tie,
        amount:  state.events.find(e => e.type === 'pot_awarded')?.amount || 0
      });
    }
  }

  // Fin de partie
  const goEv = state.events.find(e => e.type === 'game_over');
  if (goEv) {
    setTimeout(() => {
      for (let seat = 0; seat < 2; seat++) {
        const sid = sockets[seat];
        if (!sid) continue;
        io.to(sid).emit('game_over', {
          state:  publicState(state, seat),
          winner: goEv.winner
        });
      }
      // Nettoyer le salon après un délai
      setTimeout(() => rooms.delete(room.code), 30_000);
    }, 4000);
    return;
  }

  // Fin de main → prochaine main automatiquement
  if (state.phase === 'idle') {
    setTimeout(() => dealNewHand(room), 4000);
    return;
  }

  // Changement de phase intermédiaire (flop/turn/river)
  if (newPhase) {
    broadcastUpdate(room, lastAction, newPhase);
  }
}

// ─── CONNEXIONS SOCKET ────────────────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log(`[Socket] Connecté : ${socket.id}`);

  // ── Créer un salon ──────────────────────────────────────────────────────────
  socket.on('create_room', () => {
    const code = generateCode();
    const room = {
      code,
      sockets:          [socket.id, null],
      state:            PokerEngine.createGame(GAME_CONFIG),
      reconnectTimers:  [null, null]
    };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room_created', { code, seat: 0 });
    console.log(`[Salon] Créé : ${code} par ${socket.id}`);
  });

  // ── Rejoindre un salon ──────────────────────────────────────────────────────
  socket.on('join_room', ({ code }) => {
    const room = rooms.get(code);

    if (!room) {
      socket.emit('room_error', { message: `Salon "${code}" introuvable.` });
      return;
    }

    // Reconnecter un joueur existant ?
    const existingSeat = room.sockets.indexOf(socket.id);
    if (existingSeat !== -1) {
      socket.emit('room_error', { message: 'Vous êtes déjà dans ce salon.' });
      return;
    }

    // Trouver un seat vide
    let seat = -1;
    if (room.sockets[0] === null) seat = 0;
    else if (room.sockets[1] === null) seat = 1;

    if (seat === -1) {
      socket.emit('room_error', { message: 'Le salon est complet.' });
      return;
    }

    // Annuler le timer de reconnexion si actif
    if (room.reconnectTimers[seat]) {
      clearTimeout(room.reconnectTimers[seat]);
      room.reconnectTimers[seat] = null;
    }

    room.sockets[seat] = socket.id;
    socket.join(code);
    socket.emit('room_joined', { code, seat });
    console.log(`[Salon] ${code} : joueur ${seat} connecté (${socket.id})`);

    // Les deux joueurs sont là → démarrer la partie
    if (room.sockets[0] && room.sockets[1]) {
      // Notifier l'adversaire de la reconnexion s'il était seul
      const oppSid = room.sockets[1 - seat];
      if (oppSid) io.to(oppSid).emit('opponent_reconnected');

      console.log(`[Salon] ${code} : partie lancée !`);
      setTimeout(() => dealNewHand(room), 800);
    }
  });

  // ── Action de jeu ───────────────────────────────────────────────────────────
  socket.on('game_action', ({ action, amount }) => {
    // Retrouver le salon du joueur
    let room = null, seat = -1;
    for (const [, r] of rooms) {
      const s = getSeat(r, socket.id);
      if (s !== -1) { room = r; seat = s; break; }
    }

    if (!room) {
      socket.emit('error_msg', { message: 'Salon introuvable.' });
      return;
    }

    const { state } = room;

    // Vérifier que c'est bien le tour de ce joueur
    if (state.currentPlayer !== seat) {
      socket.emit('error_msg', { message: "Ce n'est pas votre tour." });
      return;
    }

    // Effectuer l'action
    let newState;
    try {
      newState = PokerEngine.performAction(state, action, amount);
    } catch (e) {
      socket.emit('error_msg', { message: `Action invalide : ${e.message}` });
      return;
    }

    room.state = newState;
    const lastAction = { player: seat, action, amount };

    // Déterminer si une nouvelle phase a commencé
    const phaseEv = newState.events.find(e => e.type === 'phase');
    const newPhase = phaseEv ? phaseEv.phase : null;

    // Diffuser la mise à jour
    broadcastUpdate(room, lastAction, newPhase);

    // Gérer la suite (showdown, fin de main, etc.)
    handlePostAction(room, lastAction, newPhase);
  });

  // ── Déconnexion ─────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[Socket] Déconnecté : ${socket.id}`);

    for (const [, room] of rooms) {
      const seat = getSeat(room, socket.id);
      if (seat === -1) continue;

      room.sockets[seat] = null;
      const oppSid = room.sockets[1 - seat];
      if (oppSid) {
        io.to(oppSid).emit('opponent_disconnected');
      }

      // Donner 60 s pour se reconnecter
      room.reconnectTimers[seat] = setTimeout(() => {
        // Timeout dépassé : l'adversaire gagne par abandon
        const oppSid2 = room.sockets[1 - seat];
        if (oppSid2) {
          io.to(oppSid2).emit('opponent_abandoned');
        }
        rooms.delete(room.code);
        console.log(`[Salon] ${room.code} supprimé (timeout reconnexion)`);
      }, RECONNECT_TIMEOUT_MS);

      break;
    }
  });
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`✅ Serveur démarré sur le port ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
});
