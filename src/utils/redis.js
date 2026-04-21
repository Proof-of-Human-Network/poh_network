'use strict';

const redis = require('redis');

const cacheFallback = new Map();
let useFallback = false;
let connected = false;

const client = redis.createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379',
  socket: { connectTimeout: 2000, reconnectStrategy: false }
});

client.on('error', () => {
  if (!useFallback) {
    console.warn('[redis] Connection error, using in-memory fallback');
    useFallback = true;
  }
});

client.on('connect', () => {
  connected = true;
  useFallback = false;
  console.log('[redis] Connected');
});

// Try once at startup; if it fails, stay on fallback
client.connect().catch(() => { useFallback = true; });

async function getCachedResponse(key) {
  if (useFallback || !connected) return cacheFallback.get(key) || null;
  try {
    const val = await client.get(key);
    return val ? JSON.parse(val) : null;
  } catch { return cacheFallback.get(key) || null; }
}

async function setCachedResponse(key, value, ttl = 3600) {
  if (useFallback || !connected) { cacheFallback.set(key, value); return; }
  try {
    await client.setEx(key, ttl, JSON.stringify(value));
  } catch { cacheFallback.set(key, value); }
}

async function clearCache() {
  if (useFallback || !connected) { cacheFallback.clear(); return; }
  try { await client.flushDb(); } catch { cacheFallback.clear(); }
}

module.exports = { getCachedResponse, setCachedResponse, clearCache };
