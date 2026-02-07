const logEl = document.getElementById('log');
const statusEl = document.getElementById('status');
const sourceSelect = document.getElementById('source-select');
const remoteVideo = document.getElementById('remote-video');

const btnStartHost = document.getElementById('btn-start-host');
const btnJoin = document.getElementById('btn-join');
const btnCopySession = document.getElementById('btn-copy-session');
const btnClearLog = document.getElementById('btn-clear-log');
const btnSendFiles = document.getElementById('btn-send-files');
const btnRefreshId = document.getElementById('btn-refresh-id');

const hostSessionPill = document.getElementById('host-session-pill');
const joinSessionIdInput = document.getElementById('join-session-id');
const fileInput = document.getElementById('file-input');

let pc;
let dataChannel;
let ws;
let config;
let localSessionId;

const CHUNK_SIZE = 60 * 1024; // 60KB chunks for datachannel
let incomingFile = null; // { name, size, type, received, chunks: [] }

function log(msg) {
  const time = new Date().toISOString().substring(11, 19);
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function loadSources() {
  const sources = await window.electronAPI.getSources();
  sourceSelect.innerHTML = '';
  sources.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    sourceSelect.appendChild(opt);
  });
}

async function initConfig() {
  config = await window.electronAPI.getConfig();
  // Fallback to hardcoded LAN defaults if env not provided
  if (!config.SIGNALING_URL) config.SIGNALING_URL = 'http://192.168.1.15:3001';
  if (!config.WS_URL) config.WS_URL = 'ws://192.168.1.15:3001/ws';
}

