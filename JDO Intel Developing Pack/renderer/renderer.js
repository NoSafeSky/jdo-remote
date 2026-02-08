const statusEl = document.getElementById('status');
const hostSessionPill = document.getElementById('host-session-pill');
const debugLogEl = document.getElementById('debug-log');

let config;
let localSessionId;
let ws;
let pc;
let pendingRemoteCandidates = [];
let awaitingApproval = false;
let modalEl;
let btnAgree;
let btnCancel;
let reconnectTimer;
let hostPingTimer;

function log(msg) {
  console.log(msg);
  if (debugLogEl) {
    debugLogEl.hidden = false;
    const time = new Date().toISOString().substring(11, 19);
    debugLogEl.textContent += `[${time}] ${msg}\n`;
    debugLogEl.scrollTop = debugLogEl.scrollHeight;
  }
}

async function wsDataToString(data) {
  if (typeof data === 'string') return data;
  // Browser WebSocket may deliver Blob or ArrayBuffer
  if (data instanceof Blob) return data.text();
  if (data instanceof ArrayBuffer) return new TextDecoder('utf-8').decode(new Uint8Array(data));
  // Fallback
  return String(data);
}

function setStatus(text) {
  statusEl.textContent = text;
}

async function initConfig() {
  config = await window.electronAPI.getConfig();
  // Fallback to Render defaults if env not provided
  if (!config.SIGNALING_URL) config.SIGNALING_URL = 'https://jdo-signal.onrender.com';
  if (!config.WS_URL) config.WS_URL = 'wss://jdo-signal.onrender.com/ws';
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

async function fetchSession(sessionId) {
  const res = await fetch(`${config.SIGNALING_URL}/session/${sessionId}`);
  if (!res.ok) throw new Error('Session not found');
  return res.json();
}

// Minimal UI mode: only fetch and show session ID.

function showSecurityPrompt() {
  if (modalEl) {
    modalEl.classList.add('show');
    modalEl.hidden = false;
  }
}

function hideSecurityPrompt() {
  if (modalEl) {
    modalEl.classList.remove('show');
    modalEl.hidden = true;
  }
}

function wireSecurityActions() {
  modalEl = document.getElementById('security-modal');
  btnAgree = document.getElementById('btn-security-agree');
  btnCancel = document.getElementById('btn-security-cancel');

  if (modalEl) {
    modalEl.classList.remove('show');
    modalEl.hidden = true;
  }

  if (btnAgree) {
    btnAgree.addEventListener('click', async () => {
      hideSecurityPrompt();
      if (awaitingApproval) {
        awaitingApproval = false;
        await startHost();
      }
    });
  }
  if (btnCancel) {
    btnCancel.addEventListener('click', () => {
      if (awaitingApproval) {
        sendSignal({ type: 'sync-denied' });
      }
      awaitingApproval = false;
      pendingRemoteCandidates = [];
      hideSecurityPrompt();
      setStatus('Cancelled');
    });
  }
}

function connectSignaling(sessionId, role) {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(`${config.WS_URL}?sessionId=${encodeURIComponent(sessionId)}&role=${encodeURIComponent(role)}`);

    ws.onopen = () => {
      log('Signaling connected');
      sendSignal({ type: 'host-online' });
      if (hostPingTimer) {
        clearInterval(hostPingTimer);
      }
      hostPingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) {
          sendSignal({ type: 'host-online' });
          log('Host online ping');
        }
      }, 3000);
      resolve();
    };
    ws.onerror = (e) => {
      log('Signaling error');
      reject(e);
    };
    ws.onclose = (e) => {
      log(`Signaling closed (code=${e.code} reason=${e.reason || 'n/a'})`);
      if (hostPingTimer) {
        clearInterval(hostPingTimer);
        hostPingTimer = null;
      }
      if (!reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connectSignaling(localSessionId, 'host').catch(() => {});
        }, 2000);
      }
    };
    ws.onmessage = async (event) => {
      let msg;
      try {
        const raw = await wsDataToString(event.data);
        msg = JSON.parse(raw);
      } catch (e) {
        log(`WS message parse failed: ${e?.message || e}`);
        return;
      }
      if (msg.type === 'sync-request') {
        awaitingApproval = true;
        setStatus('Awaiting approval');
        showSecurityPrompt();
        sendSignal({ type: 'sync-received' });
      } else if (msg.type === 'host-online') {
        // ignore
      } else if (msg.type === 'sync-received') {
        log('Viewer sync received (echo)');
      } else if (msg.type === 'answer') {
        if (pc) {
          await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
          setStatus('Connected');
        }
      } else if (msg.type === 'ice') {
        if (msg.candidate) {
          if (pc) {
            await pc.addIceCandidate(msg.candidate);
          } else {
            pendingRemoteCandidates.push(msg.candidate);
          }
        }
      } else if (msg.type === 'peer-disconnect') {
        setStatus('Disconnected');
      }
    };
  });
}

function sendSignal(payload) {
  ws?.send(JSON.stringify(payload));
}

async function setupPeer() {
  pc = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  });

  pc.onicecandidate = (e) => {
    if (e.candidate) sendSignal({ type: 'ice', candidate: e.candidate });
  };

  pc.onconnectionstatechange = () => setStatus(`Peer: ${pc.connectionState}`);

  pc.onconnectionstatechange = () => setStatus(`Peer: ${pc.connectionState}`);
}

async function startHost() {
  setStatus('Preparing host...');
  await setupPeer();

  const sources = await window.electronAPI.getSources();
  const primary = sources[0];
  if (!primary) {
    setStatus('No screen source');
    return;
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: primary.id,
      },
    },
  });

  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  for (const cand of pendingRemoteCandidates) {
    await pc.addIceCandidate(cand);
  }
  pendingRemoteCandidates = [];

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendSignal({ type: 'offer', sdp: offer.sdp });
  setStatus('Waiting for response...');
}

function generateLocalId() {
  return `JDO-${Math.random().toString(36).slice(2, 6).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

async function bootstrap() {
  setStatus('Initializing...');
  await initConfig();

  log(`WS_URL=${config.WS_URL}`);

  wireSecurityActions();

  const storedId = window.localStorage.getItem('jdo-session-id');
  if (storedId) {
    localSessionId = storedId;
    hostSessionPill.textContent = localSessionId;
    setStatus('Ready');
    log(`Using saved ID: ${localSessionId}`);
    try {
      await fetchSession(storedId);
    } catch (e) {
      log('Saved ID expired. Creating a new ID...');
      localSessionId = null;
    }
  }

  if (!localSessionId) {
    try {
      const session = await createSession();
      localSessionId = session.sessionId;
    } catch (e) {
      log(`Server ID failed, using local ID: ${e.message || e}`);
      localSessionId = generateLocalId();
    }

    window.localStorage.setItem('jdo-session-id', localSessionId);
    hostSessionPill.textContent = localSessionId;
    setStatus('Ready');
    log(`Your ID: ${localSessionId}`);
  }
  await connectSignaling(localSessionId, 'host');
  setStatus('Waiting for request');
}

bootstrap();