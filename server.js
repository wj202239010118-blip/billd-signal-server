/**
 * billd-desk 极简信令服务器
 *
 * 设计原则（借鉴 RustDesk）：
 * - 服务器只负责「转发消息」，不存储任何业务数据
 * - 密码校验在被控端本地完成，服务器不参与
 * - 无需数据库，纯内存，进程重启不影响客户端（会自动重连）
 *
 * 兼容 billd-desk 的 Socket.io 消息协议，客户端零改动
 */

const { createServer } = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4300;

const httpServer = createServer((req, res) => {
  // 健康检查端点（Railway 需要）
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', rooms: io.sockets.adapter.rooms.size }));
    return;
  }
  res.writeHead(200);
  res.end('billd-signal-server running');
});

const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST'],
  },
  transports: ['websocket', 'polling'],
});

// roomId → Set<socketId>  内存中维护房间成员
const rooms = new Map();

function log(msg, ...args) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`, ...args);
}

// ─── 工具：向同一房间内的其他成员广播 ─────────────────────────────────────────
function relayToRoom(roomId, eventName, payload, excludeSocketId) {
  const members = rooms.get(roomId);
  if (!members) return;
  for (const sid of members) {
    if (sid === excludeSocketId) continue;
    io.to(sid).emit(eventName, payload);
  }
}

// ─── 工具：向指定 receiver（UUID 对应的房间） 发消息 ──────────────────────────
function relayToReceiver(receiverUuid, eventName, payload) {
  const members = rooms.get(receiverUuid);
  if (!members) {
    log(`目标房间不存在: ${receiverUuid}`);
    return;
  }
  for (const sid of members) {
    io.to(sid).emit(eventName, payload);
  }
}

io.on('connection', (socket) => {
  log(`客户端连接: ${socket.id}`);

  // ── join：设备上线，加入以自己 UUID 为名的房间 ─────────────────────────────
  socket.on('join', (payload) => {
    const roomId = payload?.data?.live_room_id || payload?.data?.uuid;
    if (!roomId) {
      log('join 缺少 roomId', payload);
      return;
    }
    socket.join(roomId);
    if (!rooms.has(roomId)) rooms.set(roomId, new Set());
    rooms.get(roomId).add(socket.id);
    log(`join → room:${roomId}, socket:${socket.id}`);

    // 回复 joined
    socket.emit('joined', {
      request_id: payload.request_id,
      time: Date.now(),
      data: { live_room_id: roomId },
    });
  });

  // ── billdDeskJoin：远程桌面客户端加入 ────────────────────────────────────
  socket.on('billdDeskJoin', (payload) => {
    const { uuid } = payload.data || {};
    if (!uuid) return;
    socket.join(uuid);
    if (!rooms.has(uuid)) rooms.set(uuid, new Set());
    rooms.get(uuid).add(socket.id);
    log(`billdDeskJoin → room:${uuid}, socket:${socket.id}`);

    socket.emit('billdDeskJoined', {
      request_id: payload.request_id,
      time: Date.now(),
      data: { uuid },
    });
  });

  // ── billdDeskStartRemote：控制端发起连接请求 → 转发给被控端 ───────────────
  socket.on('billdDeskStartRemote', (payload) => {
    const { receiver } = payload.data || {};
    log(`billdDeskStartRemote sender→receiver:${receiver}`);
    // 把请求发给被控端（以被控端 UUID 为房间）
    relayToRoom(receiver, 'billdDeskStartRemote', payload, socket.id);
  });

  // ── billdDeskStartRemoteResult：被控端回复（接受/拒绝） → 转发给控制端 ────
  socket.on('billdDeskStartRemoteResult', (payload) => {
    const { sender } = payload.data || {};
    log(`billdDeskStartRemoteResult result→sender:${sender}`);
    relayToRoom(sender, 'billdDeskStartRemoteResult', payload, socket.id);
  });

  // ── billdDeskBehavior：鼠标/键盘行为 → 转发给被控端 ──────────────────────
  socket.on('billdDeskBehavior', (payload) => {
    const { receiver } = payload.data || {};
    relayToRoom(receiver, 'billdDeskBehavior', payload, socket.id);
  });

  // ── WebRTC 信令三件套：offer / answer / candidate ────────────────────────
  socket.on('nativeWebRtcOffer', (payload) => {
    const { receiver, live_room_id } = payload.data || {};
    log(`nativeWebRtcOffer → receiver:${receiver}`);
    relayToRoom(receiver || live_room_id, 'nativeWebRtcOffer', payload, socket.id);
  });

  socket.on('nativeWebRtcAnswer', (payload) => {
    const { receiver, live_room_id } = payload.data || {};
    log(`nativeWebRtcAnswer → receiver:${receiver}`);
    relayToRoom(receiver || live_room_id, 'nativeWebRtcAnswer', payload, socket.id);
  });

  socket.on('nativeWebRtcCandidate', (payload) => {
    const { receiver, live_room_id } = payload.data || {};
    relayToRoom(receiver || live_room_id, 'nativeWebRtcCandidate', payload, socket.id);
  });

  // ── billdDeskOffer / Answer / Candidate（部分版本使用这组命名） ──────────
  socket.on('billdDeskOffer', (payload) => {
    const { receiver } = payload.data || {};
    relayToRoom(receiver, 'billdDeskOffer', payload, socket.id);
  });
  socket.on('billdDeskAnswer', (payload) => {
    const { receiver } = payload.data || {};
    relayToRoom(receiver, 'billdDeskAnswer', payload, socket.id);
  });
  socket.on('billdDeskCandidate', (payload) => {
    const { receiver } = payload.data || {};
    relayToRoom(receiver, 'billdDeskCandidate', payload, socket.id);
  });

  // ── 文件传输信令（ft-*）：点对点转发 ───────────────────────────────────
  // 所有文件传输信令消息结构：{ type: 'ft-xxx', to: targetUuid, from: myUuid, ... }
  socket.on('fileTransfer', (payload) => {
    const { to } = payload;
    if (!to) return;
    log(`fileTransfer ${payload.type} → ${to}`);
    // 转发给目标 UUID 对应房间的所有成员
    relayToRoom(to, 'fileTransfer', payload, socket.id);
  });

  // ftJoin：文件传输专用房间加入
  socket.on('ftJoin', (payload) => {
    const { uuid } = payload || {};
    if (!uuid) return;
    socket.join(uuid);
    if (!rooms.has(uuid)) rooms.set(uuid, new Set());
    rooms.get(uuid).add(socket.id);
    log(`ftJoin → room:${uuid}`);
  });

  // ── heartbeat：保活 ────────────────────────────────────────────────────
  socket.on('heartbeat', (payload) => {
    socket.emit('heartbeat', { request_id: payload?.request_id, time: Date.now(), data: {} });
  });

  // ── 断开处理 ───────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    log(`客户端断开: ${socket.id}, 原因: ${reason}`);
    for (const [roomId, members] of rooms) {
      if (members.delete(socket.id) && members.size === 0) {
        rooms.delete(roomId);
        log(`房间已清理: ${roomId}`);
      }
    }
  });
});

httpServer.listen(PORT, () => {
  log(`信令服务器启动在端口 ${PORT}`);
  log(`健康检查: http://localhost:${PORT}/health`);
});
