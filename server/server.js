require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const cors = require('cors');
const Pusher = require('pusher');

// Initialize Express app
const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3001;

// Initialize Socket.IO
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('../')); // Serve static files from the parent directory

// Initialize Pusher (keeping for backward compatibility)
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID,
  key: process.env.PUSHER_KEY,
  secret: process.env.PUSHER_SECRET,
  cluster: process.env.PUSHER_CLUSTER,
  useTLS: true
});

// Game state (existing)
const gameState = {
  players: {},
  gameStarted: false,
  raceDistance: 0.6,
  winner: null
};

// NEW: Socket.IO state management
const onlinePlayers = new Map(); // socketId -> player data
const gameRooms = new Map(); // roomCode -> room data
const challenges = new Map(); // challengeId -> challenge data

// Helper function to generate room code
function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return code;
}

// Helper functions for broadcasting
function broadcastPlayerCount() {
  const playersList = Array.from(onlinePlayers.values());
  io.emit('players:online', {
    count: onlinePlayers.size,
    players: playersList
  });
}

function broadcastPlayersList() {
  const playersList = Array.from(onlinePlayers.values());
  io.emit('players:list', {
    players: playersList
  });
}

function broadcastRoomsList() {
  const roomsList = Array.from(gameRooms.values()).map(room => ({
    code: room.code,
    name: room.name,
    players: room.players.length,
    maxPlayers: room.maxPlayers,
    status: room.status
  }));

  io.emit('rooms:list', {
    rooms: roomsList
  });
}

function leaveRoom(socketId) {
  const player = onlinePlayers.get(socketId);
  if (!player || !player.currentRoom) return;

  const room = gameRooms.get(player.currentRoom);
  if (room) {
    room.players = room.players.filter(id => id !== socketId);

    if (room.players.length === 0 || room.host === socketId) {
      gameRooms.delete(player.currentRoom);
      console.log(`Room deleted: ${player.currentRoom}`);
    } else {
      io.to(player.currentRoom).emit('room:player_left', {
        playerId: socketId,
        playerName: player.name,
        playerCount: room.players.length
      });
    }

    broadcastRoomsList();
  }

  player.currentRoom = null;
  player.status = 'online';
  broadcastPlayersList();
}

