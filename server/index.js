#!/usr/bin/env node
const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const { v4: uuid } = require('uuid');
const http = require('http');

const PORT = process.env.PORT || 3001;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.status(200).send('Signal server is running');
});

// In-memory session store (ephemeral). In production, replace with Redis or database.
const sessions = new Map(); // sessionId -> { createdAt, password }

app.post('/session', (req, res) => {
  const { password } = req.body || {};
  const sessionId = uuid().slice(0, 8);
  sessions.set(sessionId, { createdAt: Date.now(), password: password || null });
  res.json({ sessionId, password: password || null });
});

app.get('/session/:id', (req, res) => {
  const { id } = req.params;
  const session = sessions.get(id);
  if (!session) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.json({ sessionId: id, password: session.password });
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

  const session = sessions.get(sessionId);
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

  ws.on('message', (data) => {
    const peers = getSessionClients(sessionId).filter((c) => c !== ws);
    for (const peer of peers) {
      peer.send(data);
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
});

server.listen(PORT, HOST, () => {
  console.log(`Signaling server listening on http://${HOST}:${PORT}`);
});
