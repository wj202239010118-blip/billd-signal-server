const { createServer } = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4300;

const httpServer = createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const registered = Array.from(uuidSocketMap.entries()).map(([uuid, sid]) => ({ uuid, sid }));
    res.end(JSON.stringify({ status: 'ok', sockets: io.sockets.sockets.size, registered }));
    return;
  }
  res.writeHead(200);
  res.end('billd-signal-server running');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  transports: ['websocket', 'polling'],
});

// deskUserUuid → socketId
const uuidSocketMap = new Map();

function log(msg, ...args) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`, ...args);
}

// 从 socket.io 消息中提取内层 data 字段
// 客户端发送格式：{ request_id, socket_id, user_info, user_token, time, data: T }
// 服务器转发时只发 T（内层 data），让客户端类型定义匹配
function unwrap(payload) {
  return payload?.data !== undefined ? payload.data : payload;
}

io.on('connection', (socket) => {
  log(`[+] ${socket.id}`);

  // ── billdDeskJoin：被控端注册 ────────────────────────────────────────────
  socket.on('billdDeskJoin', (payload) => {
    const d = unwrap(payload);
    const uuid = d.deskUserUuid || d.uuid || d.live_room_id;
    if (!uuid) { log('billdDeskJoin: 缺少 uuid', JSON.stringify(d)); return; }

    uuidSocketMap.set(uuid, socket.id);
    socket._deskUserUuid = uuid;
    log(`billdDeskJoin uuid=${uuid} socket=${socket.id}`);

    // 回复 billdDeskJoined（客户端 handler 只检查可选字段，格式宽松）
    socket.emit('billdDeskJoined', { live_room_id: uuid, uuid });
  });

  // ── billdDeskStartRemote：控制端发起连接 → 转发给被控端 ──────────────────
  socket.on('billdDeskStartRemote', (payload) => {
    const d = unwrap(payload);
    const targetUuid = d.remoteDeskUserUuid;
    const targetSocketId = uuidSocketMap.get(targetUuid);
    log(`billdDeskStartRemote target=${targetUuid} found=${!!targetSocketId}`);

    if (!targetSocketId) {
      // 直接回复控制端：目标不在线
      socket.emit('billdDeskStartRemoteResult', {
        code: 1,
        msg: '目标设备不在线，请确认对方已打开 Mydesk',
        data: d,
      });
      return;
    }
    // 转发给被控端，附上控制端 socketId 作为 sender（被控端需要它回复）
    io.to(targetSocketId).emit('billdDeskStartRemote', {
      ...d,
      sender: socket.id,       // 覆盖为真实 socketId
      receiver: targetSocketId,
    });
  });

  // ── billdDeskStartRemoteResult：被控端回复 → 转发给控制端 ────────────────
  socket.on('billdDeskStartRemoteResult', (payload) => {
    const d = unwrap(payload);
    // 被控端调用 denyPermission/allowPermission 时，data 结构：
    // { code, msg, data: { sender: ctrlSocketId, receiver: mySocketId, ... } }
    const ctrlSocketId = d.data?.sender;
    log(`billdDeskStartRemoteResult code=${d.code} → ctrl=${ctrlSocketId}`);

    if (ctrlSocketId) {
      io.to(ctrlSocketId).emit('billdDeskStartRemoteResult', d);
    }
    // 被控端自己也收到（更新 UI）
    socket.emit('billdDeskStartRemoteResult', d);
  });

  // ── WebRTC 信令：offer / answer / candidate ──────────────────────────────
  // 转发内层 data，receiver 是 socketId
  socket.on('nativeWebRtcOffer', (payload) => {
    const d = unwrap(payload);
    log(`nativeWebRtcOffer → ${d.receiver}`);
    if (d.receiver) io.to(d.receiver).emit('nativeWebRtcOffer', d);
  });

  socket.on('nativeWebRtcAnswer', (payload) => {
    const d = unwrap(payload);
    log(`nativeWebRtcAnswer → ${d.receiver}`);
    if (d.receiver) io.to(d.receiver).emit('nativeWebRtcAnswer', d);
  });

  socket.on('nativeWebRtcCandidate', (payload) => {
    const d = unwrap(payload);
    if (d.receiver) io.to(d.receiver).emit('nativeWebRtcCandidate', d);
  });

  // ── 鼠标/键盘行为 ────────────────────────────────────────────────────────
  socket.on('billdDeskBehavior', (payload) => {
    const d = unwrap(payload);
    if (d.receiver) io.to(d.receiver).emit('billdDeskBehavior', d);
  });

  // ── 通用 join（兼容） ─────────────────────────────────────────────────────
  socket.on('join', (payload) => {
    const d = unwrap(payload);
    const roomId = String(d.live_room_id || '');
    if (roomId) socket.join(roomId);
    socket.emit('joined', {
      request_id: payload.request_id,
      time: Date.now(),
      data: { live_room_id: d.live_room_id },
    });
  });

  // ── heartbeat ─────────────────────────────────────────────────────────────
  socket.on('heartbeat', (payload) => {
    socket.emit('heartbeat', { request_id: payload?.request_id, time: Date.now(), data: {} });
  });

  // ── 断开 ──────────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    log(`[-] ${socket.id} reason=${reason}`);
    if (socket._deskUserUuid) uuidSocketMap.delete(socket._deskUserUuid);
  });
});

httpServer.listen(PORT, () => {
  log(`信令服务器启动 port=${PORT}`);
});
