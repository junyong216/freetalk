const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 5e7 // 10MB로 용량 제한 확대 (1e7 = 10,000,000 bytes)
});
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

        // 방의 현재 인원 확인
        const room = io.sockets.adapter.rooms.get(data.room);
        const roomSize = room ? room.size : 1;

        // ⭐️ 로직 변경: (방 전체 인원) - (현재 접속 중인 인원) = 아직 안 읽은 사람 수
        // 하지만 지금은 "실시간으로 보고 있는 사람"을 읽음 처리해야 하므로 
        // 기본적으로 모두가 보고 있다고 가정하면 0이 되어야 합니다.
        // 만약 "나를 제외한 아무도 없다면" 1이 뜨는 게 맞습니다.

        // [단순화된 로직]: 방에 나 혼자면 1, 둘 이상이면 0 (상대방이 즉시 읽음 처리)
        const initialReadCount = roomSize > 1 ? 0 : 1;

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