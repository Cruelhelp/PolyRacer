# ⚡ POLY RACE - Multiplayer Typing Racing Game

Real-time multiplayer typing racing game built with Socket.io and deployed on Railway.

## 🎮 Features

- **👤 Custom Usernames** - Set your name when you connect
- **🎯 Room System** - Create private rooms with 6-character codes
- **🎲 Random Matchmaking** - Find random opponents instantly
- **⚡ Real-Time Sync** - See your opponent's progress live
- **📊 Game Stats** - Track your score, combo, and progress
- **🏆 Win Detection** - First to finish wins!

## 🚀 Quick Deploy

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new)

## 🎯 How to Play

1. **Enter Your Username**
2. **Choose Mode:**
   - Press **C** to create a room
   - Press **J** to join with a code
   - Press **R** for random matchmaking
3. **Wait for Opponent**
4. **Click "I'M READY"**
5. **Race!** Type the letters shown to move forward

## 🛠️ Tech Stack

- **Frontend:** Vanilla JavaScript, HTML5 Canvas
- **Backend:** Node.js + Express + Socket.io
- **Deployment:** Railway
- **Real-Time:** WebSocket connections

## 📁 Project Structure

```
Poly Racer Railway/
├── index.html          # Game frontend & UI
├── server/
│   └── server.js       # Socket.io multiplayer server
├── package.json        # Dependencies
├── railway.json        # Railway config
└── README.md           # This file
```

## 🔧 Local Development

```bash
npm install
npm start
# Visit http://localhost:3001
```

## 📝 Game Flow

1. **Connect** → Enter username
2. **Lobby** → Create/join room
3. **Ready Up** → Both players ready
4. **Countdown** → 3, 2, 1, GO!
5. **Race** → Type letters to move
6. **Finish** → Winner announced

## 🎨 UI Components

- **Username Modal** - First-time name selection
- **Connection Status** - Shows Railway connection
- **Room UI** - Lobby with room code and player list
- **Game HUD** - Your name and room code
- **Notifications** - Real-time game events

## 🔐 Features

- Per-player game state tracking
- Real-time position sync
- Room-based matchmaking
- Automatic cleanup on disconnect
- Ready system for fair starts

## 📊 Server Events

**Client → Server:**
- `player:register` - Set username
- `room:create` - Create new room
- `room:join` - Join with code
- `match:random` - Random matchmaking
- `player:ready` - Mark ready
- `player:update` - Send game state
- `player:finished` - Race complete

**Server → Client:**
- `player:registered` - Confirmed
- `room:created` - Room ready
- `game:countdown` - Starting soon
- `game:start` - Race begins
- `game:update` - Opponent positions
- `game:finished` - Winner announced

## 👨‍💻 Author

**Ruel McNeil**
Senior Software Developer
Ministry of Finance & the Public Service, Jamaica

## 📝 License

MIT License

---

**Built with ⚡ for Railway**
