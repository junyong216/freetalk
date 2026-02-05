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

    socket.on('join room', (data) => {
        if (roomPasswords[data.room] && roomPasswords[data.room] !== data.password) {
            return socket.emit('error message', '비밀번호가 일치하지 않습니다.');
        }

        // ⭐️ [중복 방지] 이미 소켓이 해당 방에 들어가 있다면 추가 입장 처리를 하지 않음
        if (socket.rooms.has(data.room)) return;

        allRooms.add(data.room);
        socket.join(data.room);
        socket.userName = data.name;
        socket.room = data.room;

        // 과거 메시지 로드
        db.all("SELECT id, name, text, type, fileName, read_count, strftime('%H:%M', created_at, 'localtime') as time FROM messages WHERE room = ? ORDER BY created_at ASC LIMIT 100", [data.room], (err, rows) => {
            if (!err) socket.emit('load messages', rows);
        });

        // 입장 알림 발송
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