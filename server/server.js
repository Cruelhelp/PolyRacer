require('dotenv').config();
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');

// Initialize Express app
const app = express();
const server = http.createServer(app);

// Initialize Socket.IO with CORS
const io = socketIO(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const port = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(express.static(path.join(__dirname, '../'))); // Serve static files

// In-memory storage
const rooms = new Map();
const players = new Map();

// Mock leaderboard (replace with database later)
const leaderboard = [
  { username: 'SpeedDemon', wins: 127, wpm: 98 },
  { username: 'TypeMaster', wins: 103, wpm: 92 },
  { username: 'QuickFingers', wins: 89, wpm: 88 },
  { username: 'NeonRacer', wins: 76, wpm: 85 },
  { username: 'KeyboardKing', wins: 68, wpm: 82 },
  { username: 'FlashTyper', wins: 54, wpm: 79 },
  { username: 'LetterLegend', wins: 47, wpm: 76 },
  { username: 'SwiftKeys', wins: 39, wpm: 73 },
  { username: 'RapidRacer', wins: 31, wpm: 70 },
  { username: 'TurboTypist', wins: 24, wpm: 68 }
];

// API Routes for health check and leaderboard
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    players: players.size,
    rooms: rooms.size
  });
});

app.get('/leaderboard', (req, res) => {
  res.json({
    leaderboard: leaderboard
  });
});

// Generate unique room code
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return rooms.has(code) ? generateRoomCode() : code;
}

