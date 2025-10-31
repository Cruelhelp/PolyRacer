// ================================
// POLY RACER - CLIENT MULTIPLAYER
// Clean Rewrite for Proper Sync
// ================================

const urlParams = new URLSearchParams(window.location.search);
const mode = urlParams.get("mode");

if (mode === "online") {
  console.log('[MP] Initializing multiplayer client...');

  // Connection setup
  const serverUrl = window.location.origin;
  const socket = io(serverUrl, {
    transports: ['websocket', 'polling'],
    reconnection: true,
    reconnectionAttempts: 5
  });

  window.multiplayerSocket = socket;

  const roomCode = urlParams.get("room");
  const playerName = localStorage.getItem("username") || `Player${Math.floor(Math.random() * 10000)}`;

  let mySocketId = null;
  let myPlayerIndex = null; // Will be 0 or 1
  let opponentPlayerIndex = null;
  let roomData = null;

  console.log(`[MP] Connecting to room ${roomCode} as ${playerName}`);

  // ===== CONNECTION =====
  socket.on("connect", () => {
    console.log("[MP] Connected:", socket.id);
    mySocketId = socket.id;

    // Register and join room
    socket.emit("player:register", { name: playerName });
    socket.emit("room:join", { roomCode });
  });

  // ===== ROOM JOINED =====
  socket.on("room:joined", (data) => {
    console.log("[MP] Joined room:", data);
    roomData = data.room;
    myPlayerIndex = data.playerIndex; // Server tells us our index (0 or 1)
    opponentPlayerIndex = myPlayerIndex === 0 ? 1 : 0;

    console.log(`[MP] I am player ${myPlayerIndex}`);

    // Update scene with correct player data
    const scene = game?.current_scene;
    if (scene && scene.players) {
      // Find my data and opponent data from room
      const myData = roomData.players[myPlayerIndex];
      const opponentData = roomData.players[opponentPlayerIndex];

      // Local player is ALWAYS scene.players[0]
      if (scene.players[0] && myData) {
        scene.players[0].username = myData.name;
        scene.players[0].color = myPlayerIndex === 0 ? '#00ffff' : '#ff00ff';
        console.log(`[MP] Local player: ${myData.name} (${scene.players[0].color})`);
      }

      // Opponent is ALWAYS scene.players[1]
      if (scene.players[1] && opponentData) {
        scene.players[1].username = opponentData.name;
        scene.players[1].color = opponentPlayerIndex === 0 ? '#00ffff' : '#ff00ff';
        console.log(`[MP] Opponent: ${opponentData.name} (${scene.players[1].color})`);
      }
    }

    // Show waiting room
    showWaitingRoom(roomData);
  });

  // ===== WAITING ROOM UI =====
  function showWaitingRoom(room) {
    const waitingRoom = document.getElementById('online-waiting-room');
    const inviteLinkInput = document.getElementById('game-invite-link');
    const copyBtn = document.getElementById('copy-game-link-btn');
    const readyBtn = document.getElementById('im-ready-btn');
    const readyHint = document.getElementById('ready-hint');

    // Set invite link
    const inviteLink = `https://polyracer-production.up.railway.app/game.html?mode=online&room=${roomCode}`;
    inviteLinkInput.value = inviteLink;

    // Copy button handler
    let copyHandlerAdded = false;
    if (!copyHandlerAdded) {
      copyBtn.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(inviteLink);
          const origHTML = copyBtn.innerHTML;
          copyBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg> COPIED!';
          copyBtn.style.borderColor = '#00ff88';
          copyBtn.style.color = '#00ff88';
          setTimeout(() => {
            copyBtn.innerHTML = origHTML;
            copyBtn.style.borderColor = '';
            copyBtn.style.color = '';
          }, 2000);
        } catch (err) {
          console.error('[MP] Failed to copy:', err);
        }
      });
      copyHandlerAdded = true;
    }

    // Update player status
    updatePlayerStatus(room);

    // Show waiting room
    waitingRoom.classList.add('active');

    // Ready button handler
    let readyHandlerAdded = false;
    if (!readyHandlerAdded) {
      readyBtn.addEventListener('click', () => {
        console.log('[MP] Clicked READY');
        socket.emit('player:ready');
        readyBtn.disabled = true;
        readyBtn.innerHTML = '<span class="btn-text">WAITING FOR OPPONENT...</span>';
        readyHint.textContent = 'Waiting for other player...';
      });
      readyHandlerAdded = true;
    }
  }

  function updatePlayerStatus(room) {
    if (!room || !room.players) return;

    const player1Status = document.getElementById('player1-status');
    const player2Status = document.getElementById('player2-status');
    const player1Name = document.getElementById('player1-name');
    const player2Name = document.getElementById('player2-name');
    const player1Badge = document.getElementById('player1-badge');
    const player2Badge = document.getElementById('player2-badge');
    const readyBtn = document.getElementById('im-ready-btn');
    const readyHint = document.getElementById('ready-hint');

    if (room.players.length >= 1) {
      const p1 = room.players[0];
      player1Name.textContent = p1.name;
      player1Badge.textContent = p1.ready ? 'READY' : 'WAITING...';
      player1Badge.className = 'player-status-badge ' + (p1.ready ? 'ready' : 'waiting');
      if (p1.ready) player1Status.classList.add('ready');
      else player1Status.classList.remove('ready');
    }

    if (room.players.length >= 2) {
      const p2 = room.players[1];
      player2Name.textContent = p2.name;
      player2Badge.textContent = p2.ready ? 'READY' : 'WAITING...';
      player2Badge.className = 'player-status-badge ' + (p2.ready ? 'ready' : 'waiting');
      if (p2.ready) player2Status.classList.add('ready');
      else player2Status.classList.remove('ready');

      // Enable ready button
      if (!room.players[myPlayerIndex]?.ready) {
        readyBtn.disabled = false;
        readyHint.textContent = 'Click when ready to race!';
      }
    } else {
      player2Name.textContent = 'Waiting for player...';
      player2Badge.textContent = 'EMPTY';
      player2Badge.className = 'player-status-badge empty';
      player2Status.classList.remove('ready');

      readyBtn.disabled = true;
      readyHint.textContent = 'Waiting for opponent to join...';
    }
  }

  // ===== ROOM UPDATED =====
  socket.on("room:updated", (data) => {
    console.log("[MP] Room updated:", data.room);
    roomData = data.room;
    updatePlayerStatus(roomData);
  });

  // ===== COUNTDOWN START (WITH TIMESTAMP) =====
  socket.on("game:countdown-start", (data) => {
    console.log("[MP] Countdown starting!", data);
    roomData = data.room;

    // Hide waiting room
    const waitingRoom = document.getElementById('online-waiting-room');
    waitingRoom.classList.remove('active');

    // Calculate time until race starts
    const serverCountdownStart = data.countdownStartTime;
    const serverRaceStart = data.raceStartTime;
    const now = Date.now();
    const clientDelay = now - serverCountdownStart; // Network latency

    console.log(`[MP] Countdown started ${clientDelay}ms ago (latency compensation)`);

    // Start countdown animation
    const scene = game.current_scene;
    if (scene) {
      scene.STATE = "countdown";
      scene.countIndex = 0;
      scene.countStart = new Date(serverCountdownStart); // Use server time
      scene.updateUIState();
    }
  });

  // ===== RACE START =====
  socket.on("game:race-start", (data) => {
    console.log("[MP] Race starting NOW!");

    const scene = game.current_scene;
    if (scene) {
      scene.STATE = "running";
      scene.raceStartTime = data.room.startTime; // Use server start time
      scene.updateUIState();

      console.log("[MP] Race started! Players:", scene.players.length);
    } else {
      console.error("[MP] No scene when race started!");
    }
  });

  // ===== POSITION SYNC =====
  let lastSendTime = 0;
  const SEND_INTERVAL = 50; // 20 updates/sec

  function sendPositionUpdate() {
    const now = Date.now();
    if (now - lastSendTime < SEND_INTERVAL) return;
    lastSendTime = now;

    const scene = game.current_scene;
    if (!scene || scene.STATE !== "running") return;

    const me = scene.players[0]; // Local player
    if (!me) return;

    socket.emit("player:update", {
      position: me.body.position.x,
      progress: me.progressPercent,
      score: me.score,
      combo: me.combo,
      animTime: me.animTime,
      velocity: me.body.velocity.x
    });
  }

  // Send updates in loop
  function updateLoop() {
    sendPositionUpdate();
    requestAnimationFrame(updateLoop);
  }
  updateLoop();

  // ===== RECEIVE OPPONENT UPDATE (NO ECHO) =====
  socket.on("game:update", (data) => {
    const scene = game.current_scene;
    if (!scene || scene.STATE !== "running") return;

    // Data is from opponent only (server doesn't echo)
    const opponent = scene.players[1];
    if (!opponent) return;

    // Smooth interpolation
    const targetX = data.position ?? opponent.body.position.x;
    opponent.body.position.x += (targetX - opponent.body.position.x) * 0.5; // 50% interpolation

    // Direct updates
    opponent.progressPercent = data.progress ?? 0;
    opponent.score = data.score ?? 0;
    opponent.combo = data.combo ?? 0;
    opponent.animTime = data.animTime ?? 0;
    opponent.body.velocity.x = data.velocity ?? 0;
  });

  // ===== GAME FINISHED =====
  socket.on("game:finished", (data) => {
    console.log("[MP] Game finished!", data.winner);

    const scene = game.current_scene;
    if (scene && scene.STATE === "running") {
      scene.STATE = "win";

      // Determine winner index (0 or 1 in our local scene)
      if (data.winner.socketId === mySocketId) {
        scene.winner = 0; // I won
      } else {
        scene.winner = 1; // Opponent won
      }

      scene.winnerStats = {
        score: data.winner.score || 0,
        maxCombo: scene.players[scene.winner]?.maxCombo || 0
      };

      scene.showWinScreen();
    }
  });

  // ===== ROOM RESET (REMATCH) =====
  socket.on("room:reset", (data) => {
    console.log("[MP] Room reset for rematch!");
    roomData = data.room;

    // Hide win screen
    const winScreen = document.getElementById('win-screen');
    winScreen?.classList.remove('active');

    // Reset scene
    const scene = game.current_scene;
    if (scene) {
      scene.STATE = "menu";
      scene.winner = null;
      scene.canRestart = false;
      scene.updateUIState();

      // Reset players
      scene.players.forEach(p => {
        p.body.position.x = p.startX;
        p.score = 0;
        p.combo = 0;
        p.progressPercent = 0;
        p.hasFinished = false;
      });
    }

    // Show waiting room again
    showWaitingRoom(roomData);

    // Reset ready button
    const readyBtn = document.getElementById('im-ready-btn');
    if (readyBtn) {
      readyBtn.disabled = roomData.players.length < 2;
      readyBtn.innerHTML = '<span class="btn-text">I\'M READY</span>';
    }
  });

  // ===== ERROR HANDLING =====
  socket.on("room:error", (data) => {
    console.error("[MP] Room error:", data.message);
    alert("Room error: " + data.message);
    window.location.href = "modes.html";
  });

  socket.on("disconnect", () => {
    console.log("[MP] Disconnected from server");
  });

  socket.on("connect_error", (error) => {
    console.error("[MP] Connection error:", error);
  });

  // ===== PLAYER FINISHED =====
  window.addEventListener('beforeunload', () => {
    const scene = game.current_scene;
    if (scene && scene.STATE === "running") {
      const me = scene.players[0];
      if (me && me.progressPercent >= 100) {
        socket.emit("player:finished");
      }
    }
  });
}
