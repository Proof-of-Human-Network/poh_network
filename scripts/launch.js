'use strict';

/**
 * launch.js — kills any existing POH processes, starts Redis + Ollama + Qvac (optional),
 * then launches backend + frontend via concurrently.
 *
 * Usage:
 *   node scripts/launch.js dev   → nodemon + vite dev
 *   node scripts/launch.js prod  → node + vite preview (or just node)
 */

require('dotenv').config();
const { execSync, spawn } = require('child_process');
const net = require('net');

const mode = process.argv[2] || 'dev';

function log(msg) {
  console.log(`[launch] ${msg}`);
}

function exec(cmd, opts = {}) {
  try {
    execSync(cmd, { stdio: 'pipe', ...opts });
    return true;
  } catch {
    return false;
  }
}

function isPortOpen(port) {
  return new Promise(resolve => {
    const s = net.createConnection(port, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    s.setTimeout(500, () => { s.destroy(); resolve(false); });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function findRedis() {
  const candidates = ['/usr/bin/redis-server', '/usr/local/bin/redis-server', '/snap/bin/redis-server'];
  for (const p of candidates) {
    try { require('fs').accessSync(p, require('fs').constants.X_OK); return p; } catch {}
  }
  // fallback: check PATH
  try { execSync('which redis-server', { stdio: 'pipe' }); return 'redis-server'; } catch {}
  return null;
}

async function ensureRedis() {
  if (await isPortOpen(6379)) {
    log('Redis already running on :6379');
    return;
  }

  // Try systemctl (works if redis was installed via apt)
  const started = exec('sudo systemctl restart redis-server 2>/dev/null') ||
                  exec('sudo systemctl restart redis 2>/dev/null');
  if (started) {
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (await isPortOpen(6379)) { log('Redis started via systemctl.'); return; }
    }
  }

  // Try direct binary
  const redisBin = findRedis();
  if (redisBin) {
    log(`Starting Redis via ${redisBin}...`);
    spawn(redisBin, ['--daemonize', 'yes'], { stdio: 'ignore', detached: true }).unref();
    for (let i = 0; i < 10; i++) {
      await sleep(500);
      if (await isPortOpen(6379)) { log('Redis started.'); return; }
    }
  } else {
    log('Redis not found. Run: sudo apt-get install -y redis-server && sudo systemctl enable redis-server');
  }

  log('WARNING: Redis did not start — will use in-memory fallback');
}

async function ensureOllama() {
  if (await isPortOpen(11434)) {
    log('Ollama already running on :11434');
    return;
  }
  log('Starting Ollama on port 11434...');
  const ollamaProc = spawn('ollama', ['serve'], {
    env: { ...process.env, OLLAMA_HOST: '0.0.0.0:11434' },
    stdio: 'ignore',
    detached: true,
  });
  ollamaProc.unref();
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    if (await isPortOpen(11434)) { log('Ollama started.'); return; }
  }
  log('WARNING: Ollama did not start within 20s — brain will be offline');
}

async function ensureQvac() {
  if (!process.env.QVAC_URL) return; // not configured — skip silently

  const port = parseInt((process.env.QVAC_URL || '').split(':').pop() || '11435', 10);
  if (await isPortOpen(port)) {
    log(`Qvac already running on :${port}`);
    return;
  }

  const path = require('path');
  const configPath = path.join(__dirname, '..', 'qvac.config.json');
  if (!require('fs').existsSync(configPath)) {
    log('WARNING: qvac.config.json not found — Evaluator will fall back to Ollama');
    return;
  }

  const args = ['serve', 'openai', '--port', String(port), '--host', '127.0.0.1', '--config', configPath, '--model', 'evaluator'];
  log(`Starting Qvac on :${port}...`);
  const proc = spawn('qvac', args, { stdio: 'ignore', detached: true, cwd: path.join(__dirname, '..') });
  proc.unref();
  proc.on('error', () => log('WARNING: qvac binary not found — run: npm install -g @qvac/cli'));

  for (let i = 0; i < 150; i++) {
    await sleep(1000);
    if (await isPortOpen(port)) { log('Qvac started.'); return; }
  }
  log('WARNING: Qvac did not start within 150s — Evaluator will fall back to Ollama');
}

function killExisting() {
  log('Stopping any existing backend/frontend processes...');
  // Kill processes listening on backend port 3000 and frontend port 5173
  exec("fuser -k 3000/tcp 2>/dev/null; fuser -k 5173/tcp 2>/dev/null");
  // Kill nodemon if running
  exec("pkill -f 'nodemon src/server.js' 2>/dev/null");
  exec("pkill -f 'node src/server.js' 2>/dev/null");
}

async function main() {
  log(`Mode: ${mode}`);

  killExisting();
  await sleep(500);

  await ensureRedis();
  await ensureOllama();
  await ensureQvac();

  const backendCmd = mode === 'dev'
    ? 'npx nodemon src/server.js'
    : 'node src/server.js';

  const frontendCmd = mode === 'dev'
    ? 'npm --prefix frontend run dev'
    : 'npm --prefix frontend run preview';

  log('Launching backend + frontend...');

  const proc = spawn(
    'npx',
    [
      'concurrently',
      '--names', 'BACKEND,FRONTEND',
      '--prefix-colors', 'white,cyan',
      backendCmd,
      frontendCmd,
    ],
    { stdio: 'inherit' }
  );

  proc.on('exit', code => process.exit(code || 0));
}

main().catch(err => { console.error(err); process.exit(1); });
