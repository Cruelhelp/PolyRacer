require('dotenv').config();
const express = require('express');
const cors = require('cors');
const Pusher = require('pusher');

// Initialize Express app
const app = express();
const port = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('../')); // Serve static files from the parent directory

// Initialize Pusher
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

// Game state
const gameState = {
  players: {},
  gameStarted: false,
  raceDistance: 0.6, // Default race distance (60% of screen width)
  winner: null
};

// API Routes

// Get Pusher config (key only, not secret)
app.get('/api/pusher-config', (req, res) => {
  res.json({
    key: process.env.PUSHER_KEY,
    cluster: process.env.PUSHER_CLUSTER
  });
});

app.post('/api/join', (req, res) => {
  const { playerId, playerName = `Player ${Object.keys(gameState.players).length + 1}` } = req.body;

  if (!playerId) {
    return res.status(400).json({ error: 'Player ID is required' });
  }

  // Add player to the game
  if (!gameState.players[playerId]) {
    gameState.players[playerId] = {
      id: playerId,
      name: playerName,
      position: 0,
      progress: 0,
      score: 0,
      combo: 0,
      joinedAt: new Date().toISOString(),
      authenticated: true
    };

    // Notify all clients about the new player
    pusher.trigger('poly-race-channel', 'player_joined', {
      playerId,
      playerName,
      totalPlayers: Object.keys(gameState.players).length
    });
  }

  // Send current game state to the joining player
  res.json({
    playerId,
    gameState: {
      ...gameState,
      players: Object.values(gameState.players)
    }
  });
});

app.post('/api/update', (req, res) => {
  const { playerId, position, progress, score, combo } = req.body;

  if (!playerId || !gameState.players[playerId]) {
    return res.status(404).json({ error: 'Player not found' });
  }

  // Verify player authentication
  if (!gameState.players[playerId].authenticated) {
    return res.status(403).json({ error: 'Not authenticated' });
  }

  // Update player state
  gameState.players[playerId].position = position;
  gameState.players[playerId].progress = progress;
  gameState.players[playerId].score = score || 0;
  gameState.players[playerId].combo = combo || 0;
  gameState.players[playerId].lastUpdate = new Date().toISOString();

  // Broadcast update to all clients
  pusher.trigger('poly-race-channel', 'player_update', {
    playerId,
    position,
    progress,
    score,
    combo
  });

  // Check for winner
  if (progress >= 100 && !gameState.winner) {
    gameState.winner = playerId;
    gameState.gameStarted = false;

    pusher.trigger('poly-race-channel', 'game_ended', {
      winner: playerId,
      winnerName: gameState.players[playerId].name
    });
  }

  res.json({ success: true });
});

app.post('/api/start', (req, res) => {
  const { playerId } = req.body;

  if (!gameState.players[playerId]) {
    return res.status(403).json({ error: 'Unauthorized' });
  }

  // Verify authentication
  if (!gameState.players[playerId].authenticated) {
    return res.status(403).json({ error: 'Not authenticated' });
  }

  // Only start if game isn't already running
  if (!gameState.gameStarted) {
    gameState.gameStarted = true;
    gameState.winner = null;
    gameState.startTime = new Date().toISOString();

    // Reset player positions
    Object.values(gameState.players).forEach(player => {
      player.position = 0;
      player.progress = 0;
      player.combo = 0;
      player.score = 0;
    });

    // Notify all clients to start the game
    pusher.trigger('poly-race-channel', 'game_started', {
      startTime: gameState.startTime,
      raceDistance: gameState.raceDistance
    });
  }

  res.json({ success: true, gameState });
});

// Win endpoint
app.post('/api/win', (req, res) => {
  const { playerId, score, maxCombo, time } = req.body;

  if (!playerId || !gameState.players[playerId]) {
    return res.status(404).json({ error: 'Player not found' });
  }

  if (!gameState.winner) {
    gameState.winner = playerId;
    gameState.gameStarted = false;

    pusher.trigger('poly-race-channel', 'game_ended', {
      winner: playerId,
      winnerName: gameState.players[playerId].name,
      score,
      maxCombo,
      time
    });
  }

  res.json({ success: true });
});

// Player leave endpoint
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

// Serve the main HTML file
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: '../' });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  process.exit(0);
});
