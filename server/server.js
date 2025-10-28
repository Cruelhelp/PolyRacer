require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const Pusher = require('pusher');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());

// ✅ Serve static files from the project root (since your HTMLs are there)
app.use(express.static(path.join(__dirname, '..')));

// Initialize Pusher
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

// Simple global game state (works for single-session mode)
const gameState = {
  players: {},
  gameStarted: false,
  raceDistance: 0.6,
  winner: null
};

// === API ROUTES ===

// Pusher config (client needs this)
app.get('/api/pusher-config', (req, res) => {
  res.json({
    key: process.env.PUSHER_KEY,
    cluster: process.env.PUSHER_CLUSTER
  });
});

app.post('/api/join', (req, res) => {
  const { playerId, playerName = `Player ${Object.keys(gameState.players).length + 1}` } = req.body;

  if (!playerId) return res.status(400).json({ error: 'Player ID required' });

  if (!gameState.players[playerId]) {
    gameState.players[playerId] = {
      id: playerId,
      name: playerName,
      position: 0,
      progress: 0,
      score: 0,
      combo: 0,
      authenticated: true
    };

    pusher.trigger('poly-race-channel', 'player_joined', {
      playerId,
      playerName,
      totalPlayers: Object.keys(gameState.players).length
    });
  }

  res.json({
    playerId,
    gameState: { ...gameState, players: Object.values(gameState.players) }
  });
});

app.post('/api/update', (req, res) => {
  const { playerId, position, progress, score, combo } = req.body;

  if (!gameState.players[playerId]) return res.status(404).json({ error: 'Player not found' });

  const player = gameState.players[playerId];
  player.position = position;
  player.progress = progress;
  player.score = score || 0;
  player.combo = combo || 0;

  pusher.trigger('poly-race-channel', 'player_update', { playerId, position, progress, score, combo });

  if (progress >= 100 && !gameState.winner) {
    gameState.winner = playerId;
    gameState.gameStarted = false;
    pusher.trigger('poly-race-channel', 'game_ended', {
      winner: playerId,
      winnerName: player.name
    });
  }

  res.json({ success: true });
});

app.post('/api/start', (req, res) => {
  const { playerId } = req.body;

  if (!gameState.players[playerId]) return res.status(403).json({ error: 'Unauthorized' });

  if (!gameState.gameStarted) {
    gameState.gameStarted = true;
    gameState.winner = null;
    gameState.startTime = new Date().toISOString();

    Object.values(gameState.players).forEach(p => {
      p.position = 0;
      p.progress = 0;
      p.combo = 0;
      p.score = 0;
    });

    pusher.trigger('poly-race-channel', 'game_started', {
      startTime: gameState.startTime,
      raceDistance: gameState.raceDistance
    });
  }

  res.json({ success: true });
});

app.post('/api/leave', (req, res) => {
  const { playerId } = req.body;
  if (gameState.players[playerId]) {
    delete gameState.players[playerId];
    pusher.trigger('poly-race-channel', 'player_left', {
      playerId,
      totalPlayers: Object.keys(gameState.players).length
    });
  }
  res.json({ success: true });
});

// Serve index.html for everything else
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

// Start server
app.listen(port, () => console.log(`✅ Server running on port ${port}`));
