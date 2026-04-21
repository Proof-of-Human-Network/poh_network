'use strict';

const { spawn } = require('child_process');
const http = require('http');

const PORT = parseInt(process.env.OLLAMA_PORT || '11435', 10);
const MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

function isRunning() {
  return new Promise(resolve => {
    http.get(`http://localhost:${PORT}/api/tags`, res => {
      resolve(res.statusCode === 200);
    }).on('error', () => resolve(false));
  });
}

function waitUntilReady(retries = 20, delay = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = async () => {
      if (await isRunning()) return resolve();
      if (++attempts >= retries) return reject(new Error(`Ollama on :${PORT} did not start in time`));
      setTimeout(check, delay);
    };
    check();
  });
}

async function ensureRunning() {
  if (await isRunning()) {
    console.log(`[ollama] Already running on :${PORT}`);
    return;
  }
  console.log(`[ollama] Starting dedicated instance on :${PORT}...`);
  const proc = spawn('ollama', ['serve'], {
    env: { ...process.env, OLLAMA_HOST: `127.0.0.1:${PORT}` },
    detached: true,
    stdio: 'ignore'
  });
  proc.unref();
  await waitUntilReady();
  console.log(`[ollama] Ready on :${PORT} (model: ${MODEL})`);
}

// Called from server.js at startup — fire and forget
function start() {
  ensureRunning().catch(err => console.error('[ollama]', err.message));
}

module.exports = { start };

// Allow running directly: node scripts/start-ollama.js
if (require.main === module) {
  ensureRunning().catch(err => { console.error('[ollama]', err.message); process.exit(1); });
}