// Socket.IO Connection Handling
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // Player registration
  socket.on('player:register', (data) => {
    const player = {
      id: socket.id,
      name: data.name || `Player${Math.floor(Math.random() * 10000)}`,
      status: 'online',
      wins: 0,
      gamesPlayed: 0,
      wpm: Math.floor(Math.random() * 40) + 60, // Placeholder
      currentRoom: null
    };

    onlinePlayers.set(socket.id, player);

    socket.emit('player:registered', {
      playerId: socket.id,
      username: player.name
    });

    broadcastPlayerCount();
    broadcastPlayersList();

    console.log(`Player registered: ${player.name} (${socket.id})`);
  });

  // Get online players
  socket.on('players:get', () => {
    const playersList = Array.from(onlinePlayers.values());
    socket.emit('players:list', {
      players: playersList
    });
    socket.emit('players:online', {
      count: onlinePlayers.size,
      players: playersList
    });
  });

  // Create room
  socket.on('room:create', (data) => {
    const player = onlinePlayers.get(socket.id);
    if (!player) {
      socket.emit('room:error', { message: 'Player not registered' });
      return;
    }

    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      name: data.roomName,
      host: socket.id,
      players: [socket.id],
      maxPlayers: data.maxPlayers || 4,
      status: 'waiting',
      gameSettings: data.gameSettings || {
        mode: 'quick',
        typingMode: 'letters'
      },
      createdAt: Date.now()
    };

    gameRooms.set(roomCode, room);
    player.currentRoom = roomCode;
    player.status = 'in-room';
    socket.join(roomCode);

    socket.emit('room:created', {
      roomCode: roomCode,
      roomName: room.name
    });

    socket.emit('room:joined', {
      roomCode: roomCode,
      room: room
    });

    broadcastRoomsList();
    broadcastPlayersList();

    console.log(`Room created: ${roomCode} by ${player.name}`);
  });

  // Join room
  socket.on('room:join', (data) => {
    const player = onlinePlayers.get(socket.id);
    const room = gameRooms.get(data.roomCode);

    if (!player) {
      socket.emit('room:error', { message: 'Player not registered' });
      return;
    }

    if (!room) {
      socket.emit('room:error', { message: 'Room not found' });
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('room:error', { message: 'Room is full' });
      return;
    }

    if (room.status === 'in-game') {
      socket.emit('room:error', { message: 'Game already in progress' });
      return;
    }

    room.players.push(socket.id);
    player.currentRoom = data.roomCode;
    player.status = 'in-room';
    socket.join(data.roomCode);

    socket.emit('room:joined', {
      roomCode: data.roomCode,
      room: room
    });

    io.to(data.roomCode).emit('room:player_joined', {
      playerId: socket.id,
      playerName: player.name,
      playerCount: room.players.length
    });

    broadcastRoomsList();
    broadcastPlayersList();

    console.log(`${player.name} joined room ${data.roomCode}`);
  });

  // Leave room
  socket.on('room:leave', () => {
    leaveRoom(socket.id);
  });

  // Get rooms list
  socket.on('rooms:get', () => {
    const roomsList = Array.from(gameRooms.values()).map(room => ({
      code: room.code,
      name: room.name,
      players: room.players.length,
      maxPlayers: room.maxPlayers,
      status: room.status
    }));

    socket.emit('rooms:list', {
      rooms: roomsList
    });
  });

  // Send challenge
  socket.on('challenge:send', (data) => {
    const challenger = onlinePlayers.get(socket.id);
    const target = onlinePlayers.get(data.targetId);

    if (!challenger || !target) {
      socket.emit('challenge:error', { message: 'Player not found' });
      return;
    }

    if (target.status === 'in-game' || target.status === 'in-room') {
      socket.emit('challenge:error', { message: 'Player is currently busy' });
      return;
    }

    const challengeId = `${socket.id}-${data.targetId}-${Date.now()}`;
    challenges.set(challengeId, {
      id: challengeId,
      challengerId: socket.id,
      targetId: data.targetId,
      status: 'pending'
    });

    io.to(data.targetId).emit('challenge:received', {
      challengeId: challengeId,
      challengerId: socket.id,
      challengerName: challenger.name
    });

    console.log(`${challenger.name} challenged ${target.name}`);
  });

  // Accept challenge
  socket.on('challenge:accept', (data) => {
    const challenge = Array.from(challenges.values()).find(
      c => c.targetId === socket.id && c.challengerId === data.challengerId && c.status === 'pending'
    );

    if (!challenge) {
      socket.emit('challenge:error', { message: 'Challenge not found' });
      return;
    }

    const challenger = onlinePlayers.get(challenge.challengerId);
    const target = onlinePlayers.get(socket.id);

    if (!challenger || !target) {
      socket.emit('challenge:error', { message: 'Player not found' });
      return;
    }

    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      name: `${challenger.name} vs ${target.name}`,
      host: challenge.challengerId,
      players: [challenge.challengerId, socket.id],
      maxPlayers: 2,
      status: 'waiting',
      gameSettings: {
        mode: 'quick',
        typingMode: 'letters'
      },
      createdAt: Date.now()
    };

    gameRooms.set(roomCode, room);

    challenger.currentRoom = roomCode;
    challenger.status = 'in-room';
    target.currentRoom = roomCode;
    target.status = 'in-room';

    io.sockets.sockets.get(challenge.challengerId)?.join(roomCode);
    socket.join(roomCode);

    io.to(challenge.challengerId).emit('challenge:accepted', {
      roomCode: roomCode,
      accepterName: target.name
    });

    socket.emit('challenge:accepted', {
      roomCode: roomCode,
      challengerName: challenger.name
    });

    challenges.delete(challenge.id);

    broadcastRoomsList();
    broadcastPlayersList();

    console.log(`Challenge accepted: ${challenger.name} vs ${target.name} in room ${roomCode}`);
  });

  // Decline challenge
  socket.on('challenge:decline', (data) => {
    const challenge = Array.from(challenges.values()).find(
      c => c.targetId === socket.id && c.challengerId === data.challengerId && c.status === 'pending'
    );

    if (!challenge) return;

    const decliner = onlinePlayers.get(socket.id);

    io.to(challenge.challengerId).emit('challenge:declined', {
      declinerId: socket.id,
      declinerName: decliner?.name || 'Player'
    });

    challenges.delete(challenge.id);

    console.log(`Challenge declined by ${decliner?.name}`);
  });

  // Chat message
  socket.on('chat:send', (data) => {
    const player = onlinePlayers.get(socket.id);
    if (!player) return;

    const message = {
      username: player.name,
      message: data.message,
      timestamp: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
    };

    io.emit('chat:message', message);

    console.log(`Chat: ${player.name}: ${data.message}`);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const player = onlinePlayers.get(socket.id);
    
    if (player) {
      console.log(`Player disconnected: ${player.name} (${socket.id})`);
      
      leaveRoom(socket.id);
      onlinePlayers.delete(socket.id);
      
      broadcastPlayerCount();
      broadcastPlayersList();
    }
  });
});

