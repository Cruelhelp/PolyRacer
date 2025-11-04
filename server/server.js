// ================================
// POLY RACER - MULTIPLAYER SERVER
// Clean Rewrite for Proper Sync
// ================================

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
  },
  // Enable connection state recovery
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000, // 2 minutes
    skipMiddlewares: true,
  }
});

const port = process.env.PORT || 3001;

app.use(express.json());
app.use(express.static(path.join(__dirname, '..')));

// ===== GAME STATE =====
const rooms = new Map();
const players = new Map();
const waitingPlayers = [];

// ===== HELPER FUNCTIONS =====
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
    socketId: p.socketId,
    name: p.name,
    status: p.inGame ? 'in-game' : 'online'
  }));
}

// ===== SOCKET HANDLERS =====
io.on('connection', (socket) => {
  console.log(`[CONNECT] Player ${socket.id} connected`);

  // --- PLAYER REGISTRATION ---
  socket.on('player:register', (data) => {
    const playerData = {
      socketId: socket.id,
      name: data.name || `Player${Math.floor(Math.random() * 10000)}`,
      inGame: false,
      roomCode: null
    };

    players.set(socket.id, playerData);
    socket.emit('player:registered', { playerId: socket.id, playerData });
    io.emit('players:online', { count: players.size, players: getOnlinePlayers() });

    console.log(`[REGISTER] ${playerData.name} (${socket.id})`);
  });

  // --- UPDATE PLAYER NAME ---
  socket.on('player:update-name', (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    const oldName = player.name;
    player.name = data.name;
    console.log(`[NAME] ${oldName} → ${data.name}`);

    if (player.roomCode) {
      const room = rooms.get(player.roomCode);
      if (room) {
        const rp = room.players.find(p => p.socketId === socket.id);
        if (rp) {
          rp.name = data.name;
          io.to(player.roomCode).emit('room:updated', { room });
        }
      }
    }

    io.emit('players:online', { count: players.size, players: getOnlinePlayers() });
  });

  // --- CREATE ROOM ---
  socket.on('room:create', (data) => {
    const player = players.get(socket.id);
    if (!player) return socket.emit('room:error', { message: 'Player not registered' });

    const roomCode = generateRoomCode();
    const roomName = data?.roomName || `${player.name}'s Room`;

    const room = {
      code: roomCode,
      name: roomName,
      host: socket.id,
      players: [],
      gameState: 'waiting', // waiting → ready → countdown → playing → finished
      startTime: null,
      winner: null,
      createdAt: Date.now(),
      maxPlayers: 2
    };

    rooms.set(roomCode, room);
    console.log(`[CREATE] Room ${roomCode} created by ${player.name}`);

    // Auto-join creator
    handlePlayerJoin(socket.id, roomCode);
  });

  // --- JOIN ROOM ---
  socket.on('room:join', (data) => {
    handlePlayerJoin(socket.id, data.roomCode);
  });

  // Helper function for joining
  function handlePlayerJoin(socketId, roomCode) {
    const player = players.get(socketId);
    const room = rooms.get(roomCode);

    if (!player) {
      return io.to(socketId).emit('room:error', { message: 'Player not registered' });
    }
    if (!room) {
      console.error(`[JOIN] Room ${roomCode} not found`);
      return io.to(socketId).emit('room:error', { message: 'Room not found' });
    }

    // Cancel deletion timeout if room was scheduled for deletion
    if (room.deleteTimeout) {
      clearTimeout(room.deleteTimeout);
      room.deleteTimeout = null;
      console.log(`[JOIN] Cancelled deletion of room ${roomCode}`);
    }

    // Check if already in room
    const alreadyInRoom = room.players.some(p => p.socketId === socketId);
    if (alreadyInRoom) {
      console.log(`[JOIN] ${player.name} already in room ${roomCode}`);
      io.to(socketId).emit('room:joined', { roomCode, room, playerIndex: room.players.findIndex(p => p.socketId === socketId) });
      return;
    }

    // Check capacity
    if (room.players.length >= room.maxPlayers) {
      return io.to(socketId).emit('room:error', { message: 'Room is full' });
    }

    // Check state - can only join in waiting or ready states
    if (!['waiting', 'ready', 'finished'].includes(room.gameState)) {
      return io.to(socketId).emit('room:error', { message: 'Game in progress' });
    }

    // Add player to room
    const playerIndex = room.players.length;
    room.players.push({
      socketId: socketId,
      name: player.name,
      playerIndex: playerIndex, // 0 or 1
      ready: false,
      position: 0,
      progress: 0,
      score: 0,
      combo: 0
    });

    io.sockets.sockets.get(socketId)?.join(roomCode);
    player.roomCode = roomCode;
    player.inGame = true;

    console.log(`[JOIN] ${player.name} joined room ${roomCode} as player ${playerIndex}`);

    // Send join confirmation with player index
    io.to(socketId).emit('room:joined', { roomCode, room, playerIndex });

    // Notify all players in room
    io.to(roomCode).emit('room:updated', { room });
  }

  // --- PLAYER READY (SINGLE SYSTEM) ---
  socket.on('player:ready', () => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;

    const room = rooms.get(player.roomCode);
    if (!room) return;

    const rp = room.players.find(p => p.socketId === socket.id);
    if (!rp) return;

    // Mark player as ready (allow re-marking)
    rp.ready = true;
    console.log(`[READY] ${player.name} is ready in room ${room.code}`);

    // Broadcast updated ready status
    io.to(player.roomCode).emit('room:updated', { room });

    // Check if all players ready (removed strict gameState check)
    const allReady = room.players.length >= 2 && room.players.every(p => p.ready);

    // Start game if all ready and not already started
    if (allReady && (room.gameState === 'waiting' || room.gameState === 'ready')) {
      // Prevent double-start
      if (room.gameState === 'countdown' || room.gameState === 'playing') return;

      console.log(`[START] All players ready in room ${room.code}. Starting countdown...`);

      room.gameState = 'countdown';

      // Send countdown start with server timestamp for perfect sync
      const countdownStartTime = Date.now();
      const raceStartTime = countdownStartTime + 4000; // 4 second countdown

      io.to(player.roomCode).emit('game:countdown-start', {
        room,
        countdownStartTime,
        raceStartTime
      });

      // Start race after 4 seconds
      setTimeout(() => {
        room.gameState = 'playing';
        room.startTime = raceStartTime;

        io.to(player.roomCode).emit('game:race-start', {
          room,
          serverTime: Date.now()
        });

        console.log(`[RACE] Race started in room ${room.code}`);
      }, 4000);
    }
  });

  // --- PLAYER UNREADY ---
  socket.on('player:unready', () => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;

    const room = rooms.get(player.roomCode);
    if (!room || room.gameState !== 'waiting') return;

    const rp = room.players.find(p => p.socketId === socket.id);
    if (rp) {
      rp.ready = false;
      console.log(`[UNREADY] ${player.name} unreadied in room ${room.code}`);
      io.to(player.roomCode).emit('room:updated', { room });
    }
  });

  // --- POSITION UPDATE (NO ECHO TO SENDER) ---
  socket.on('player:update', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;

    const room = rooms.get(player.roomCode);
    if (!room || room.gameState !== 'playing') return;

    const rp = room.players.find(p => p.socketId === socket.id);
    if (rp) {
      rp.position = data.position ?? 0;
      rp.progress = data.progress ?? 0;
      rp.score = data.score ?? 0;
      rp.combo = data.combo ?? 0;
      rp.animTime = data.animTime ?? 0;
      rp.velocity = data.velocity ?? 0;
    }

    // Broadcast to OTHER players only (no echo)
    socket.to(player.roomCode).emit('game:update', {
      socketId: socket.id,
      playerIndex: rp.playerIndex,
      position: rp.position,
      progress: rp.progress,
      score: rp.score,
      combo: rp.combo,
      animTime: rp.animTime,
      velocity: rp.velocity
    });
  });

  // --- PLAYER FINISHED ---
  socket.on('player:finished', () => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;

    const room = rooms.get(player.roomCode);
    if (!room || room.gameState !== 'playing') return;

    if (!room.winner) {
      room.winner = socket.id;
      room.gameState = 'finished';
      room.endTime = Date.now();
      room.raceTime = ((room.endTime - room.startTime) / 1000).toFixed(2);

      const wp = room.players.find(p => p.socketId === socket.id);

      io.to(player.roomCode).emit('game:finished', {
        winner: {
          socketId: socket.id,
          name: player.name,
          playerIndex: wp.playerIndex,
          score: wp.score || 0,
          time: room.raceTime
        },
        room
      });

      console.log(`[WIN] ${player.name} won in room ${player.roomCode} (${room.raceTime}s)`);

      // Auto-reset for rematch after 5 seconds
      setTimeout(() => {
        if (room && rooms.has(player.roomCode)) {
          console.log(`[REMATCH] Resetting room ${player.roomCode}`);
          room.gameState = 'waiting';
          room.winner = null;
          room.startTime = null;
          room.endTime = null;
          room.raceTime = null;

          room.players.forEach(p => {
            p.ready = false;
            p.position = 0;
            p.progress = 0;
            p.score = 0;
            p.combo = 0;
          });

          io.to(player.roomCode).emit('room:reset', { room });
        }
      }, 5000);
    }
  });

  // --- LEAVE ROOM ---
  socket.on('room:leave', () => {
    handlePlayerLeave(socket.id);
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    handlePlayerLeave(socket.id);
    players.delete(socket.id);
    io.emit('players:online', { count: players.size, players: getOnlinePlayers() });
  });

  // Helper for leaving rooms
  function handlePlayerLeave(socketId) {
    const player = players.get(socketId);
    if (!player || !player.roomCode) return;

    const room = rooms.get(player.roomCode);
    if (room) {
      room.players = room.players.filter(p => p.socketId !== socketId);

      io.to(player.roomCode).emit('room:player-left', {
        socketId,
        playerName: player.name,
        room
      });

      if (room.players.length === 0) {
        // Don't delete immediately - wait 60 seconds for reconnection
        console.log(`[EMPTY] Room ${player.roomCode} is empty, scheduling deletion in 60s...`);
        room.deleteTimeout = setTimeout(() => {
          if (rooms.has(player.roomCode) && room.players.length === 0) {
            rooms.delete(player.roomCode);
            console.log(`[DELETE] Room ${player.roomCode} deleted (timeout)`);
          }
        }, 60000); // 60 seconds grace period
      } else {
        console.log(`[LEAVE] ${player.name} left room ${player.roomCode}`);
      }
    }

    io.sockets.sockets.get(socketId)?.leave(player.roomCode);
    player.roomCode = null;
    player.inGame = false;
  }

  // --- CHAT ---
  socket.on('chat:send', (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    const timestamp = new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
    io.emit('chat:message', {
      username: data.username || player.name,
      message: data.message,
      timestamp
    });
    console.log(`[CHAT] ${player.name}: ${data.message}`);
  });
});

// ===== API ROUTES =====
app.get('/api/players', (req, res) => {
  res.json({ count: players.size, players: getOnlinePlayers() });
});

app.get('/api/rooms', (req, res) => {
  res.json({ rooms: Array.from(rooms.values()) });
});

app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) return res.status(404).json({ error: 'Room not found' });
  res.json({ room });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', players: players.size, rooms: rooms.size });
});

app.get('/leaderboard', (req, res) => {
  // TODO: Implement actual leaderboard with database
  // For now, return empty leaderboard
  res.json({
    leaderboard: [],
    message: 'Leaderboard coming soon! Play matches to be featured here.'
  });
});

// ===== SERVE PAGES =====
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'modes.html'));
});

app.get('/game.html', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'game.html'));
});

app.get('/modes', (req, res) => {
