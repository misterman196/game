const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(__dirname));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});
app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'game.html'));
});

// Game state
const rooms = new Map();
const players = new Map();

// Generate room code
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 4; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
}

// Generate player ID
function generatePlayerId() {
    return 'player_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

io.on('connection', (socket) => {
    console.log('New connection:', socket.id);
    
    socket.on('createRoom', (data) => {
        const roomCode = generateRoomCode();
        const playerId = generatePlayerId();
        
        // Create room
        const room = {
            code: roomCode,
            players: new Map(),
            gameStarted: false,
            countdown: 3,
            gameLoop: null
        };
        
        // Add player to room
        room.players.set(playerId, {
            id: playerId,
            name: data.playerName,
            socketId: socket.id,
            x: 0,
            y: 0,
            health: 100,
            isDead: false
        });
        
        rooms.set(roomCode, room);
        players.set(socket.id, { playerId, roomCode });
        
        // Join socket room
        socket.join(roomCode);
        
        // Send response
        socket.emit('roomCreated', {
            roomCode: roomCode,
            playerId: playerId
        });
        
        console.log(`Room ${roomCode} created by ${data.playerName}`);
    });
    
    socket.on('joinRandomRoom', (data) => {
        // Find a room with only one player
        for (const [roomCode, room] of rooms) {
            if (room.players.size === 1 && !room.gameStarted) {
                joinRoom(socket, data, roomCode);
                return;
            }
        }
        
        // No available rooms, create new one
        const roomCode = generateRoomCode();
        const playerId = generatePlayerId();
        
        const room = {
            code: roomCode,
            players: new Map(),
            gameStarted: false,
            countdown: 3
        };
        
        room.players.set(playerId, {
            id: playerId,
            name: data.playerName,
            socketId: socket.id,
            x: 0,
            y: 0,
            health: 100,
            isDead: false
        });
        
        rooms.set(roomCode, room);
        players.set(socket.id, { playerId, roomCode });
        
        socket.join(roomCode);
        socket.emit('roomJoined', {
            roomCode: roomCode,
            playerId: playerId
        });
    });
    
    socket.on('joinRoom', (data) => {
        joinRoom(socket, data, data.roomCode);
    });
    
    socket.on('joinGame', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) {
            socket.emit('error', 'Room not found');
            return;
        }
        
        // Add player to room if not already there
        if (!room.players.has(data.playerId)) {
            room.players.set(data.playerId, {
                id: data.playerId,
                name: data.playerName,
                socketId: socket.id,
                x: 0,
                y: 0,
                health: 100,
                isDead: false
            });
        }
        
        players.set(socket.id, { 
            playerId: data.playerId, 
            roomCode: data.roomCode 
        });
        
        socket.join(data.roomCode);
        
        // Send game state to all players in room
        broadcastGameState(room);
        
        // Start game if 2 players are connected
        if (room.players.size === 2 && !room.gameStarted) {
            startGame(room);
        }
    });
    
    socket.on('playerState', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) return;
        
        const player = room.players.get(data.playerId);
        if (player) {
            // Update player state
            player.x = data.x;
            player.y = data.y;
            player.velocityX = data.velocityX;
            player.velocityY = data.velocityY;
            player.health = data.health;
            player.isDead = data.isDead;
            player.shield = data.shield;
            
            // Broadcast to other players
            socket.to(data.roomCode).emit('gameState', {
                players: getPlayersState(room),
                gameStarted: room.gameStarted,
                countdown: room.countdown
            });
        }
    });
    
    socket.on('playerUpdate', (data) => {
        // Forward mouse position to other players
        socket.to(data.roomCode).emit('playerUpdate', {
            playerId: data.playerId,
            mouseX: data.mouseX,
            mouseY: data.mouseY
        });
    });
    
    socket.on('swordSwing', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) return;
        
        const player = room.players.get(data.playerId);
        if (player) {
            player.sword = {
                active: true,
                isSwinging: true,
                swingAngle: 0
            };
            player.swordHitbox = data.hitbox;
            player.shield = { active: false };
            
            // Broadcast to other players
            socket.to(data.roomCode).emit('swordSwing', {
                playerId: data.playerId,
                hitbox: data.hitbox
            });
        }
    });
    
    socket.on('swordRelease', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) return;
        
        const player = room.players.get(data.playerId);
        if (player) {
            player.sword = { active: false, isSwinging: false };
            player.shield = { active: true };
            
            // Broadcast to other players
            socket.to(data.roomCode).emit('swordRelease', {
                playerId: data.playerId
            });
        }
    });
    
    socket.on('playerHit', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) return;
        
        const targetPlayer = room.players.get(data.targetId);
        const attackerPlayer = room.players.get(data.attackerId);
        
        if (targetPlayer && attackerPlayer && !targetPlayer.isDead) {
            // Apply damage
            targetPlayer.health = Math.max(0, targetPlayer.health - 15);
            
            // Check if player died
            if (targetPlayer.health <= 0 && !targetPlayer.isDead) {
                targetPlayer.isDead = true;
                
                // Check for game over
                let alivePlayers = 0;
                let lastAlivePlayer = null;
                
                for (const player of room.players.values()) {
                    if (!player.isDead) {
                        alivePlayers++;
                        lastAlivePlayer = player;
                    }
                }
                
                if (alivePlayers === 1 && lastAlivePlayer) {
                    // Game over
                    io.to(data.roomCode).emit('gameOver', {
                        winnerId: lastAlivePlayer.id,
                        loserId: data.targetId
                    });
                    
                    room.gameStarted = false;
                }
            }
            
            // Broadcast hit event
            io.to(data.roomCode).emit('playerHit', {
                playerId: data.targetId,
                attackerId: data.attackerId,
                damage: 15
            });
        }
    });
    
    socket.on('playerDied', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) return;
        
        const player = room.players.get(data.playerId);
        if (player) {
            player.isDead = true;
            
            // Check for game over
            let alivePlayers = 0;
            let lastAlivePlayer = null;
            
            for (const player of room.players.values()) {
                if (!player.isDead) {
                    alivePlayers++;
                    lastAlivePlayer = player;
                }
            }
            
            if (alivePlayers === 1 && lastAlivePlayer) {
                // Game over
                io.to(data.roomCode).emit('gameOver', {
                    winnerId: lastAlivePlayer.id,
                    loserId: data.playerId
                });
                
                room.gameStarted = false;
            }
        }
    });
    
    socket.on('playerRespawn', (data) => {
        const room = rooms.get(data.roomCode);
        if (!room) return;
        
        const player = room.players.get(data.playerId);
        if (player) {
            player.health = 100;
            player.isDead = false;
            
            // Broadcast respawn
            socket.to(data.roomCode).emit('playerRespawn', {
                playerId: data.playerId
            });
        }
    });
    
    socket.on('disconnect', () => {
        const playerData = players.get(socket.id);
        if (playerData) {
            const room = rooms.get(playerData.roomCode);
            if (room) {
                // Remove player from room
                room.players.delete(playerData.playerId);
                
                // Notify other players
                socket.to(playerData.roomCode).emit('playerDisconnected', {
                    playerId: playerData.playerId,
                    playerName: room.players.get(playerData.playerId)?.name || 'Player'
                });
                
                // Clean up empty rooms
                if (room.players.size === 0) {
                    rooms.delete(playerData.roomCode);
                }
            }
            
            players.delete(socket.id);
        }
        
        console.log('Disconnected:', socket.id);
    });
    
    function joinRoom(socket, data, roomCode) {
        const room = rooms.get(roomCode);
        
        if (!room) {
            socket.emit('roomNotFound');
            return;
        }
        
        if (room.players.size >= 2) {
            socket.emit('roomFull');
            return;
        }
        
        const playerId = generatePlayerId();
        
        // Add player to room
        room.players.set(playerId, {
            id: playerId,
            name: data.playerName,
            socketId: socket.id,
            x: 0,
            y: 0,
            health: 100,
            isDead: false
        });
        
        players.set(socket.id, { playerId, roomCode });
        socket.join(roomCode);
        
        socket.emit('roomJoined', {
            roomCode: roomCode,
            playerId: playerId
        });
        
        console.log(`${data.playerName} joined room ${roomCode}`);
    }
    
    function getPlayersState(room) {
        const state = {};
        for (const [id, player] of room.players) {
            state[id] = {
                name: player.name,
                x: player.x,
                y: player.y,
                velocityX: player.velocityX,
                velocityY: player.velocityY,
                health: player.health,
                isDead: player.isDead,
                shield: player.shield || { active: true, angle: 0 },
                sword: player.sword || { active: false, isSwinging: false, swingAngle: 0 },
                swordHitbox: player.swordHitbox || { visible: false, x: 0, y: 0, angle: 0 }
            };
        }
        return state;
    }
    
    function broadcastGameState(room) {
        io.to(room.code).emit('gameState', {
            players: getPlayersState(room),
            gameStarted: room.gameStarted,
            countdown: room.countdown
        });
    }
    
    function startGame(room) {
        room.gameStarted = true;
        
        // Countdown
        let countdown = 3;
        const countdownInterval = setInterval(() => {
            io.to(room.code).emit('countdown', countdown);
            
            if (countdown === 0) {
                clearInterval(countdownInterval);
                // Send initial positions
                let i = 0;
                for (const player of room.players.values()) {
                    player.x = i === 0 ? 250 : 750; // Left and right positions
                    player.y = 300;
                    i++;
                }
                broadcastGameState(room);
            }
            
            countdown--;
        }, 1000);
    }
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Open http://localhost:${PORT} in your browser`);
});
