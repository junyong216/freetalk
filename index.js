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
        const isAlreadyIn = socket.rooms.has(data.room);
        socket.join(data.room);
        socket.userName = data.name;
        socket.room = data.room;

        // ⭐️ [추가] 방에 들어올 때, 이 방의 모든 메시지 읽음 처리 (나를 제외한 남은 인원수 업데이트)
        // 실제로는 더 정교해야 하지만, 간단하게 '내가 들어왔으니 안 읽은 사람 수 - 1' 처리
        db.run("UPDATE messages SET read_count = MAX(0, read_count - 1) WHERE room = ?", [data.room], () => {

            // 그 후 메시지 불러오기
            const loadQuery = `
            SELECT id, name, text, type, room, read_count, 
            strftime('%H:%M', created_at, 'localtime') as time 
            FROM messages WHERE room = ? 
            ORDER BY created_at DESC LIMIT 30
        `;
            db.all(loadQuery, [data.room], (err, rows) => {
                if (!err) socket.emit('load messages', rows.reverse());
            });

            // 방 사람들에게 숫자가 바뀌었다고 알림
            io.to(data.room).emit('refresh messages');
        });

        if (!isAlreadyIn) {
            io.to(data.room).emit('chat message', {
                name: '시스템', text: `${data.name}님이 입장했습니다.`, type: 'system', room: data.room
            });
        }
        sendRoomCounts();
    });

    socket.on('chat message', (data) => {
        const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

        // ⭐️ [수정] 메시지 저장 시 read_count를 (현재 방 인원수 - 1)로 설정
        const roomSize = io.sockets.adapter.rooms.get(data.room)?.size || 1;
        const initialReadCount = roomSize - 1; // 나를 뺀 나머지 인원

        db.run("INSERT INTO messages (room, name, text, type, read_count) VALUES (?, ?, ?, ?, ?)",
            [data.room, data.name, data.text, data.type || 'text', initialReadCount], function (err) {
                if (!err) {
                    io.to(data.room).emit('chat message', {
                        id: this.lastID,
                        name: data.name,
                        text: data.text,
                        type: data.type || 'text',
                        time: timeStr,
                        read_count: initialReadCount,
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