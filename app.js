// ── State ──
let ws = null;
let myUsername = null;
let currentRoom = null;
let authMode = 'login';
let iceConfig = null;

// WebRTC
let peerConnection = null;
let localStream = null;
let callTarget = null;
let isCaller = false;

// ── Auth UI ──
function showTab(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tabs button').forEach((b, i) => {
    b.classList.toggle('active', (i === 0) === (mode === 'login'));
  });
  document.querySelector('.btn-primary').textContent = mode === 'login' ? 'Войти' : 'Зарегистрироваться';
}

async function authAction() {
  const username = document.getElementById('auth-username').value.trim();
  const password = document.getElementById('auth-password').value;
  const errEl = document.getElementById('error-msg');
  errEl.textContent = '';

  if (!username || !password) { errEl.textContent = 'Заполни поля'; return; }

  const url = authMode === 'login' ? '/api/login' : '/api/register';
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (!res.ok) { errEl.textContent = data.detail || 'Ошибка'; return; }
    startApp(username);
  } catch (e) {
    errEl.textContent = 'Ошибка соединения';
  }
}

// ── App start ──
async function startApp(username) {
  myUsername = username;
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app').classList.add('visible');
  document.getElementById('my-username').textContent = username;

  // Load TURN config
  const r = await fetch('/api/turn-config');
  iceConfig = await r.json();

  // Load existing rooms
  const rr = await fetch('/api/rooms');
  const { rooms } = await rr.json();
  rooms.forEach(addRoomToSidebar);

  connectWS();
}

