#!/usr/bin/env node
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { v4: uuid } = require('uuid');
const http = require('http');
const { createClient } = require('redis');

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Signal server is running');
});

// Redis-backed session store (persistent across restarts)
// Render: add a Redis instance and set REDIS_URL in env.
const REDIS_URL = process.env.REDIS_URL;
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 30); // 30 days

let redis;

async function initRedis() {
  if (!REDIS_URL) {
    console.warn('REDIS_URL not set. Falling back to in-memory sessions (NOT persistent).');
    return null;
  }
  const client = createClient({ url: REDIS_URL });
  client.on('error', (err) => console.error('Redis error', err));
  await client.connect();
  console.log('Redis connected');
  return client;
}

// In-memory fallback (only used when REDIS_URL missing)
const sessionsMem = new Map();

function sessionKey(id) {
  return `session:${id}`;
}

async function saveSession(sessionId, session) {
  if (redis) {
    await redis.set(sessionKey(sessionId), JSON.stringify(session), { EX: SESSION_TTL_SECONDS });
    return;
  }
  sessionsMem.set(sessionId, session);
}

async function getSession(sessionId) {
  if (redis) {
    const raw = await redis.get(sessionKey(sessionId));
    return raw ? JSON.parse(raw) : null;
  }
  return sessionsMem.get(sessionId) || null;
}

app.post('/session', (req, res) => {
  const { password } = req.body || {};
  const sessionId = uuid().slice(0, 8);
  const session = { createdAt: Date.now(), password: password || null };
  Promise.resolve()
    .then(() => saveSession(sessionId, session))
    .then(() => res.json({ sessionId, password: password || null }))
    .catch((e) => {
      console.error('Failed to create session', e);
      res.status(500).json({ error: 'create_failed' });
    });
});

app.get('/session/:id', (req, res) => {
  const { id } = req.params;
  Promise.resolve()
    .then(() => getSession(id))
    .then((session) => {
      if (!session) return res.status(404).json({ error: 'not_found' });
      res.json({ sessionId: id, password: session.password });
    })
    .catch((e) => {
      console.error('Session lookup failed', e);
      res.status(500).json({ error: 'lookup_failed' });
    });
});

const server = http.createServer(app);

// WebSocket signaling: clients connect with ws://host:PORT/ws?sessionId=xxxx&role=host|viewer&password=optional
const wss = new WebSocketServer({ server, path: '/ws' });

function getSessionClients(sessionId) {
  return [...wss.clients].filter((c) => c.readyState === 1 && c.sessionId === sessionId);
}

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const sessionId = params.get('sessionId');
  const role = params.get('role') || 'viewer';
  const password = params.get('password') || null;

  if (!sessionId) {
    ws.close(1008, 'sessionId required');
    return;
  }

  Promise.resolve()
    .then(() => getSession(sessionId))
    .then((session) => {
      if (!session) {
        ws.close(1008, 'session not found');
        return;
      }

      if (session.password && session.password !== password) {
        ws.close(1008, 'invalid password');
        return;
      }

      ws.sessionId = sessionId;
      ws.role = role;

      ws.on('message', (data, isBinary) => {
        const peers = getSessionClients(sessionId).filter((c) => c !== ws);
        // Ensure JSON signaling stays TEXT frames between browser clients.
        const payload = isBinary ? data : data.toString('utf8');
        for (const peer of peers) {
          peer.send(payload, { binary: isBinary });
        }
      });

      ws.on('close', () => {
        // Notify peers that a participant left
        const peers = getSessionClients(sessionId);
        peers.forEach((peer) => {
          try {
            peer.send(JSON.stringify({ type: 'peer-disconnect', role }));
          } catch (_) {
            /* noop */
          }
        });
      });
    })
    .catch((e) => {
      console.error('WS session validation failed', e);
      try {
        ws.close(1011, 'server error');
      } catch (_) {
        /* noop */
      }
    });
});

initRedis()
  .then((client) => {
    redis = client;
    server.listen(PORT, HOST, () => {
      console.log(`Signaling server listening on http://${HOST}:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('Failed to init Redis', e);
    server.listen(PORT, HOST, () => {
      console.log(`Signaling server listening on http://${HOST}:${PORT}`);
    });
  });
