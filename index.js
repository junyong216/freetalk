const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const sqlite3 = require('sqlite3').verbose();

const app = express();
const server = http.createServer(app);
const io = new Server(server);

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
    db.run(`ALTER TABLE messages ADD COLUMN read_count INTEGER DEFAULT 0`, (err) => {});
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
        db.all("SELECT id, name, text, type, read_count, likes, strftime('%H:%M', created_at, 'localtime') as time FROM messages WHERE room = ? ORDER BY created_at ASC LIMIT 50", [data.room], (err, rows) => {
            if (!err) socket.emit('load messages', rows);
        });
        io.to(data.room).emit('notice', `${data.name}님이 입장했습니다.`);
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

    socket.on('like message', (id) => {
        db.run("UPDATE messages SET likes = likes + 1 WHERE id = ?", [id], function (err) {
            if (!err) {
                db.get("SELECT id, likes FROM messages WHERE id = ?", [id], (err, row) => {
                    if (row) io.to(socket.room).emit('update likes', row);
                });
            }
        });
    });

    socket.on('delete message', (id) => {
        db.run("DELETE FROM messages WHERE id = ?", [id], (err) => {
            if (!err) io.to(socket.room).emit('message deleted', id);
        });
    });

    socket.on('leave room', () => {
        if (socket.room) {
            const r = socket.room; socket.leave(r);
            io.to(r).emit('notice', `${socket.userName}님이 퇴장했습니다.`);
            socket.room = null; sendRoomCounts();
        }
    });

    socket.on('disconnect', () => { sendRoomCounts(); });
});

server.listen(3000, () => { console.log('http://localhost:3000'); });