async function createSession() {
  const res = await fetch(`${config.SIGNALING_URL}/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: null }),
  });
  if (!res.ok) throw new Error('Failed to create session');
  return res.json();
}

function connectSignaling(sessionId, role) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`${config.WS_URL}?sessionId=${encodeURIComponent(sessionId)}&role=${encodeURIComponent(role)}`);

    ws.onopen = () => {
      log('Signaling connected');
      resolve();
    };
    ws.onerror = (e) => {
      log('Signaling error');
      reject(e);
    };
    ws.onclose = () => log('Signaling closed');
    ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'offer') {
        await handleOffer(msg);
      } else if (msg.type === 'answer') {
        await handleAnswer(msg);
      } else if (msg.type === 'ice') {
        if (msg.candidate) await pc.addIceCandidate(msg.candidate);
      }
    };
  });
}

function sendSignal(payload) {
  ws?.send(JSON.stringify(payload));
}

async function setupPeer(role) {
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      // Add TURN here if available, e.g., { urls: 'turn:your-turn:3478', username, credential }
    ],
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ type: 'ice', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => setStatus(`Peer: ${pc.connectionState}`);

  pc.ontrack = (event) => {
    remoteVideo.srcObject = event.streams[0];
  };

  if (role === 'host') {
    dataChannel = pc.createDataChannel('data');
    setupDataChannel(dataChannel);
  } else {
    pc.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannel(dataChannel);
    };
  }
}

function setupDataChannel(dc) {
  dc.binaryType = 'arraybuffer';
  dc.onopen = () => log('Data channel open');
  dc.onmessage = (event) => {
    handleData(event.data);
  };
  dc.onclose = () => log('Data channel closed');
}

function handleData(raw) {
  try {
    const msg = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (msg && msg.type === 'files-meta') {
      incomingFile = { name: msg.name, size: msg.size, type: msg.mimetype || 'application/octet-stream', received: 0, chunks: [] };
      log(`Receiving file ${incomingFile.name} (${Math.round(incomingFile.size / 1024)} KB)`);
    } else if (msg && msg.type === 'files-complete') {
      if (incomingFile) {
        const blob = new Blob(incomingFile.chunks, { type: incomingFile.type });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = incomingFile.name;
        a.click();
        URL.revokeObjectURL(url);
        log(`Saved file ${incomingFile.name}`);
        incomingFile = null;
      }
    } else if (msg && msg.type === 'files-chunk') {
      // Not expected as JSON; chunks come as ArrayBuffer.
    } else {
      log(`Data: ${raw}`);
    }
  } catch (e) {
    // Might be binary chunk
    if (incomingFile && raw instanceof ArrayBuffer) {
      incomingFile.chunks.push(raw);
      incomingFile.received += raw.byteLength;
      const pct = ((incomingFile.received / incomingFile.size) * 100).toFixed(1);
      log(`Receiving chunk... ${pct}%`);
    } else {
      log('Unknown data received');
    }
  }
}

async function startHost() {
  setStatus('Preparing host...');

  await initConfig();
  if (!localSessionId) {
    const session = await createSession();
    localSessionId = session.sessionId;
    hostSessionPill.textContent = localSessionId;
  }

  await connectSignaling(localSessionId, 'host');
  await setupPeer('host');

  const sourceId = sourceSelect.value;
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: sourceId,
      },
    },
  });
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', sdp: offer.sdp });

  setStatus(`Hosting. Session ID: ${localSessionId}`);
  log(`Hosting with session ${localSessionId}`);
}

async function joinSession() {
  setStatus('Joining...');
  await initConfig();
  const sessionId = joinSessionIdInput.value.trim();
  await connectSignaling(sessionId, 'viewer');
  await setupPeer('viewer');
  setStatus('Waiting for offer...');
}

async function handleOffer(msg) {
  await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendSignal({ type: 'answer', sdp: answer.sdp });
  setStatus('Connected');
  log('Answer sent');
}

async function handleAnswer(msg) {
  await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
  setStatus('Connected');
  log('Answer received');
}

btnStartHost.addEventListener('click', () => {
  startHost().catch((e) => { log(e.message || e); setStatus('Error'); });
});

btnJoin.addEventListener('click', () => {
  joinSession().catch((e) => { log(e.message || e); setStatus('Error'); });
});

btnCopySession.addEventListener('click', () => {
  navigator.clipboard.writeText(hostSessionPill.textContent || '');
});

btnRefreshId.addEventListener('click', async () => {
  try {
    setStatus('Refreshing ID...');
    const session = await createSession();
    localSessionId = session.sessionId;
    hostSessionPill.textContent = localSessionId;
    log(`New ID: ${localSessionId}`);
    setStatus('Ready');
  } catch (e) {
    setStatus('Error');
    log(e.message || e);
  }
});

btnClearLog.addEventListener('click', () => {
  logEl.textContent = '';
});

btnSendFiles.addEventListener('click', () => {
  if (!dataChannel || dataChannel.readyState !== 'open') {
    log('Data channel not open');
    return;
  }
  const files = fileInput.files;
  if (!files || files.length === 0) {
    log('No files selected');
    return;
  }
  // For now, send the first file only (folder input gives entries). Extendable to multiple.
  const file = files[0];
  if (!file) return;
  log(`Sending ${file.name} (${Math.round(file.size / 1024)} KB)`);

  // Send metadata
  dataChannel.send(JSON.stringify({ type: 'files-meta', name: file.name, size: file.size, mimetype: file.type || 'application/octet-stream' }));

  const reader = new FileReader();
  let offset = 0;

  reader.onload = (e) => {
    if (e.target.error) {
      log('File read error');
      return;
    }
    const buffer = e.target.result;
    dataChannel.send(buffer);
    offset += buffer.byteLength;
    const pct = ((offset / file.size) * 100).toFixed(1);
    log(`Sent chunk... ${pct}%`);
    if (offset < file.size) {
      readSlice(offset);
    } else {
      dataChannel.send(JSON.stringify({ type: 'files-complete' }));
      log('File send complete');
    }
  };

  const readSlice = (o) => {
    const slice = file.slice(o, o + CHUNK_SIZE);
    reader.readAsArrayBuffer(slice);
  };

  readSlice(0);
});

async function bootstrap() {
  setStatus('Initializing...');
  await initConfig();
  loadSources().catch(console.error);
  try {
    const session = await createSession();
    localSessionId = session.sessionId;
    hostSessionPill.textContent = localSessionId;
    setStatus('Ready');
    log(`Your ID: ${localSessionId}`);
  } catch (e) {
    setStatus('Error creating ID');
    log(e.message || e);
  }
}

bootstrap();