// ===== EXISTING PUSHER API ROUTES (KEPT FOR BACKWARD COMPATIBILITY) =====

app.post('/api/join', (req, res) => {
  const { playerId, playerName = `Player ${Object.keys(gameState.players).length + 1}` } = req.body;
  
  if (!playerId) {
    return res.status(400).json({ error: 'Player ID is required' });
  }

  if (!gameState.players[playerId]) {
    gameState.players[playerId] = {
      id: playerId,
      name: playerName,
      position: 0,
      progress: 0,
      score: 0,
      combo: 0,
      joinedAt: new Date().toISOString()
    };

    pusher.trigger('poly-race-channel', 'player_joined', {
      playerId,
      playerName,
      totalPlayers: Object.keys(gameState.players).length
    });
  }

  res.json({
    playerId,
    gameState: {
      ...gameState,
      players: Object.values(gameState.players)
    }
  });
});

app.post('/api/update', (req, res) => {
  const { playerId, position, progress } = req.body;
  
  if (!playerId || !gameState.players[playerId]) {
    return res.status(404).json({ error: 'Player not found' });
  }

  gameState.players[playerId].position = position;
  gameState.players[playerId].progress = progress;
  gameState.players[playerId].lastUpdate = new Date().toISOString();

  pusher.trigger('poly-race-channel', 'player_update', {
    playerId,
    position,
    progress
  });

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

  if (!gameState.gameStarted) {
    gameState.gameStarted = true;
    gameState.winner = null;
    gameState.startTime = new Date().toISOString();
    
    Object.values(gameState.players).forEach(player => {
      player.position = 0;
      player.progress = 0;
      player.combo = 0;
    });

    pusher.trigger('poly-race-channel', 'game_started', {
      startTime: gameState.startTime,
      raceDistance: gameState.raceDistance
    });
  }

  res.json({ success: true, gameState });
});

// ===== NEW API ENDPOINTS =====

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    players: onlinePlayers.size,
    rooms: gameRooms.size,
    timestamp: Date.now()
  });
});

// Leaderboard endpoint
app.get('/leaderboard', (req, res) => {
  const leaderboard = Array.from(onlinePlayers.values())
    .sort((a, b) => b.wins - a.wins)
    .slice(0, 10)
    .map((player, index) => ({
      rank: index + 1,
      username: player.name,
      wins: player.wins,
      wpm: player.wpm
    }));

  res.json({
    leaderboard: leaderboard
  });
});

// Serve the main HTML file
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: '../' });
});

// Start the server (using 'server' instead of 'app' for Socket.IO)
server.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
  console.log(`Socket.IO enabled for multiplayer features`);
});

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down server...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  server.close(() => {
    console.log('HTTP server closed');
  });
});
