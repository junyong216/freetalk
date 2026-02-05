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

    socket.on('join room', (data) => {
        if (roomPasswords[data.room] && roomPasswords[data.room] !== data.password) {
            return socket.emit('error message', '비밀번호가 일치하지 않습니다.');
        }
        allRooms.add(data.room);
        if (data.password && !roomPasswords[data.room]) roomPasswords[data.room] = data.password;

        const isAlreadyIn = socket.rooms.has(data.room);
        socket.join(data.room);
        socket.isWatching = true;
        socket.userName = data.name;
        socket.room = data.room;

        db.run("UPDATE messages SET read_count = 0 WHERE room = ?", [data.room], (err) => {
            if (!err) io.to(data.room).emit('all read');
        });

        // ⭐ strftime으로 시간 데이터 명시적으로 가져오기
        db.all("SELECT id, name, text, type, fileName, read_count, strftime('%H:%M', created_at, 'localtime') as time FROM messages WHERE room = ? ORDER BY created_at ASC LIMIT 100", [data.room], (err, rows) => {
            if (!err) socket.emit('load messages', rows);
        });

        if (!isAlreadyIn) {
            io.to(data.room).emit('chat message', {
                id: Date.now(), name: '시스템', text: `${data.name}님이 입장했습니다.`, type: 'system'
            });
        }
        sendRoomCounts();
    });

    socket.on('chat message', (data) => {
        const roomMembers = io.sockets.adapter.rooms.get(data.room);
        let watchingCount = 0;
        if (roomMembers) {
            for (const socketId of roomMembers) {
                if (io.sockets.sockets.get(socketId)?.isWatching) watchingCount++;
            }
        }
        const countInRoom = (watchingCount > 1) ? 0 : 1;
        // ⭐ 실시간 메시지 전송용 시간 생성
        const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

        db.run("INSERT INTO messages (room, name, text, type, fileName, read_count) VALUES (?, ?, ?, ?, ?, ?)",
            [data.room, data.name, data.text, data.type || 'text', data.fileName || null, countInRoom], function (err) {
                if (!err) {
                    io.to(data.room).emit('chat message', {
                        id: this.lastID,
                        ...data,
                        read_count: countInRoom,
                        time: timeStr // ⭐ 시간 포함
                    });
                }
            });
    });

    socket.on('mark as read', () => {
        if (socket.room) {
            db.run("UPDATE messages SET read_count = 0 WHERE room = ?", [socket.room], (err) => {
                if (!err) io.to(socket.room).emit('all read');
            });
        }
    });

    socket.on('start watching', () => { socket.isWatching = true; });
    socket.on('stop watching', () => { socket.isWatching = false; });
    
    socket.on('leave room', () => {
        if (socket.room) {
            io.to(socket.room).emit('chat message', {
                id: Date.now(), name: '시스템', text: `${socket.userName}님이 퇴장했습니다.`, type: 'system'
            });
            socket.leave(socket.room);
            socket.room = null;
            sendRoomCounts();
        }
    });

    socket.on('disconnect', () => { sendRoomCounts(); });
});

server.listen(3000, () => { console.log('Server is running on port 3000'); });