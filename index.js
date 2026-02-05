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
    db.run(`CREATE INDEX IF NOT EXISTS idx_room ON messages (room)`);
});

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

function sendRoomCounts() {
    try {
        const roomCounts = {};
        const rooms = io.sockets.adapter.rooms;
        allRooms.forEach(roomName => {
            const room = rooms.get(roomName);
            roomCounts[roomName] = room ? room.size : 0;
        });
        io.emit('room counts', { roomCounts, roomPasswords: Object.keys(roomPasswords) });
    } catch (e) { console.error("Room count error:", e); }
}

io.on('connection', (socket) => {
    sendRoomCounts();

    // index.js (서버 파일)

    // index.js (서버) - join room 부분 수정
    socket.on('join room', (data) => {
        // 1. 이미 이 방에 들어가 있는지 확인 (중복 입장 방지)
        const currentRooms = Array.from(socket.rooms);
        if (currentRooms.includes(data.room)) {
            // 이미 방에 있다면 과거 메시지만 다시 보내주고 종료 (입장 메시지 X)
            db.all("SELECT id, name, text, type, fileName, read_count, strftime('%H:%M', created_at, 'localtime') as time FROM messages WHERE room = ? ORDER BY created_at ASC LIMIT 100", [data.room], (err, rows) => {
                if (!err) socket.emit('load messages', rows);
            });
            return;
        }

        // 2. 처음 들어오는 경우에만 입장 처리
        allRooms.add(data.room);
        socket.join(data.room);
        socket.userName = data.name;
        socket.room = data.room;

        db.all("SELECT id, name, text, type, fileName, read_count, strftime('%H:%M', created_at, 'localtime') as time FROM messages WHERE room = ? ORDER BY created_at ASC LIMIT 100", [data.room], (err, rows) => {
            if (!err) socket.emit('load messages', rows);
        });

        // 3. 진짜 처음일 때만 시스템 메시지 발송
        io.to(data.room).emit('chat message', {
            name: '시스템', text: `${data.name}님이 입장했습니다.`, type: 'system'
        });

        sendRoomCounts();
    });

    socket.on('chat message', (data) => {
        const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        db.run("INSERT INTO messages (room, name, text, type, fileName, read_count) VALUES (?, ?, ?, ?, ?, ?)",
            [data.room, data.name, data.text, data.type || 'text', data.fileName || null, 0], function (err) {
                if (!err) {
                    io.to(data.room).emit('chat message', {
                        id: this.lastID,
                        room: data.room,
                        name: data.name,
                        text: data.text,
                        type: data.type || 'text',
                        read_count: 0,
                        time: timeStr
                    });
                }
            });
    });

    socket.on('leave room', () => {
        if (socket.room) {
            io.to(socket.room).emit('chat message', {
                name: '시스템', text: `${socket.userName}님이 퇴장했습니다.`, type: 'system'
            });
            socket.leave(socket.room);
            socket.room = null;
            sendRoomCounts();
        }
    });

    socket.on('disconnect', () => { sendRoomCounts(); });
});

server.listen(3000, () => { console.log('Server is running on port 3000'); });