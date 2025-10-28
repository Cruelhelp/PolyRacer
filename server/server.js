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

  // client is asking for the latest full room snapshot before we go to game.html
  socket.on('room:sync:request', ({ roomCode }) => {
    const room = rooms.get(roomCode);
    if (room) {
      io.to(roomCode).emit('room:sync', { room });
    }
  });

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

    // Broadcast updated player count
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
      gameState: 'waiting', // waiting, countdown, playing, finished
      winner: null,
      createdAt: Date.now()
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);

    player.roomCode = roomCode;
    player.inGame = true;

    socket.emit('room:created', {
      roomCode,
      room
    });

    console.log(`Room ${roomCode} created by ${player.name}`);
  });

  // Join existing room
  socket.on('room:join', (data) => {
    const { roomCode } = data;
    const room = rooms.get(roomCode);
    const player = players.get(socket.id);

    if (!player) {
      socket.emit('room:error', { message: 'Player not registered' });
      return;
    }

    if (!room) {
      socket.emit('room:error', { message: 'Room not found' });
      return;
    }

    if (room.players.length >= 2) {
      socket.emit('room:error', { message: 'Room is full' });
      return;
    }

    if (room.gameState !== 'waiting') {
      socket.emit('room:error', { message: 'Game already started' });
      return;
    }

    // Add player to room
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

    // Notify all players in room
    io.to(roomCode).emit('room:updated', {
      room,
      playerCount: room.players.length
    });

    console.log(`${player.name} joined room ${roomCode}`);
  });

  // Random matchmaking
  socket.on('match:random', () => {
    const player = players.get(socket.id);
    if (!player) {
      socket.emit('room:error', { message: 'Player not registered' });
      return;
    }

    // Check if there's a waiting player
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
          {
            id: opponentId,
            name: opponent.name,
            position: 0,
            progress: 0,
            score: 0,
            combo: 0,
            ready: false
          },
          {
            id: socket.id,
            name: player.name,
            position: 0,
            progress: 0,
            score: 0,
            combo: 0,
            ready: false
          }
        ],
        gameState: 'waiting',
        winner: null,
        createdAt: Date.now()
      };

      rooms.set(roomCode, room);

      // Add both players to room
      io.sockets.sockets.get(opponentId)?.join(roomCode);
      socket.join(roomCode);

      opponent.roomCode = roomCode;
      opponent.inGame = true;
      player.roomCode = roomCode;
      player.inGame = true;

      // Notify both players
      io.to(roomCode).emit('match:found', { roomCode, room });

      console.log(`Match created: ${roomCode} (${opponent.name} vs ${player.name})`);
    } else {
      // Add to waiting list
      waitingPlayers.push(socket.id);
      socket.emit('match:searching');

      // Timeout after 30 seconds
      setTimeout(() => {
        const index = waitingPlayers.indexOf(socket.id);
        if (index > -1) {
          waitingPlayers.splice(index, 1);
          socket.emit('match:timeout');
        }
      }, 30000);
    }
  });

  // Get all online players
  socket.on('players:get', () => {
    socket.emit('players:list', {
      players: getOnlinePlayers()
    });
  });

  // Player ready status
  socket.on('player:ready', () => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;

    const room = rooms.get(player.roomCode);
    if (!room) return;

    const roomPlayer = room.players.find(p => p.id === socket.id);
    if (roomPlayer) {
      roomPlayer.ready = true;
    }

    // Notify room
    io.to(player.roomCode).emit('room:updated', { room });

    // Check if all players ready
    if (room.players.every(p => p.ready)) {
      // Start countdown
      room.gameState = 'countdown';
      io.to(player.roomCode).emit('game:countdown', { room });

      // After 3 seconds, start game
      setTimeout(() => {
        room.gameState = 'playing';
        room.startTime = Date.now();
        io.to(player.roomCode).emit('game:start', { room });
      }, 3000);
    }
  });

  // Update player game state
  socket.on('player:update', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;

    const room = rooms.get(player.roomCode);
    if (!room || room.gameState !== 'playing') return;

    const roomPlayer = room.players.find(p => p.id === socket.id);
    if (roomPlayer) {
      roomPlayer.position = data.position;
      roomPlayer.progress = data.progress;
      roomPlayer.score = data.score;
      roomPlayer.combo = data.combo;
    }

    // Broadcast to all players in room
    io.to(player.roomCode).emit('game:update', {
      players: room.players
    });
  });

  // Player finished race
  socket.on('player:finished', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;

    const room = rooms.get(player.roomCode);
    if (!room || room.gameState !== 'playing') return;

    if (!room.winner) {
      room.winner = socket.id;
      room.gameState = 'finished';
      room.endTime = Date.now();
      room.raceTime = ((room.endTime - room.startTime) / 1000).toFixed(1);

      const winnerPlayer = room.players.find(p => p.id === socket.id);

      io.to(player.roomCode).emit('game:finished', {
        winner: {
          id: socket.id,
          name: player.name,
          score: winnerPlayer?.score || 0,
          time: room.raceTime
        },
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

      // Notify remaining players
      io.to(player.roomCode).emit('room:player-left', {
        playerId: socket.id,
        playerName: player.name,
        room
      });

      // Delete room if empty
      if (room.players.length === 0) {
        rooms.delete(player.roomCode);
        console.log(`Room ${player.roomCode} deleted`);
      }
    }

    socket.leave(player.roomCode);
    player.roomCode = null;
    player.inGame = false;
  });

  // Global chat message
  socket.on('chat:send', (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    const timestamp = new Date().toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit'
    });

    // Broadcast message to all connected players
    io.emit('chat:message', {
      username: data.username || player.name,
      message: data.message,
      timestamp: timestamp
    });

    console.log(`[CHAT] ${player.name}: ${data.message}`);
  });

  // Player disconnects
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

    // Remove from waiting list
    const waitingIndex = waitingPlayers.indexOf(socket.id);
    if (waitingIndex > -1) {
      waitingPlayers.splice(waitingIndex, 1);
    }

    players.delete(socket.id);

    io.emit('players:online', {
      count: players.size,
      players: getOnlinePlayers()
    });

    console.log(`Player ${socket.id} disconnected. Total players: ${players.size}`);
  });
});

// API Routes
app.get('/api/players', (req, res) => {
  res.json({
    count: players.size,
    players: getOnlinePlayers()
  });
});

app.get('/api/rooms', (req, res) => {
  res.json({
    rooms: Array.from(rooms.values())
  });
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    players: players.size,
    rooms: rooms.size
  });
});

// Serve landing page as default
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'landing.html'));
});

// Serve game page
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
