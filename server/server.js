require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Pusher = require('pusher');

// ======================================
// Express Setup
// ======================================
const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use(express.static('../')); // Serve your HTML/CSS/JS

// ======================================
// Pusher Setup
// ======================================
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

// ======================================
// In-memory Room System
// ======================================
const rooms = {}; // { roomCode: { players: {}, gameStarted, winner, raceDistance, startTime } }

// Utility: Generate random 6-character invite codes
function generateInviteCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// ======================================
// API ROUTES
// ======================================

// --- Create or Join Room ---
app.post('/api/join', (req, res) => {
  const { playerId, playerName, inviteCode } = req.body;
  const roomCode = inviteCode || generateInviteCode();

  if (!playerId) {
    return res.status(400).json({ error: 'Player ID is required' });
  }

  // Create room if it doesn’t exist
  if (!rooms[roomCode]) {
    rooms[roomCode] = {
      id: roomCode,
      players: {},
      gameStarted: false,
      winner: null,
      raceDistance: 0.6,
      startTime: null
    };
  }

  const room = rooms[roomCode];

  // Add player to room if not already in it
  if (!room.players[playerId]) {
    room.players[playerId] = {
      id: playerId,
      name: playerName || `Player ${Object.keys(room.players).length + 1}`,
      position: 0,
      progress: 0,
      score: 0,
      combo: 0,
      joinedAt: new Date().toISOString()
    };

    // Notify clients in room
    pusher.trigger(`poly-race-${roomCode}`, 'player_joined', {
      roomId: roomCode,
      player: room.players[playerId],
      totalPlayers: Object.keys(room.players).length
    });
  }

  // Return the full room state to the joining client
  res.json({
    success: true,
    roomId: roomCode,
    playerId,
    gameState: {
      ...room,
      players: Object.values(room.players)
    }
  });
});

// --- Update Player State ---
app.post('/api/update', (req, res) => {
  const { roomId, playerId, position, progress } = req.body;

  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.players[playerId]) return res.status(404).json({ error: 'Player not found' });

  // Update player’s progress
  room.players[playerId].position = position;
  room.players[playerId].progress = progress;
  room.players[playerId].lastUpdate = new Date().toISOString();

  // Broadcast live update
  pusher.trigger(`poly-race-${roomId}`, 'player_update', {
    playerId,
    position,
    progress
  });

  // Check for winner
  if (progress >= 100 && !room.winner) {
    room.winner = playerId;
    room.gameStarted = false;

    pusher.trigger(`poly-race-${roomId}`, 'game_ended', {
      winner: playerId,
      winnerName: room.players[playerId].name
    });
  }

  res.json({ success: true });
});

// --- Start Game in Room ---
app.post('/api/start', (req, res) => {
  const { roomId, playerId } = req.body;
  const room = rooms[roomId];

  if (!room) return res.status(404).json({ error: 'Room not found' });
  if (!room.players[playerId]) return res.status(403).json({ error: 'Unauthorized player' });

  if (!room.gameStarted) {
    room.gameStarted = true;
    room.winner = null;
    room.startTime = new Date().toISOString();

    // Reset players
    Object.values(room.players).forEach(p => {
      p.position = 0;
      p.progress = 0;
      p.combo = 0;
      p.score = 0;
    });

    // Broadcast to all clients in room
    pusher.trigger(`poly-race-${roomId}`, 'game_started', {
      startTime: room.startTime,
      raceDistance: room.raceDistance
    });
  }

  res.json({ success: true, room });
});

// --- Generate New Invite Code ---
app.get('/api/invite', (req, res) => {
  const code = generateInviteCode();
  res.json({ inviteCode: code });
});

// --- Get Room State ---
app.get('/api/state/:roomId', (req, res) => {
  const { roomId } = req.params;
  const room = rooms[roomId];
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ success: true, room });
});

// --- Reset Room (optional for debugging) ---
app.post('/api/reset', (req, res) => {
  const { roomId } = req.body;
  if (roomId && rooms[roomId]) {
    delete rooms[roomId];
    return res.json({ success: true, message: `Room ${roomId} reset` });
  }
  res.json({ success: true, message: 'All rooms cleared', rooms: (Object.keys(rooms).length = 0) });
});

// ======================================
// Default Route
// ======================================
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: '../' });
});

// ======================================
// Server Start
// ======================================
app.listen(port, () => {
  console.log(`✅ POLY RACE server running on http://localhost:${port}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down POLY RACE server...');
  process.exit(0);
});
