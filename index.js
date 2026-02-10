const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    maxHttpBufferSize: 5e7
});
app.use(express.static(__dirname));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => { cb(null, 'uploads/'); },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const db = new sqlite3.Database('./chat_v2.db');
const allRooms = new Set(["자유 대화방", "정보 공유방", "비밀 대화방"]);

const roomNotices = {};
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
app.post('/upload', upload.single('image'), (req, res) => {
    if (!req.file) return res.status(400).send('파일이 없습니다.');

    const imageUrl = `/uploads/${req.file.filename}`;
    const { room, name } = req.body; // 클라이언트에서 보낸 데이터

    // DB 저장 (기존 chat message 로직과 유사)
    db.run("INSERT INTO messages (room, name, text, type, read_count) VALUES (?, ?, ?, 'image', 0)",
        [room, name, imageUrl], function(err) {
            if (!err) {
                // 방에 있는 사람들에게 실시간 전송
                io.to(room).emit('chat message', {
                    id: this.lastID,
                    name: name,
                    text: imageUrl,
                    type: 'image',
                    room: room,
                    time: new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false })
                });
                res.json({ success: true, url: imageUrl });
            }
        });
});

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

    socket.on('create room', (data) => {
        allRooms.add(data.room); // 새로운 방 이름 추가
        if (data.password) {
            roomPasswords[data.room] = data.password; // 비밀번호 설정
        }
        sendRoomCounts();
    });

    socket.on('join room', (data) => {
        if (roomPasswords[data.room]) {
            if (roomPasswords[data.room] !== data.password) {
                // 비밀번호가 틀리면 클라이언트에 에러를 보내고 함수 종료
                return socket.emit('join error', { message: '비밀번호가 일치하지 않습니다.' });
            }
        }

        const isAlreadyIn = socket.rooms.has(data.room);

        socket.join(data.room);
        socket.userName = data.name;
        socket.room = data.room;
        socket.nowRoom = data.room;

        sendRoomCounts();
        sendUserList(data.room);

        socket.emit('load notice', roomNotices[data.room]);

        // [수정] 내가 아닌 다른 사람이 보낸 메시지의 read_count만 줄여야 함
        // (보통 1:1 대화라면 상대방이 들어왔을 때 내 메시지의 1이 사라지는 원리)
        db.run("UPDATE messages SET read_count = 0 WHERE room = ? AND name != ?", [data.room, data.name], (err) => {
            if (!err) {
                // ★ 중요: DB 업데이트 성공 후, 방에 있는 "모든 사용자"에게 읽음 처리 신호를 보냄
                io.to(data.room).emit('update read status', { room: data.room });

                const loadQuery = `
                SELECT id, name, text, type, room, likes, read_count, 
                strftime('%H:%M', created_at, 'localtime') as time 
                FROM messages WHERE room = ? 
                ORDER BY created_at DESC LIMIT 50
            `;

                db.all(loadQuery, [data.room], (err, rows) => {
                    if (!err) {
                        socket.emit('load messages', rows.reverse());
                        if (!isAlreadyIn) {
                            io.to(data.room).emit('chat message', {
                                name: '시스템',
                                text: `${data.name}님이 입장했습니다.`,
                                type: 'system',
                                room: data.room
                            });
                        }
                    }
                });
            }
        });
    });

    socket.on('chat message', (data) => {
        const timeStr = new Date().toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
        const roomName = data.room;
        const allSocketsInRoom = io.sockets.adapter.rooms.get(roomName);

        let activeUsers = 0;
        if (allSocketsInRoom) {
            allSocketsInRoom.forEach(socketId => {
                const s = io.sockets.sockets.get(socketId);
                // 현재 해당 방을 보고 있는 유저 수 계산
                if (s && s.nowRoom === roomName) {
                    activeUsers++;
                }
            });
        }

        const totalInRoom = allSocketsInRoom ? allSocketsInRoom.size : 1;
        // 안 읽은 사람 수 = 방 접속자 수 - 현재 화면을 보고 있는 사람 수
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

    // 6. 공감(하트) 기능 추가 (이 부분이 빠져있었습니다!)
    socket.on('like message', (id) => {
        db.run("UPDATE messages SET likes = likes + 1 WHERE id = ?", [id], function (err) {
            if (!err) {
                // DB 업데이트 성공 후, 해당 메시지의 최신 likes 수를 가져와서 전체에 알림
                db.get("SELECT id, likes FROM messages WHERE id = ?", [id], (err, row) => {
                    if (!err && row) {
                        io.emit('update likes', { id: row.id, likes: row.likes });
                    }
                });
            }
        });
    });

    socket.on('set notice', (data) => {
        roomNotices[data.room] = data.text; // 서버에 저장
        io.to(data.room).emit('new notice', { text: data.text }); // 방 전체에 알림
    });

    socket.on('typing', (data) => {
        // 본인을 제외한 방 안의 모든 사람에게 전송
        socket.to(data.room).emit('display typing', { name: data.name });
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