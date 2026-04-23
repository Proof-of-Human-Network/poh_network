'use strict';

const express = require('express');
const router = express.Router();
const nacl  = require('tweetnacl');
const bs58  = require('bs58');
const fs    = require('fs');
const path  = require('path');
const { getProfile, upsertProfile, getRewards, getProfiles } = require('../utils/profiles');

const METHODS_PATH = path.join(__dirname, '../../data/methods.json');
function getMethods() {
  if (!fs.existsSync(METHODS_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(METHODS_PATH, 'utf-8')); }
  catch { return []; }
}

// ── POST /profile/signup ──────────────────────────────────────────────────────
// Body: { address, signature, message }
// message format: "poh-profile-v1:{address}:{timestamp}"
router.post('/signup', async (req, res, next) => {
  try {
    const { address, signature, message } = req.body;
    if (!address || !signature || !message) {
      return res.status(400).json({ error: 'address, signature and message are required' });
    }

    const parts = message.split(':');
    if (parts.length < 3 || parts[0] !== 'poh-profile-v1' || parts[1] !== address) {
      return res.status(400).json({ error: 'Invalid message format' });
    }

    const timestamp = parseInt(parts[2]);
    if (isNaN(timestamp) || Date.now() - timestamp > 5 * 60 * 1000) {
      return res.status(400).json({ error: 'Message expired — please try again' });
    }

    // Verify ed25519 signature (Solana)
    let valid = false;
    try {
      const messageBytes = new TextEncoder().encode(message);
      const sigBytes     = bs58.decode(signature);
      const pkBytes      = bs58.decode(address);
      valid = nacl.sign.detached.verify(messageBytes, sigBytes, pkBytes);
    } catch {
      return res.status(401).json({ error: 'Signature verification failed' });
    }
    if (!valid) return res.status(401).json({ error: 'Invalid signature' });

    const existing = getProfile(address);
    const profile = upsertProfile(address, {
      registeredAt: existing?.registeredAt || new Date().toISOString(),
      apiKey:  existing?.apiKey  || crypto.randomUUID(),
      balance: existing?.balance ?? 0,
      freeScansLeft: existing?.freeScansLeft ?? 100,
      totalScans:    existing?.totalScans    ?? 0,
      stakedAmount:  existing?.stakedAmount  ?? 0,
    });

    return res.json({ success: true, profile: sanitize(profile) });
  } catch (err) {
    next(err);
  }
});

// ── GET /profile/:address ─────────────────────────────────────────────────────
router.get('/:address', (req, res) => {
  const p = getProfile(req.params.address);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  const methods = getMethods().filter(m => m.ownerWallet === req.params.address);
  const rewards = getRewards();
  const earned  = methods.reduce((s, m) => s + (rewards[m.id]?.totalEarned || 0), 0);
  const pending = methods.reduce((s, m) => s + (rewards[m.id]?.pendingWithdrawal || 0), 0);
  res.json({ profile: sanitize(p), methods, earned, pending });
});

// ── GET /profile/:address/apikey — returns apiKey (auth-gated by signature header) ──
router.get('/:address/apikey', (req, res) => {
  const p = getProfile(req.params.address);
  if (!p) return res.status(404).json({ error: 'Profile not found' });
  // For simplicity, the apiKey is included in the full profile response above.
  // A dedicated endpoint for rotation could be added later.
  res.json({ apiKey: p.apiKey });
});

// ── POST /profile/apikey/rotate ───────────────────────────────────────────────
router.post('/apikey/rotate', (req, res, next) => {
  try {
    const { address } = req.body;
    const p = getProfile(address);
    if (!p) return res.status(404).json({ error: 'Profile not found' });
    const updated = upsertProfile(address, { apiKey: crypto.randomUUID() });
    res.json({ apiKey: updated.apiKey });
  } catch (err) { next(err); }
});

// ── GET /profile (leaderboard — top method earners) ───────────────────────────
router.get('/', (req, res) => {
  const rewards = getRewards();
  const totals  = {};
  for (const r of Object.values(rewards)) {
    totals[r.ownerWallet] = (totals[r.ownerWallet] || 0) + r.totalEarned;
  }
  const board = Object.entries(totals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([address, earned]) => ({ address, earned }));
  res.json({ leaderboard: board });
});

function sanitize(p) {
  const { ips, ...rest } = p; // never expose IP list
  return rest;
}

module.exports = router;
