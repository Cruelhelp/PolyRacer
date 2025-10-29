const express = require('express');
const { createServer } = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// Game state management
const rooms = new Map();
const players = new Map();
const waitingPlayers = [];

// Helper functions
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

function getOnlinePlayers() {
  return Array.from(players.values()).map(p => ({
    id: p.id,
    name: p.name,
    status: p.inGame ? 'in-game' : 'online'
  }));
}

// --- SOCKET CONNECTION HANDLER ---
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // --- SYNC PATCH ---
  socket.on('room:sync:request', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (room) {
      socket.emit('room:sync', { room });
    } else {
      socket.emit('room:error', { message: 'Room not found' });
    }
  });
  // --- END PATCH ---

  // Player registers with username
  socket.on('player:register', (data) => {
    const playerData = {
      id: socket.id,
      name: data.name,
      socketId: socket.id,
      inGame: false,
      roomCode: null
    };

    players.set(socket.id, playerData);

    socket.emit('player:registered', {
      playerId: socket.id,
      playerData
    });

    io.emit('players:online', {
      count: players.size,
      players: getOnlinePlayers()
    });

    console.log(`Player registered: ${playerData.name} (${socket.id})`);
  });

  // Create a new room
  socket.on('room:create', () => {
    const player = players.get(socket.id);
    if (!player) {
      socket.emit('room:error', { message: 'Player not registered' });
      return;
    }

    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      host: socket.id,
      players: [{
        id: socket.id,
        name: player.name,
        position: 0,
        progress: 0,
        score: 0,
        combo: 0,
        ready: false
      }],
      gameState: 'waiting',
      winner: null,
      createdAt: Date.now()
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    player.roomCode = roomCode;
    player.inGame = true;

    socket.emit('room:created', { roomCode, room });
    console.log(`Room ${roomCode} created by ${player.name}`);
  });

  // Join room
  socket.on('room:join', (data) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);
    const player = players.get(socket.id);

    if (!player) return socket.emit('room:error', { message: 'Player not registered' });
    if (!room) return socket.emit('room:error', { message: 'Room not found' });
    if (room.players.length >= 2) return socket.emit('room:error', { message: 'Room is full' });
    if (room.gameState !== 'waiting') return socket.emit('room:error', { message: 'Game already started' });

    room.players.push({
      id: socket.id,
      name: player.name,
      position: 0,
      progress: 0,
      score: 0,
      combo: 0,
      ready: false
    });

    socket.join(roomCode);
    player.roomCode = roomCode;
    player.inGame = true;

    socket.emit('room:joined', { roomCode, room });
    io.to(roomCode).emit('room:updated', { room, playerCount: room.players.length });
    console.log(`${player.name} joined room ${roomCode}`);
  });

  // Random matchmaking
  socket.on('match:random', () => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('room:error', { message: 'Player not registered' });

    if (waitingPlayers.length > 0) {
      const opponentId = waitingPlayers.shift();
      const opponent = players.get(opponentId);
      if (!opponent) {
        socket.emit('match:searching');
        waitingPlayers.push(socket.id);
        return;
      }

      const roomCode = generateRoomCode();
      const room = {
        code: roomCode,
        host: opponentId,
        players: [
          { id: opponentId, name: opponent.name, position: 0, progress: 0, score: 0, combo: 0, ready: false },
          { id: socket.id, name: player.name, position: 0, progress: 0, score: 0, combo: 0, ready: false }
        ],
        gameState: 'waiting',
        winner: null,
        createdAt: Date.now()
      };

      rooms.set(roomCode, room);
      io.sockets.sockets.get(opponentId)?.join(roomCode);
      socket.join(roomCode);

      opponent.roomCode = roomCode;
      opponent.inGame = true;
      player.roomCode = roomCode;
      player.inGame = true;

      io.to(roomCode).emit('match:found', { roomCode, room });
      console.log(`Match created: ${roomCode} (${opponent.name} vs ${player.name})`);
    } else {
      waitingPlayers.push(socket.id);
      socket.emit('match:searching');
      setTimeout(() => {
        const i = waitingPlayers.indexOf(socket.id);
        if (i > -1) {
          waitingPlayers.splice(i, 1);
          socket.emit('match:timeout');
        }
      }, 30000);
    }
  });

  // Player ready (fixed)
