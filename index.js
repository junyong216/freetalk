const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const db = new sqlite3.Database('./chat_v2.db');
const allRooms = new Set(["자유 대화방", "정보 공유방", "비밀 대화방"]);
const roomPasswords = {};

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT,
        name TEXT,
        text TEXT,
        type TEXT DEFAULT 'text',
        fileName TEXT,
        likes INTEGER DEFAULT 0,
        read_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

function sendRoomCounts() {
    const roomCounts = {};
    const rooms = io.sockets.adapter.rooms;
    allRooms.forEach(roomName => {
        const room = rooms.get(roomName);
        roomCounts[roomName] = room ? room.size : 0;
    });
    io.emit('room counts', { roomCounts });
}

io.on('connection', (socket) => {
    sendRoomCounts();

    socket.on('join room', (data) => {
        // 1. 이미 이 방에 들어와 있는지 확인
        const isAlreadyIn = socket.rooms.has(data.room);

        // 2. 새 방 입장 (이미 입장해 있다면 중복 입장되지 않으니 안심하세요)
        socket.join(data.room);
        socket.userName = data.name;
        socket.room = data.room; // 현재 보고 있는 방 표시용

        // 3. 해당 방 메시지 불러오기
        const loadQuery = `
            SELECT id, name, text, type, fileName, room, read_count, 
            strftime('%H:%M', created_at, 'localtime') as time 
            FROM messages WHERE room = ? ORDER BY created_at ASC LIMIT 100
        `;

        db.all(loadQuery, [data.room], (err, rows) => {
            if (!err) socket.emit('load messages', rows);
        });

        // 4. 시스템 메시지 (정말 '처음' 들어왔을 때만 보냄)
        if (!isAlreadyIn) {
            io.to(data.room).emit('chat message', {
                name: '시스템', text: `${data.name}님이 입장했습니다.`, type: 'system', room: data.room
            });
        }

        sendRoomCounts();
    });

    socket.on('chat message', (data) => {
        const timeStr = new Date().toLocaleTimeString('ko-KR', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        // ⭐️ data.room이 있는지 확인하고 저장합니다.
        db.run("INSERT INTO messages (room, name, text, type, read_count) VALUES (?, ?, ?, ?, ?)",
            [data.room, data.name, data.text, data.type || 'text', 0], function (err) {
                if (!err) {
                    // 해당 방(data.room)에 있는 사람들에게만 메시지를 보냅니다.
                    io.to(data.room).emit('chat message', {
                        id: this.lastID,
                        name: data.name,
                        text: data.text,
                        type: data.type || 'text',
                        time: timeStr,
                        read_count: 0,
                        room: data.room
                    });
                }
            });
    });

    socket.on('leave room', () => {
        if (socket.room) {
            io.to(socket.room).emit('chat message', {
                name: '시스템',
                text: `${socket.userName}님이 퇴장했습니다.`,
                type: 'system',
                room: socket.room
            });
            socket.leave(socket.room);
            socket.room = null;
            sendRoomCounts();
        }
    });
    socket.on('disconnect', () => { sendRoomCounts(); });
});

server.listen(3000, () => { console.log('Server is running on port 3000'); });