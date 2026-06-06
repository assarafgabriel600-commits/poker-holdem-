/**
 * server.js
 * Serveur Express + Socket.IO
 * - Sert le frontend (fichiers statiques) ET le backend Socket.IO
 * - Écoute sur process.env.PORT (requis par Render, Heroku, etc.)
 * - Aucun chemin en dur, aucun localhost hardcodé
 */

'use strict';

// ─── GESTION DES ERREURS NON ATTRAPÉES ───────────────────────────────────────
// Empêche le serveur de crasher silencieusement sur Render
process.on('uncaughtException',  err => console.error('[CRASH] uncaughtException:',  err));
process.on('unhandledRejection', err => console.error('[CRASH] unhandledRejection:', err));

const express    = require('express');
const http       = require('http');
const { Server } = require('socket.io');
const path       = require('path');

// ─── MOTEUR DE POKER ─────────────────────────────────────────────────────────
// Partagé avec le client via module UMD (même fichier)
let PokerEngine;
try {
  PokerEngine = require('./public/js/poker-engine.js');
  console.log('[OK] poker-engine.js chargé');
} catch (e) {
  console.error('[ERREUR] Impossible de charger poker-engine.js :', e.message);
  process.exit(1);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT        = process.env.PORT || 3000;
const GAME_CONFIG = { smallBlind: 1, bigBlind: 2, startingStack: 100 };
const RECONNECT_TIMEOUT_MS = 60_000;

// ─── EXPRESS ──────────────────────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);

// Route de santé — DOIT être en premier
app.get('/health', (_req, res) => res.send('OK'));

// Servir les fichiers statiques (CSS, JS, images…)
const publicDir = path.join(__dirname, 'public');
app.use(express.static(publicDir));
console.log('[Static] Dossier :', publicDir);

// Routes HTML explicites (fallback robuste si static ne les trouve pas)
app.get('/',          (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));
app.get('/game.html', (_req, res) => res.sendFile(path.join(publicDir, 'game.html')));

// Catch-all → accueil (évite les "Not Found" sur Render)
app.use((_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// ─── SOCKET.IO ────────────────────────────────────────────────────────────────
const io = new Server(server, {
  cors:         { origin: '*' },
  pingTimeout:  60_000,
  pingInterval: 25_000
});

// ─── SALONS ───────────────────────────────────────────────────────────────────
/**
 * rooms : Map<code, Room>
 *  Room = { code, sockets:[sid|null, sid|null], state, reconnectTimers:[t,t] }
 */
const rooms = new Map();

function _genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = Array.from({length:4}, () => chars[Math.random()*chars.length|0]).join(''); }
  while (rooms.has(code));
  return code;
}

function _seat(room, sid) { return room.sockets.indexOf(sid); }

/** État public : masque les cartes privées de l'adversaire */
function _pub(state, forSeat) {
  const s = JSON.parse(JSON.stringify(state));
  s.players[1 - forSeat].holeCards = [];
  return s;
}

/** Diffuse l'état mis à jour aux deux joueurs */
function _broadcast(room, lastAction, newPhase) {
  room.sockets.forEach((sid, seat) => {
    if (!sid) return;
    io.to(sid).emit('game_update', {
      state:      _pub(room.state, seat),
      holeCards:  room.state.players[seat].holeCards,
      lastAction: lastAction || null,
      newPhase:   newPhase   || null
    });
  });
}

/** Lance une nouvelle main */
function _dealNewHand(room) {
  room.state = PokerEngine.startHand(room.state);
  room.sockets.forEach((sid, seat) => {
    if (!sid) return;
    io.to(sid).emit('hand_start', {
      state:     _pub(room.state, seat),
      holeCards: room.state.players[seat].holeCards
    });
  });
}

/** Gère les événements post-action (showdown, fin de partie, fin de main) */
function _handlePostAction(room, lastAction, newPhase) {
  const { state, sockets } = room;

  // ── Showdown : révéler les deux mains ────────────────────────────────────────
  const sdEv = state.events.find(e => e.type === 'showdown');
  if (sdEv) {
    sockets.forEach((sid, seat) => {
      if (!sid) return;
      io.to(sid).emit('showdown', {
        state:   _pub(state, seat),
        players: sdEv.players,
        winner:  sdEv.winner,
        tie:     sdEv.tie,
        amount:  (state.events.find(e => e.type === 'pot_awarded') || {}).amount || 0
      });
    });
  }

  // ── Fin de partie ────────────────────────────────────────────────────────────
  const goEv = state.events.find(e => e.type === 'game_over');
  if (goEv) {
    setTimeout(() => {
      sockets.forEach((sid, seat) => {
        if (!sid) return;
        io.to(sid).emit('game_over', { state: _pub(state, seat), winner: goEv.winner });
      });
      setTimeout(() => rooms.delete(room.code), 30_000);
    }, 4000);
    return;
  }

  // ── Fin de main → prochaine main auto ────────────────────────────────────────
  const potEv = state.events.find(e => e.type === 'pot_awarded');
  if (potEv) {
    setTimeout(() => _dealNewHand(room), 4500);
    return;
  }

  // ── Changement de phase ───────────────────────────────────────────────────────
  if (newPhase) {
    _broadcast(room, lastAction, newPhase);
  }
}

// ─── CONNEXIONS ───────────────────────────────────────────────────────────────
io.on('connection', socket => {
  console.log(`[+] ${socket.id}`);

  // ── Créer un salon ────────────────────────────────────────────────────────────
  socket.on('create_room', () => {
    const code = _genCode();
    const room = { code, sockets: [socket.id, null],
                   state: PokerEngine.createGame(GAME_CONFIG),
                   reconnectTimers: [null, null] };
    rooms.set(code, room);
    socket.join(code);
    socket.emit('room_created', { code, seat: 0 });
    console.log(`[Salon] ${code} créé`);
  });

  // ── Rejoindre un salon ────────────────────────────────────────────────────────
  socket.on('join_room', ({ code }) => {
    const room = rooms.get(code);
    if (!room) { socket.emit('room_error', { message: `Salon "${code}" introuvable.` }); return; }
    if (_seat(room, socket.id) !== -1) { socket.emit('room_error', { message: 'Déjà connecté.' }); return; }

    let seat = room.sockets[0] === null ? 0 : room.sockets[1] === null ? 1 : -1;
    if (seat === -1) { socket.emit('room_error', { message: 'Salon complet.' }); return; }

    if (room.reconnectTimers[seat]) { clearTimeout(room.reconnectTimers[seat]); room.reconnectTimers[seat] = null; }
    room.sockets[seat] = socket.id;
    socket.join(code);
    socket.emit('room_joined', { code, seat });
    console.log(`[Salon] ${code} : siège ${seat} pris`);

    if (room.sockets[0] && room.sockets[1]) {
      const oppSid = room.sockets[1 - seat];
      if (oppSid) io.to(oppSid).emit('opponent_reconnected');
      console.log(`[Salon] ${code} : partie lancée`);
      setTimeout(() => _dealNewHand(room), 800);
    }
  });

  // ── Action de jeu ─────────────────────────────────────────────────────────────
  socket.on('game_action', ({ action, amount }) => {
    let room = null, seat = -1;
    for (const [, r] of rooms) { const s = _seat(r, socket.id); if (s !== -1) { room = r; seat = s; break; } }
    if (!room) { socket.emit('error_msg', { message: 'Salon introuvable.' }); return; }

    const { state } = room;
    if (state.currentPlayer !== seat) { socket.emit('error_msg', { message: "Pas votre tour." }); return; }

    let newState;
    try { newState = PokerEngine.performAction(state, action, amount); }
    catch (e) { socket.emit('error_msg', { message: `Action invalide : ${e.message}` }); return; }

    room.state = newState;
    const lastAction = { player: seat, action, amount };
    const phaseEv    = newState.events.find(e => e.type === 'phase');
    const newPhase   = phaseEv ? phaseEv.phase : null;

    _broadcast(room, lastAction, newPhase);
    _handlePostAction(room, lastAction, newPhase);
  });

  // ── Déconnexion ────────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    console.log(`[-] ${socket.id}`);
    for (const [, room] of rooms) {
      const seat = _seat(room, socket.id);
      if (seat === -1) continue;
      room.sockets[seat] = null;
      const oppSid = room.sockets[1 - seat];
      if (oppSid) io.to(oppSid).emit('opponent_disconnected');
      room.reconnectTimers[seat] = setTimeout(() => {
        const opp2 = room.sockets[1 - seat];
        if (opp2) io.to(opp2).emit('opponent_abandoned');
        rooms.delete(room.code);
        console.log(`[Salon] ${room.code} supprimé (timeout)`);
      }, RECONNECT_TIMEOUT_MS);
      break;
    }
  });
});

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n✅ Serveur démarré sur le port ${PORT}`);
  console.log(`   http://localhost:${PORT}\n`);
});
