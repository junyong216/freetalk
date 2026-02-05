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
    // 1. 테이블 생성
    db.run(`CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room TEXT,
        name TEXT,
        text TEXT,
        type TEXT DEFAULT 'text',
        likes INTEGER DEFAULT 0,
        read_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // 2. 인덱스 생성
    db.run(`CREATE INDEX IF NOT EXISTS idx_room ON messages (room)`);

    // 3. 컬럼 추가 (에러가 나도 서버가 죽지 않도록 콜백에서 에러 무시)
    db.run(`ALTER TABLE messages ADD COLUMN read_count INTEGER DEFAULT 0`, (err) => {
        if (err) {
            // 이미 컬럼이 있는 경우 에러가 나는데, 그냥 무시하고 진행합니다.
            console.log("read_count 컬럼이 이미 존재하거나 생성할 수 없습니다. (정상)");
        }
    });
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

    socket.on('join room', (data) => {
        if (roomPasswords[data.room] && roomPasswords[data.room] !== data.password) {
            return socket.emit('error message', '비밀번호가 일치하지 않습니다.');
        }
        allRooms.add(data.room);
        if (data.password && !roomPasswords[data.room]) roomPasswords[data.room] = data.password;

        const isAlreadyIn = socket.rooms.has(data.room);

        socket.join(data.room);
        socket.userName = data.name;
        socket.room = data.room;

        // 1. 과거 메시지는 언제든 다시 보여줌
        db.all("SELECT id, name, text, type, read_count, likes, strftime('%H:%M', created_at, 'localtime') as time FROM messages WHERE room = ? ORDER BY created_at ASC LIMIT 50", [data.room], (err, rows) => {
            if (!err) socket.emit('load messages', rows);
        });

        // 2. ⭐ 처음 들어올 때만 입장 알림 전송
        if (!isAlreadyIn) {
            io.to(data.room).emit('chat message', {
                id: Date.now(),
                name: '시스템',
                text: `${data.name}님이 입장했습니다.`,
                type: 'system'
            });
        }

        sendRoomCounts();
    });

    socket.on('chat message', (data) => {
        const roomMembers = io.sockets.adapter.rooms.get(data.room);
        const countInRoom = (roomMembers && roomMembers.size > 1) ? 0 : 1;

        db.run("INSERT INTO messages (room, name, text, type, read_count) VALUES (?, ?, ?, ?, ?)",
            [data.room, data.name, data.text, data.type || 'text', countInRoom], function (err) {
                if (!err) {
                    io.to(data.room).emit('chat message', {
                        id: this.lastID,
                        ...data,
                        read_count: countInRoom,
                        likes: 0,
                        time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
                    });
                }
            });
    });

    socket.on('leave room', () => {
        if (socket.room) {
            const r = socket.room;
            const n = socket.userName;
            io.to(r).emit('chat message', {
                id: Date.now(),
                name: '시스템',
                text: `${n}님이 퇴장했습니다.`,
                type: 'system'
            });
            socket.leave(r);
            socket.room = null;
            sendRoomCounts();
        }
    });

    socket.on('disconnect', () => { sendRoomCounts(); });
});

server.listen(3000, () => { console.log('Server is running on port 3000'); });