socket.on('player:ready', () => {
  const player = players.get(socket.id);
  if (!player || !player.roomCode) return;
  const room = rooms.get(player.roomCode);
  if (!room) return;

  const rp = room.players.find(p => p.id === socket.id);
  if (rp) rp.ready = true;

  // Update everyone in the room
  io.to(player.roomCode).emit('room:updated', { room });

  // ✅ Only start if both are ready AND game is still in waiting state
  if (room.gameState === 'waiting' && room.players.length >= 2 && room.players.every(p => p.ready)) {
    room.gameState = 'countdown';
    io.to(player.roomCode).emit('game:countdown', { room });

    setTimeout(() => {
      room.gameState = 'playing';
      room.startTime = Date.now();
      io.to(player.roomCode).emit('game:start', { room });
    }, 3000);
  }
});


  // Player update
  socket.on('player:update', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room || room.gameState !== 'playing') return;

    const rp = room.players.find(p => p.id === socket.id);
    if (rp) {
      rp.position = data.position;
      rp.progress = data.progress;
      rp.score = data.score;
      rp.combo = data.combo;
    }
    io.to(player.roomCode).emit('game:update', { players: room.players });
  });

  // Player finished
  socket.on('player:finished', () => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room || room.gameState !== 'playing') return;

    if (!room.winner) {
      room.winner = socket.id;
      room.gameState = 'finished';
      room.endTime = Date.now();
      room.raceTime = ((room.endTime - room.startTime) / 1000).toFixed(1);
      const wp = room.players.find(p => p.id === socket.id);
      io.to(player.roomCode).emit('game:finished', {
        winner: { id: socket.id, name: player.name, score: wp?.score || 0, time: room.raceTime },
        room
      });
      console.log(`${player.name} won in room ${player.roomCode}`);
    }
  });

  // Leave room
  socket.on('room:leave', () => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (room) {
      room.players = room.players.filter(p => p.id !== socket.id);
      io.to(player.roomCode).emit('room:player-left', {
        playerId: socket.id,
        playerName: player.name,
        room
      });
      if (room.players.length === 0) {
        rooms.delete(player.roomCode);
        console.log(`Room ${player.roomCode} deleted`);
      }
    }
    socket.leave(player.roomCode);
    player.roomCode = null;
    player.inGame = false;
  });

  // Chat
  socket.on('chat:send', (data) => {
    const player = players.get(socket.id);
    if (!player) return;
    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    io.emit('chat:message', { username: data.username || player.name, message: data.message, timestamp });
    console.log(`[CHAT] ${player.name}: ${data.message}`);
  });

  // Disconnect
  socket.on('disconnect', () => {
    const player = players.get(socket.id);
    if (player && player.roomCode) {
      const room = rooms.get(player.roomCode);
      if (room) {
        room.players = room.players.filter(p => p.id !== socket.id);
        io.to(player.roomCode).emit('room:player-left', {
          playerId: socket.id,
          playerName: player.name,
          room
        });
        if (room.players.length === 0) {
          rooms.delete(player.roomCode);
          console.log(`Room ${player.roomCode} deleted`);
        }
      }
    }
    const i = waitingPlayers.indexOf(socket.id);
    if (i > -1) waitingPlayers.splice(i, 1);
    players.delete(socket.id);
    io.emit('players:online', { count: players.size, players: getOnlinePlayers() });
    console.log(`Player ${socket.id} disconnected. Total players: ${players.size}`);
  });
});

// API routes
app.get('/api/players', (req, res) => {
  res.json({ count: players.size, players: getOnlinePlayers() });
});

app.get('/api/rooms', (req, res) => {
  res.json({ rooms: Array.from(rooms.values()) });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', players: players.size, rooms: rooms.size });
});

// Serve pages
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing.html'));
});

app.get('/game', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'index.html'));
});

httpServer.listen(port, () => {
  console.log(`
╔═══════════════════════════════════════╗
║     POLY RACE MULTIPLAYER SERVER      ║
╠═══════════════════════════════════════╣
║  Server: http://localhost:${port}      ║
║  Status: ✅ READY                      ║
╚═══════════════════════════════════════╝
  `);
});

process.on('SIGINT', () => {
  console.log('\nShutting down server...');
  httpServer.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
