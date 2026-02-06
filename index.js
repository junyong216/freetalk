const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 5e7
});
app.use(express.static(__dirname));

const db = new sqlite3.Database('./chat_v2.db');
const allRooms = new Set(["자유 대화방", "정보 공유방", "비밀 대화방"]);

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

function sendUserList(room) {
    const sockets = io.sockets.adapter.rooms.get(room);
    const userList = [];
    if (sockets) {
        for (const socketId of sockets) {
            const s = io.sockets.sockets.get(socketId);
            if (s && s.userName) {
                userList.push(s.userName);
            }
        }
    }
    io.to(room).emit('user list', userList);
}

io.on('connection', (socket) => {
    sendRoomCounts();

    // 1. 방 입장 처리
    socket.on('join room', (data) => {
        const isAlreadyIn = socket.rooms.has(data.room);
        socket.join(data.room);
        socket.userName = data.name;
        socket.room = data.room;

        sendRoomCounts();
        sendUserList(data.room);

        db.run("UPDATE messages SET read_count = MAX(0, read_count - 1) WHERE room = ?", [data.room], (err) => {
            if (!err) {
            const loadQuery = `
                SELECT id, name, text, type, room, likes, read_count, 
                strftime('%H:%M', created_at, 'localtime') as time 
                FROM messages WHERE room = ? 
                ORDER BY created_at DESC LIMIT 30
            `;
            db.all(loadQuery, [data.room], (err, rows) => {
                if (!err) socket.emit('load messages', rows.reverse());
            });
            io.to(data.room).emit('refresh messages');
        }
    });

        if (!isAlreadyIn) {
            io.to(data.room).emit('chat message', {
                name: '시스템', text: `${data.name}님이 입장했습니다.`, type: 'system', room: data.room
            });
        }
        sendRoomCounts();
    });

    // 2. 공감 기능 (join room 밖으로 뺐습니다)
    socket.on('like message', (id) => {
        db.run("UPDATE messages SET likes = likes + 1 WHERE id = ?", [id], (err) => {
            if (!err) {
                db.get("SELECT id, likes, room FROM messages WHERE id = ?", [id], (err, row) => {
                    if (!err && row) {
                        io.to(row.room).emit('update likes', { id: row.id, likes: row.likes });
                    }
                });
            }
        });
    });

    socket.on('chat message', (data) => {
        const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

        // 해당 방에 소켓 연결은 되어있지만, '보고 있는 화면(nowRoom)'이 다른 사람 수 계산
        const roomName = data.room;
        const allSocketsInRoom = io.sockets.adapter.rooms.get(roomName);

        let activeUsers = 0;
        if (allSocketsInRoom) {
            allSocketsInRoom.forEach(socketId => {
                const s = io.sockets.sockets.get(socketId);
                // 핵심: 소켓이 연결된 방(room)과 현재 보고 있는 방(nowRoom)이 일치해야 '읽음'
                if (s.nowRoom === roomName) {
                    activeUsers++;
                }
            });
        }

        // 안 읽은 사람 수 = (방에 있는 전체 소켓 수 - 현재 활성화된 유저 수)
        // 혹은 더 직관적으로: "지금 안 보고 있는 사람이 있으면 1" (1:1 채팅 기준)
        const totalInRoom = allSocketsInRoom ? allSocketsInRoom.size : 1;
        const initialReadCount = Math.max(0, totalInRoom - activeUsers);

        db.run("INSERT INTO messages (room, name, text, type, read_count, likes) VALUES (?, ?, ?, ?, ?, 0)",
            [data.room, data.name, data.text, data.type || 'text', initialReadCount], function (err) {
                if (!err) {
                    io.to(data.room).emit('chat message', {
                        id: this.lastID,
                        name: data.name,
                        text: data.text,
                        type: data.type || 'text',
                        time: timeStr,
                        read_count: initialReadCount,
                        likes: 0,
                        room: data.room
                    });
                }
            });
    });

    // 4. 메시지 삭제
    socket.on('delete message', (id) => {
        db.run("DELETE FROM messages WHERE id = ?", [id], (err) => {
            if (!err) io.emit('message deleted', id);
        });
    });

    // 5. 방 나가기 및 연결 끊김
    socket.on('leave room', () => {
        const roomToLeave = socket.room; // 현재 방 이름을 백업
        if (roomToLeave) {
            io.to(roomToLeave).emit('chat message', {
                name: '시스템', text: `${socket.userName}님이 퇴장했습니다.`, type: 'system', room: roomToLeave
            });
            socket.leave(roomToLeave);
            socket.room = null;

            sendUserList(roomToLeave); // 백업된 방 이름으로 유저 리스트 갱신
            sendRoomCounts();
        }
    });

    socket.on('update active room', (roomName) => {
        socket.nowRoom = roomName; // 소켓 객체에 현재 보고 있는 방 상태 저장
    });

    socket.on('disconnect', () => {
        if (socket.room) {
            const roomToLeave = socket.room;
            io.to(roomToLeave).emit('chat message', {
                name: '시스템', text: `${socket.userName}님이 접속을 종료했습니다.`, type: 'system', room: roomToLeave
            });
            sendUserList(roomToLeave);
        }
        sendRoomCounts();
    });
});

server.listen(3000, () => { console.log('Server is running on port 3000'); });