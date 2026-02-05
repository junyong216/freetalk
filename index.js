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
        likes INTEGER DEFAULT 0,
        read_count INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_room ON messages (room)`);
    // read_count 컬럼 없을 경우 대비
    db.run(`ALTER TABLE messages ADD COLUMN read_count INTEGER DEFAULT 0`, (err) => { });
});

app.get('/', (req, res) => { res.sendFile(__dirname + '/index.html'); });

function sendRoomCounts() {
    const roomCounts = {};
    const rooms = io.sockets.adapter.rooms;
    allRooms.forEach(roomName => {
        const room = rooms.get(roomName);
        roomCounts[roomName] = room ? room.size : 0;
    });
    io.emit('room counts', { roomCounts, roomPasswords: Object.keys(roomPasswords) });
}

io.on('connection', (socket) => {
    sendRoomCounts();

    socket.on('join room', (data) => {
        if (roomPasswords[data.room] && roomPasswords[data.room] !== data.password) {
            return socket.emit('error message', '비밀번호가 일치하지 않습니다.');
        }
        allRooms.add(data.room);
        if (data.password && !roomPasswords[data.room]) roomPasswords[data.room] = data.password;

        socket.join(data.room);
        socket.userName = data.name;
        socket.room = data.room;

        // 1. 과거 메시지 로드
        db.all("SELECT id, name, text, type, read_count, likes, strftime('%H:%M', created_at, 'localtime') as time FROM messages WHERE room = ? ORDER BY created_at ASC LIMIT 50", [data.room], (err, rows) => {
            if (!err) socket.emit('load messages', rows);
        });

        // 2. 입장 알림 전송 (type: 'system')
        io.to(data.room).emit('chat message', {
            id: Date.now(),
            name: '시스템',
            text: `${data.name}님이 입장했습니다.`,
            type: 'system',
            time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
        });

        sendRoomCounts();
    });

    socket.on('mark as read', () => {
        if (socket.room) {
            db.run("UPDATE messages SET read_count = 0 WHERE room = ? AND name != ?", [socket.room, socket.userName], (err) => {
                if (!err) io.to(socket.room).emit('all read');
            });
        }
    });

    socket.on('chat message', (data) => {
        const now = new Date();
        const timeString = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });
        const roomMembers = io.sockets.adapter.rooms.get(data.room);
        const countInRoom = (roomMembers && roomMembers.size > 1) ? 0 : 1;

        db.run("INSERT INTO messages (room, name, text, type, read_count) VALUES (?, ?, ?, ?, ?)",
            [data.room, data.name, data.text, data.type || 'text', countInRoom], function (err) {
                if (!err) {
                    io.to(data.room).emit('chat message', {
                        id: this.lastID, ...data, time: timeString, read_count: countInRoom, likes: 0
                    });
                }
            });
    });

    socket.on('delete message', (id) => {
        db.run("DELETE FROM messages WHERE id = ?", [id], (err) => {
            if (!err) io.to(socket.room).emit('message deleted', id);
        });
    });

    s// [서버] leave room 이벤트만 알림을 쏘도록 유지
    socket.on('leave room', () => {
        if (socket.room) {
            const r = socket.room;
            const n = socket.userName;
            io.to(r).emit('chat message', {
                id: Date.now(),
                name: '시스템',
                text: `${n}님이 퇴장했습니다.`, // 명시적으로 버튼 눌렀을 때만 알림
                type: 'system',
                time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })
            });
            socket.leave(r);
            socket.room = null;
            sendRoomCounts();
        }
    });

    // [서버] disconnect(새로고침, 탭 닫기) 시에는 알림을 뺄지 말지 선택
    socket.on('disconnect', () => {
        // 만약 새로고침할 때도 퇴장 알림을 안 주고 싶다면 이 안의 알림 로직을 지우세요.
        sendRoomCounts();
    });
});

server.listen(3000, () => { console.log('http://localhost:3000'); });