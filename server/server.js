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
    socketId: p.socketId,
    name: p.name,
    status: p.inGame ? 'in-game' : 'online'
  }));
}

// --- SOCKET CONNECTION HANDLER ---
io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  // --- SYNC PATCH ---
  socket.on('room:sync:request', ({ roomCode }) => {
    console.log(`[SYNC] Player ${socket.id} requesting sync for room ${roomCode}`);
    const room = rooms.get(roomCode);
    if (room) {
      console.log(`[SYNC] Room ${roomCode} found. Players: ${room.players.length}, State: ${room.gameState}`);
      socket.emit('room:sync', { room });
    } else {
      console.error(`[SYNC] Room ${roomCode} NOT FOUND. Active rooms:`, Array.from(rooms.keys()).join(', ') || 'None');
      socket.emit('room:error', { message: 'Room not found' });
    }
  });
  // --- END PATCH ---

  // Player registers with username
  socket.on('player:register', (data) => {
    const playerData = {
      socketId: socket.id,
      name: data.name,
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

  // Update player name
  socket.on('player:update-name', (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    const oldName = player.name;
    player.name = data.name;

    console.log(`Player ${oldName} changed name to ${data.name}`);

    // Update name in any room they're in
    if (player.roomCode) {
      const room = rooms.get(player.roomCode);
      if (room) {
        const rp = room.players.find(p => p.socketId === socket.id);
        if (rp) {
          rp.name = data.name;
          io.to(player.roomCode).emit('room:updated', { room, playerCount: room.players.length });
        }
      }
    }

    // Broadcast updated player list
    io.emit('players:online', {
      count: players.size,
      players: getOnlinePlayers()
    });
  });

  // Create a new room
  socket.on('room:create', (data) => {
    const player = players.get(socket.id);
    if (!player) {
      socket.emit('room:error', { message: 'Player not registered' });
      return;
    }

    const roomCode = generateRoomCode();
    const roomName = data?.roomName || `${player.name}'s Room`;

    const room = {
      code: roomCode,
      name: roomName,
      host: socket.id,
      players: [{
        socketId: socket.id,
        name: player.name,
        position: 0,
        progress: 0,
        score: 0,
        combo: 0,
        ready: false
      }],
      gameState: 'waiting',
      winner: null,
      createdAt: Date.now(),
      maxPlayers: data?.maxPlayers || 2,
      gameSettings: data?.gameSettings || {}
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    player.roomCode = roomCode;
    player.inGame = true;

    socket.emit('room:created', { roomCode, roomName, room });
    console.log(`Room "${roomName}" (${roomCode}) created by ${player.name}`);
  });

  // Join room
  socket.on('room:join', (data) => {
    const { roomCode } = data;
    console.log(`[JOIN] Player ${socket.id} attempting to join room ${roomCode}`);
    const room = rooms.get(roomCode);
    const player = players.get(socket.id);

    if (!player) {
      console.error(`[JOIN] Player ${socket.id} not registered`);
      return socket.emit('room:error', { message: 'Player not registered' });
    }
    if (!room) {
      console.error(`[JOIN] Room ${roomCode} not found. Active rooms:`, Array.from(rooms.keys()).join(', ') || 'None');
      return socket.emit('room:error', { message: 'Room not found' });
    }
    if (room.players.length >= 2) {
      console.error(`[JOIN] Room ${roomCode} is full`);
      return socket.emit('room:error', { message: 'Room is full' });
    }

    // Allow joining in waiting, in-game-lobby, or finished states
    const joinableStates = ['waiting', 'in-game-lobby', 'finished'];
    if (!joinableStates.includes(room.gameState)) {
      console.error(`[JOIN] Room ${roomCode} game already started. Current state: ${room.gameState}`);
      return socket.emit('room:error', { message: 'Game in progress. Please wait for the race to finish.' });
    }

    console.log(`[JOIN] Player ${player.name} successfully joining room ${roomCode}`);


    room.players.push({
      socketId: socket.id,
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
          { socketId: opponentId, name: opponent.name, position: 0, progress: 0, score: 0, combo: 0, ready: false },
          { socketId: socket.id, name: player.name, position: 0, progress: 0, score: 0, combo: 0, ready: false }
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

  // Player ready in lobby (for modes.html)
  socket.on('player:ready', () => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room) return;

    // Mark player as ready
    const rp = room.players.find(p => p.socketId === socket.id);
    if (rp) rp.ready = true;

    console.log(`[READY] ${player.name} is ready in room ${room.code}`);

    // Broadcast updated room state to all players
    io.to(player.roomCode).emit('room:updated', { room, playerCount: room.players.length });

    // Check if ALL players are ready
    const allReady = room.players.length >= 2 && room.players.every(p => p.ready);

    if (allReady && room.gameState === 'waiting') {
      console.log(`[LOBBY] All players ready in room ${room.code}. Transitioning to in-game-lobby...`);

      // Change state to in-game-lobby (players will redirect to game.html)
      room.gameState = 'in-game-lobby';

      // Reset ready flags for in-game ready check
      room.players.forEach(p => p.gameReady = false);

      // Emit countdown event (will redirect to game)
      io.to(player.roomCode).emit('game:countdown', { room });

      // Wait 4 seconds (3-2-1-GO), then transition to game
      setTimeout(() => {
        io.to(player.roomCode).emit('game:start', { room });
        console.log(`[LOBBY] Players redirected to game in room ${room.code}`);
      }, 4000);
    } else {
      console.log(`[WAITING] Room ${room.code}: ${room.players.filter(p => p.ready).length}/${room.players.length} players ready`);
    }
  });

  // Player ready in game (for game.html)
  socket.on('player:game-ready', () => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room || room.gameState !== 'in-game-lobby') return;

    // Mark player as game-ready
    const rp = room.players.find(p => p.socketId === socket.id);
    if (rp) rp.gameReady = true;

    console.log(`[GAME-READY] ${player.name} is ready in game for room ${room.code}`);

    // Broadcast updated room state to all players in game
    io.to(player.roomCode).emit('game:players-update', {
      players: room.players.map(p => ({
        socketId: p.socketId,
        name: p.name,
        gameReady: p.gameReady || false
      }))
    });

    // Check if ALL players are game-ready
    const allGameReady = room.players.length >= 2 && room.players.every(p => p.gameReady);

    if (allGameReady) {
      console.log(`[GAME-READY] All players ready in game for room ${room.code}. Starting sync verification...`);

      // Verify all players are connected
      const connectedPlayers = room.players.filter(p => {
        const socket = io.sockets.sockets.get(p.socketId);
        return socket && socket.connected;
      });

      if (connectedPlayers.length === room.players.length) {
        console.log(`[SYNC-CHECK] All ${room.players.length} players connected and synced. Starting countdown...`);

        room.gameState = 'countdown';

        // Emit verified countdown event
        io.to(player.roomCode).emit('game:verified-countdown', { room });

        // Wait 4 seconds (3-2-1-GO), then start race
        setTimeout(() => {
          room.gameState = 'playing';
          room.startTime = Date.now();
          io.to(player.roomCode).emit('game:race-start', { room });
          console.log(`[RACE] Race started in room ${room.code}`);
        }, 4000);
      } else {
        console.error(`[SYNC-CHECK] Player sync failed. ${connectedPlayers.length}/${room.players.length} connected`);
        io.to(player.roomCode).emit('game:sync-failed', {
          message: 'Player sync failed. Please ensure both players are connected.'
        });
      }
    } else {
      const readyCount = room.players.filter(p => p.gameReady).length;
      console.log(`[GAME-WAITING] Room ${room.code}: ${readyCount}/${room.players.length} players game-ready`);
    }
  });

  // Multiplayer sync — live movement updates (IMPROVED)
  socket.on('player:update', (data) => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (!room || room.gameState !== 'playing') return;

    const rp = room.players.find(p => p.socketId === socket.id);
    if (rp) {
      rp.position = data.positionX ?? data.position ?? 0;
      rp.progress = data.progress ?? 0;
      rp.score = data.score ?? 0;
      rp.combo = data.combo ?? 0;
      rp.animTime = data.animTime ?? 0;
      rp.velocity = data.velocity ?? 0;
    }

    // Send updated state to ALL players in room (including sender for echo confirmation)
    io.to(player.roomCode).emit('game:update', {
      players: room.players.map(p => ({
        socketId: p.socketId,
        name: p.name,
        position: p.position,
        progress: p.progress,
        score: p.score,
        combo: p.combo,
        animTime: p.animTime,
        velocity: p.velocity
      })),
      gameState: room.gameState
    });
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
      const wp = room.players.find(p => p.socketId === socket.id);
      io.to(player.roomCode).emit('game:finished', {
        winner: { socketId: socket.id, name: player.name, score: wp?.score || 0, time: room.raceTime },
        room
      });
      console.log(`${player.name} won in room ${player.roomCode}`);

      // Reset room to in-game-lobby state after 10 seconds for rematch
      setTimeout(() => {
        if (room && rooms.has(player.roomCode)) {
          console.log(`[REMATCH] Resetting room ${player.roomCode} for rematch...`);
          room.gameState = 'in-game-lobby'; // Go to in-game-lobby for seamless rematch
          room.winner = null;
          room.startTime = null;
          room.endTime = null;
          room.raceTime = null;

          // Reset all player stats
          room.players.forEach(p => {
            p.position = 0;
            p.progress = 0;
            p.score = 0;
            p.combo = 0;
            p.ready = false;
            p.gameReady = false; // Reset game-ready status
          });

          // Notify all players room is ready for rematch
          io.to(player.roomCode).emit('room:reset', { room });
          console.log(`[REMATCH] Room ${player.roomCode} reset to in-game-lobby state`);
        }
      }, 10000);
    }
  });

  // Leave room
  socket.on('room:leave', () => {
    const player = players.get(socket.id);
    if (!player || !player.roomCode) return;
    const room = rooms.get(player.roomCode);
    if (room) {
      room.players = room.players.filter(p => p.socketId !== socket.id);
      io.to(player.roomCode).emit('room:player-left', {
        socketId: socket.id,
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
        room.players = room.players.filter(p => p.socketId !== socket.id);
        io.to(player.roomCode).emit('room:player-left', {
          socketId: socket.id,
          playerName: player.name,
          room
        });
        if (room.players.length === 0) {
          // Keep room alive for 30 seconds to allow host to reconnect
          console.log(`Room ${player.roomCode} is now empty. Will delete in 30 seconds if no one rejoins...`);
          room.emptyAt = Date.now();
          setTimeout(() => {
            const stillEmpty = room.players.length === 0;
            if (stillEmpty && rooms.has(player.roomCode)) {
              rooms.delete(player.roomCode);
              console.log(`Room ${player.roomCode} deleted (empty timeout)`);
            }
          }, 30000);
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

app.get('/api/room/:code', (req, res) => {
  const room = rooms.get(req.params.code);
  if (!room) {
    return res.status(404).json({ error: 'Room not found' });
  }
  res.json({ room });
});

app.get('/api/server-info', (req, res) => {
  const baseUrl = req.get('host');
  const protocol = req.protocol;
  res.json({
    baseUrl: `${protocol}://${baseUrl}`,
    playersOnline: players.size,
    activeRooms: rooms.size
  });
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