// Socket.IO Connection Handler
io.on('connection', (socket) => {
  console.log(`[CONNECT] Player connected: ${socket.id}`);

  // Player Registration
  socket.on('player:register', (data) => {
    const player = {
      id: socket.id,
      name: data.name || `Player${Math.floor(Math.random() * 10000)}`,
      status: 'online',
      wins: 0,
      gamesPlayed: 0,
      currentRoom: null
    };
    
    players.set(socket.id, player);
    
    socket.emit('player:registered', {
      playerId: socket.id,
      player: player
    });

    console.log(`[REGISTER] ${player.name} (${socket.id})`);
    broadcastPlayerList();
  });

  // Get online players
  socket.on('players:get', () => {
    const playerList = Array.from(players.values());
    socket.emit('players:online', {
      count: playerList.length,
      players: playerList
    });
  });

  // Get room list
  socket.on('rooms:get', () => {
    const roomList = Array.from(rooms.values())
      .filter(room => room.status === 'waiting')
      .map(room => ({
        code: room.code,
        name: room.name,
        players: room.players.length,
        maxPlayers: room.maxPlayers,
        status: room.status
      }));
    
    socket.emit('rooms:list', { rooms: roomList });
  });

  // Create Room
  socket.on('room:create', (data) => {
    const player = players.get(socket.id);
    
    if (!player) {
      socket.emit('room:error', { message: 'Player not registered' });
      return;
    }

    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      name: data.roomName || `${player.name}'s Room`,
      host: socket.id,
      players: [player],
      maxPlayers: 4,
      status: 'waiting', // waiting, countdown, racing, finished
      typingMode: data.typingMode || 'letters',
      gameState: {
        countdown: 3,
        startTime: null,
        playerPositions: {},
        raceDistance: 800
      }
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);
    player.currentRoom = roomCode;
    player.status = 'in-game';
    
    socket.emit('room:created', {
      roomCode: roomCode,
      room: room
    });

    console.log(`[ROOM CREATE] ${roomCode} by ${player.name}`);
    broadcastRoomList();
    broadcastPlayerList();
  });

  // Join Room by Code
  socket.on('room:join', (data) => {
    const room = rooms.get(data.roomCode);
    const player = players.get(socket.id);
    
    if (!room) {
      socket.emit('room:error', { message: 'Room not found' });
      return;
    }

    if (!player) {
      socket.emit('room:error', { message: 'Player not registered' });
      return;
    }

    if (room.players.length >= room.maxPlayers) {
      socket.emit('room:error', { message: 'Room is full' });
      return;
    }

    if (room.status !== 'waiting') {
      socket.emit('room:error', { message: 'Game already in progress' });
      return;
    }

    // Check if already in room
    if (!room.players.find(p => p.id === socket.id)) {
      room.players.push(player);
    }
    
    socket.join(data.roomCode);
    player.currentRoom = data.roomCode;
    player.status = 'in-game';
    
    socket.emit('room:joined', {
      roomCode: data.roomCode,
      room: room
    });

    // Notify other players
    socket.to(data.roomCode).emit('room:player_joined', {
      player: player,
      room: room
    });

    console.log(`[ROOM JOIN] ${player.name} → ${data.roomCode}`);
    broadcastRoomList();
    broadcastPlayerList();
  });

  // Leave Room
  socket.on('room:leave', (data) => {
    leaveRoom(socket);
  });

  // Start Game (Host only)
  socket.on('game:start', (data) => {
    const room = rooms.get(data.roomCode);
    
    if (!room) {
      socket.emit('game:error', { message: 'Room not found' });
      return;
    }
    
    if (room.host !== socket.id) {
      socket.emit('game:error', { message: 'Only host can start game' });
      return;
    }

    if (room.status !== 'waiting') {
      socket.emit('game:error', { message: 'Game already started' });
      return;
    }

    room.status = 'countdown';
    const countdownStartTime = Date.now();
    
    // Emit synchronized countdown to all players in room
    io.to(data.roomCode).emit('game:countdown_start', {
      countdown: 3,
      startTime: countdownStartTime
    });

    console.log(`[GAME START] ${data.roomCode} countdown started`);

    // Start race after countdown
    setTimeout(() => {
      if (room.status === 'countdown') {
        room.status = 'racing';
        room.gameState.startTime = Date.now();
        
        io.to(data.roomCode).emit('game:race_start', {
          startTime: room.gameState.startTime
        });
        
        console.log(`[GAME RACING] ${data.roomCode} race started`);
      }
    }, 3000);
  });

  // Game State Update
  socket.on('game:update', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room || room.status !== 'racing') return;

    // Update player position in room
    room.gameState.playerPositions[socket.id] = {
      x: data.position?.x || 0,
      progress: data.progress || 0,
      combo: data.combo || 0,
      score: data.score || 0
    };

    // Broadcast to other players in room (not sender)
    socket.to(data.roomCode).emit('game:player_update', {
      playerId: socket.id,
      position: data.position,
      progress: data.progress,
      combo: data.combo,
      score: data.score
    });
  });

  // Player Finished Race
  socket.on('game:finish', (data) => {
    const room = rooms.get(data.roomCode);
    if (!room) return;

    const player = players.get(socket.id);
    if (!player) return;

    // Only accept first finish
    if (!room.winner) {
      room.winner = socket.id;
      room.status = 'finished';

      // Update player stats
      player.wins = (player.wins || 0) + 1;
      player.gamesPlayed = (player.gamesPlayed || 0) + 1;

      // Notify all players in room
      io.to(data.roomCode).emit('game:winner', {
        winnerId: socket.id,
        winnerName: player.name,
        stats: data.stats || {},
        finalTime: data.time
      });

      console.log(`[GAME WIN] ${player.name} won in ${data.roomCode}`);

      // Auto-reset room after 10 seconds
      setTimeout(() => {
        if (rooms.has(data.roomCode)) {
          resetRoom(data.roomCode);
        }
      }, 10000);
    }
  });

  // Chat Message
  socket.on('chat:send', (data) => {
    const player = players.get(socket.id);
    if (!player) return;

    const message = {
      username: player.name,
      message: data.message.substring(0, 200), // Limit message length
      timestamp: new Date().toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit' 
      })
    };

    // Broadcast to all players
    io.emit('chat:message', message);
  });

  // Challenge System
  socket.on('challenge:send', (data) => {
    const challenger = players.get(socket.id);
    const target = players.get(data.targetId);
    
    if (!challenger || !target) {
      socket.emit('challenge:error', { message: 'Player not found' });
      return;
    }

    if (target.status === 'in-game') {
      socket.emit('challenge:error', { message: 'Player is already in a game' });
      return;
    }

    io.to(data.targetId).emit('challenge:received', {
      challengerId: socket.id,
      challengerName: challenger.name
    });

    socket.emit('challenge:sent', {
      targetId: data.targetId,
      targetName: target.name
    });

    console.log(`[CHALLENGE] ${challenger.name} → ${target.name}`);
  });

  socket.on('challenge:accept', (data) => {
    const challenger = players.get(data.challengerId);
    const accepter = players.get(socket.id);
    
    if (!challenger || !accepter) {
      socket.emit('challenge:error', { message: 'Player not found' });
      return;
    }

    // Create 1v1 room
    const roomCode = generateRoomCode();
    const room = {
      code: roomCode,
      name: `${challenger.name} vs ${accepter.name}`,
      host: data.challengerId,
      players: [challenger, accepter],
      maxPlayers: 2,
      status: 'waiting',
      typingMode: 'letters',
      gameState: {
        countdown: 3,
        startTime: null,
        playerPositions: {},
        raceDistance: 800
      }
    };

    rooms.set(roomCode, room);
    
    // Join both players
    const challengerSocket = io.sockets.sockets.get(data.challengerId);
    if (challengerSocket) {
      challengerSocket.join(roomCode);
      challenger.currentRoom = roomCode;
      challenger.status = 'in-game';
    }
    
    socket.join(roomCode);
    accepter.currentRoom = roomCode;
    accepter.status = 'in-game';

    // Notify both players
    io.to(data.challengerId).emit('challenge:accepted', { 
      roomCode,
      room 
    });
    
    socket.emit('challenge:accepted', { 
      roomCode,
      room 
    });

    console.log(`[1v1 ROOM] ${roomCode} created for challenge`);
    broadcastPlayerList();
  });

  socket.on('challenge:decline', (data) => {
    const decliner = players.get(socket.id);
    if (!decliner) return;

    io.to(data.challengerId).emit('challenge:declined', {
      declinerId: socket.id,
      declinerName: decliner.name
    });

    console.log(`[CHALLENGE DECLINED] ${decliner.name} declined`);
  });

  // Disconnect Handler
  socket.on('disconnect', () => {
    console.log(`[DISCONNECT] ${socket.id}`);
    
    const player = players.get(socket.id);
    if (player?.currentRoom) {
      leaveRoom(socket);
    }

    players.delete(socket.id);
    broadcastPlayerList();
  });
});