// ── WebSocket ──
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws/${myUsername}`);

  ws.onmessage = (e) => handleMessage(JSON.parse(e.data));
  ws.onclose = () => setTimeout(connectWS, 2000);
}

function sendWS(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'room_history':
      document.getElementById('messages').innerHTML = '';
      msg.messages.forEach(appendMessage);
      break;
    case 'message':
      if (msg.room === currentRoom) appendMessage(msg);
      break;
    case 'user_joined':
    case 'user_left':
      if (msg.room === currentRoom) updateUsers(msg.users || []);
      addSystemMsg(msg.type === 'user_joined'
        ? `${msg.username} вошёл в комнату`
        : `${msg.username} вышел из комнаты`);
      break;
    case 'call_offer':
      receiveCall(msg);
      break;
    case 'call_answer':
      handleAnswer(msg.sdp);
      break;
    case 'ice_candidate':
      handleIceCandidate(msg.candidate);
      break;
    case 'call_reject':
      endCallUI('Звонок отклонён');
      break;
    case 'call_end':
      endCallUI('Звонок завершён');
      break;
  }
}

// ── Rooms ──
function addRoomToSidebar(name) {
  if (document.getElementById(`room-${name}`)) return;
  const el = document.createElement('div');
  el.className = 'room-item';
  el.id = `room-${name}`;
  el.textContent = name;
  el.onclick = () => switchRoom(name);
  document.getElementById('rooms-list').appendChild(el);
}

function joinRoom() {
  const input = document.getElementById('new-room-input');
  const name = input.value.trim().replace(/\s+/g, '-').toLowerCase();
  if (!name) return;
  input.value = '';
  addRoomToSidebar(name);
  switchRoom(name);
}

function switchRoom(name) {
  currentRoom = name;
  document.querySelectorAll('.room-item').forEach(el => {
    el.classList.toggle('active', el.id === `room-${name}`);
  });
  document.getElementById('room-title').textContent = name;
  document.getElementById('no-room').style.display = 'none';
  const chatMain = document.getElementById('chat-main');
  chatMain.style.display = 'flex';
  chatMain.style.flexDirection = 'column';
  chatMain.style.overflow = 'hidden';
  chatMain.style.flex = '1';
  document.getElementById('messages').innerHTML = '';
  document.getElementById('users-list').innerHTML = '';
  sendWS({ type: 'join_room', room: name });
}

// ── Messages ──
function sendMessage() {
  const input = document.getElementById('msg-input');
  const text = input.value.trim();
  if (!text || !currentRoom) return;
  input.value = '';
  sendWS({ type: 'message', text });
}

function appendMessage(msg) {
  const el = document.createElement('div');
  el.className = `msg ${msg.from === myUsername ? 'mine' : 'theirs'}`;
  el.innerHTML = `<div class="meta">${msg.from === myUsername ? 'ты' : msg.from} · ${msg.time}</div>${escHtml(msg.text)}`;
  const box = document.getElementById('messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function addSystemMsg(text) {
  const el = document.createElement('div');
  el.className = 'msg-system';
  el.textContent = text;
  const box = document.getElementById('messages');
  box.appendChild(el);
  box.scrollTop = box.scrollHeight;
}

function updateUsers(users) {
  const list = document.getElementById('users-list');
  list.innerHTML = '';
  users.forEach(u => {
    if (u === myUsername) return;
    const el = document.createElement('div');
    el.className = 'user-item';
    el.innerHTML = `<span>${u}</span><button class="call-btn" onclick="startCall('${u}')">📞</button>`;
    list.appendChild(el);
  });
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── WebRTC calls ──
async function startCall(target) {
  callTarget = target;
  isCaller = true;
  await setupLocalStream();
  peerConnection = createPC();

  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);

  sendWS({ type: 'call_offer', target, sdp: offer });
  showCallUI(target, 'ИСХОДЯЩИЙ ЗВОНОК', false);
}

function receiveCall(msg) {
  callTarget = msg.from;
  isCaller = false;
  window._pendingOffer = msg.sdp;
  showCallUI(msg.from, 'ВХОДЯЩИЙ ЗВОНОК', true);
}

async function acceptCall() {
  await setupLocalStream();
  peerConnection = createPC();

  await peerConnection.setRemoteDescription(new RTCSessionDescription(window._pendingOffer));
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);

  sendWS({ type: 'call_answer', target: callTarget, sdp: answer });
  showCallUI(callTarget, 'ЗВОНОК', false);
}

async function handleAnswer(sdp) {
  if (!peerConnection) return;
  await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
  document.getElementById('call-status').textContent = 'ЗВОНОК';
  document.getElementById('call-actions').innerHTML =
    `<button class="btn btn-danger" onclick="endCall()">Завершить</button>`;
}

function handleIceCandidate(candidate) {
  if (peerConnection && candidate) {
    peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }
}

function rejectCall() {
  sendWS({ type: 'call_reject', target: callTarget });
  hideCallOverlay();
}

function endCall() {
  sendWS({ type: 'call_end', target: callTarget });
  endCallUI('Звонок завершён');
}

function endCallUI(reason) {
  addSystemMsg(reason);
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  document.getElementById('remote-audio').srcObject = null;
  hideCallOverlay();
}

function createPC() {
  const pc = new RTCPeerConnection(iceConfig);

  if (localStream) localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

  pc.onicecandidate = (e) => {
    if (e.candidate) sendWS({ type: 'ice_candidate', target: callTarget, candidate: e.candidate });
  };

  pc.ontrack = (e) => {
    document.getElementById('remote-audio').srcObject = e.streams[0];
  };

  return pc;
}

async function setupLocalStream() {
  localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
}

function showCallUI(name, status, showAccept) {
  document.getElementById('call-avatar').textContent = name[0].toUpperCase();
  document.getElementById('call-name').textContent = name;
  document.getElementById('call-status').textContent = status;
  document.getElementById('call-actions').innerHTML = showAccept
    ? `<button class="btn btn-success" onclick="acceptCall()">Принять</button>
       <button class="btn btn-danger" onclick="rejectCall()">Отклонить</button>`
    : `<button class="btn btn-danger" onclick="endCall()">Завершить</button>`;
  document.getElementById('call-overlay').classList.add('visible');
}

function hideCallOverlay() {
  document.getElementById('call-overlay').classList.remove('visible');
  callTarget = null;
}
