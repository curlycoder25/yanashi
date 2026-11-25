const express = require('express');
const cors = require('cors');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// In-memory store for couple invites, profiles, and health check
const invitesStore = new Map();
const couplesStore = new Map();

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', app: 'Yanasi', timestamp: new Date().toISOString() });
});

app.post('/api/invites', (req, res) => {
  const { code, ownerName, coupleId } = req.body || {};
  if (!code) {
    return res.status(400).json({ error: 'Invite code is required' });
  }
  const entry = {
    code: String(code).toUpperCase(),
    ownerName: ownerName || 'Jalə',
    coupleId: coupleId || `couple_${Date.now()}`,
    updatedAt: new Date().toISOString(),
  };
  invitesStore.set(entry.code, entry);
  return res.status(201).json(entry);
});

app.get('/api/invites/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  const entry = invitesStore.get(code);
  if (!entry) {
    return res.status(404).json({ error: 'Invite code not found' });
  }
  return res.json(entry);
});

app.put('/api/couples/:coupleId', (req, res) => {
  const { coupleId } = req.params;
  const existing = couplesStore.get(coupleId) || { coupleId };
  const updated = {
    ...existing,
    ...req.body,
    updatedAt: new Date().toISOString(),
  };
  couplesStore.set(coupleId, updated);
  return res.json(updated);
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Yanasi server running on http://localhost:${PORT}`);
});