// Helper Functions
function leaveRoom(socket) {
  const player = players.get(socket.id);
  if (!player || !player.currentRoom) return;

  const room = rooms.get(player.currentRoom);
  if (!room) return;

  // Remove player from room
  room.players = room.players.filter(p => p.id !== socket.id);
  socket.leave(player.currentRoom);

  // If room is empty, delete it
  if (room.players.length === 0) {
    rooms.delete(player.currentRoom);
    console.log(`[ROOM DELETED] ${player.currentRoom} (empty)`);
  } else {
    // If host left, assign new host
    if (room.host === socket.id && room.players.length > 0) {
      room.host = room.players[0].id;
    }

    // Notify remaining players
    io.to(player.currentRoom).emit('room:player_left', {
      playerId: socket.id,
      playerName: player.name,
      room: room
    });
  }

  player.currentRoom = null;
  player.status = 'online';
  
  broadcastRoomList();
  broadcastPlayerList();
}

function resetRoom(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.status = 'waiting';
  room.winner = null;
  room.gameState = {
    countdown: 3,
    startTime: null,
    playerPositions: {},
    raceDistance: 800
  };

  io.to(roomCode).emit('room:reset', { room });
  console.log(`[ROOM RESET] ${roomCode}`);
  broadcastRoomList();
}

function broadcastPlayerList() {
  const playerList = Array.from(players.values());
  io.emit('players:online', {
    count: playerList.length,
    players: playerList
  });
}

function broadcastRoomList() {
  const roomList = Array.from(rooms.values())
    .filter(room => room.status === 'waiting')
    .map(room => ({
      code: room.code,
      name: room.name,
      players: room.players.length,
      maxPlayers: room.maxPlayers,
      status: room.status
    }));
  
  io.emit('rooms:list', { rooms: roomList });
}

// Start Server
server.listen(port, () => {
  console.log(`🎮 Poly Race Server running on port ${port}`);
  console.log(`📡 Socket.IO enabled`);
});

// Graceful Shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down server...');
  io.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});
