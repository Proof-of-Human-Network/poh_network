#!/usr/bin/env bash
# Remote Ubuntu server setup — installs all system dependencies and starts POH
# Usage: bash scripts/setup.sh [dev|prod]
#   Run from the project root, or from anywhere — script auto-detects APP_DIR.
set -euo pipefail

MODE="${1:-prod}"
NODE_VERSION="22"

# Auto-detect project root (parent of this script's directory)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

log()  { echo -e "\n\033[1;34m▶ $*\033[0m"; }
ok()   { echo -e "\033[1;32m✓ $*\033[0m"; }
warn() { echo -e "\033[1;33m⚠ $*\033[0m"; }

echo ""
echo "  POH Setup — mode: $MODE"
echo "  App dir: $APP_DIR"
echo ""

# ── 1. System packages ────────────────────────────────────────────────────────
log "Updating apt and installing base packages"
sudo apt-get update -qq
sudo apt-get install -y -qq \
  curl git build-essential redis-server \
  ca-certificates gnupg lsb-release \
  zstd pv wget tar gzip \
  libvulkan1

ok "System packages installed"

# ── 2. Node.js ────────────────────────────────────────────────────────────────
CURRENT_NODE=0
if command -v node &>/dev/null; then
  CURRENT_NODE="$(node -e 'process.stdout.write(process.version.slice(1).split(".")[0])')"
fi
if [[ "$CURRENT_NODE" -lt "$NODE_VERSION" ]]; then
  log "Installing Node.js $NODE_VERSION LTS"
  curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | sudo -E bash - 2>/dev/null
  sudo apt-get install -y -qq nodejs
else
  ok "Node.js $(node -v) already installed"
fi

# ── 3. Yarn ───────────────────────────────────────────────────────────────────
if ! command -v yarn &>/dev/null; then
  log "Installing Yarn"
  sudo npm install -g yarn --quiet
else
  ok "Yarn $(yarn -v) already installed"
fi

# ── 4. Redis ──────────────────────────────────────────────────────────────────
log "Enabling Redis"
sudo systemctl enable redis-server --quiet
sudo systemctl restart redis-server
ok "Redis running"

# ── 5. Ollama ─────────────────────────────────────────────────────────────────
if ! command -v ollama &>/dev/null; then
  log "Installing Ollama"
  curl -fsSL https://ollama.com/install.sh | sh
else
  ok "Ollama $(ollama --version 2>&1 | head -1) already installed"
fi

log "Enabling Ollama service"
sudo systemctl enable ollama --quiet 2>/dev/null || true
sudo systemctl start  ollama          2>/dev/null || true

# Wait for Ollama to be ready
log "Waiting for Ollama to start"
for i in $(seq 1 20); do
  if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    ok "Ollama is up"
    break
  fi
  sleep 2
done

log "Pulling Ollama models (background — this takes a while)"
# Roles: Learner → qwen2.5:1.5b  |  Compiler → deepseek-r1:1.5b  |  fallback → mixtral
(
  ollama pull qwen2.5:1.5b       2>&1 | tail -1 && echo "[setup] ✓ qwen2.5:1.5b ready"     || echo "[setup] ⚠ qwen2.5:1.5b failed"
  ollama pull deepseek-r1:1.5b   2>&1 | tail -1 && echo "[setup] ✓ deepseek-r1:1.5b ready" || echo "[setup] ⚠ deepseek-r1:1.5b failed"
  ollama pull mixtral             2>&1 | tail -1 && echo "[setup] ✓ mixtral ready"           || echo "[setup] ⚠ mixtral failed"
  echo "[setup] All Ollama models done"
) &
disown

# ── 6. Qvac CLI + SDK ─────────────────────────────────────────────────────────
if ! command -v qvac &>/dev/null; then
  log "Installing Qvac CLI + SDK globally"
  sudo npm install -g @qvac/cli @qvac/sdk --quiet
else
  ok "Qvac $(qvac --version 2>&1 | head -1) already installed"
fi

# Pull the Qvac evaluator model (QWEN3_600M_INST_Q4 defined in qvac.config.json)
log "Pulling Qvac evaluator model"
cd "$APP_DIR"
qvac pull QWEN3_600M_INST_Q4 2>&1 || warn "Qvac model pull failed — run 'qvac pull QWEN3_600M_INST_Q4' manually"

# ── 7. Project dependencies ───────────────────────────────────────────────────
log "Installing backend dependencies"
cd "$APP_DIR"
npm install --prefer-offline --no-audit --no-fund 2>&1 | tail -3

log "Installing frontend dependencies"
cd "$APP_DIR/frontend"
npm install --prefer-offline --no-audit --no-fund 2>&1 | tail -3

# ── 8. Frontend build (prod only) ─────────────────────────────────────────────
if [[ "$MODE" == "prod" ]]; then
  log "Building frontend"
  cd "$APP_DIR/frontend"
  npm run build
  ok "Frontend built → $APP_DIR/frontend/dist"
fi

# ── 9. Environment file ───────────────────────────────────────────────────────
cd "$APP_DIR"
if [[ ! -f ".env" ]]; then
  if [[ -f ".env.example" ]]; then
    cp .env.example .env
    warn ".env created from .env.example — edit it and set SOLANA_RPC, FEE_RECIPIENT, etc."
  else
    warn "No .env found and no .env.example — create $APP_DIR/.env before starting the service"
  fi
else
  ok ".env already exists"
fi

# ── 10. Systemd service ───────────────────────────────────────────────────────
SERVICE_FILE="/etc/systemd/system/poh.service"
log "Installing systemd service → $SERVICE_FILE"

sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=POH — Proof of Human server
After=network.target redis-server.service ollama.service
Wants=redis-server.service

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node $APP_DIR/src/server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
EnvironmentFile=$APP_DIR/.env

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable poh

# Only start if .env exists and has the minimum required keys
if [[ -f "$APP_DIR/.env" ]] && grep -q "SOLANA_RPC" "$APP_DIR/.env" && ! grep -q "^SOLANA_RPC=$" "$APP_DIR/.env"; then
  sudo systemctl restart poh
  ok "POH service started"
else
  warn "POH service NOT started — fill in $APP_DIR/.env first, then: sudo systemctl start poh"
fi

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "┌──────────────────────────────────────────────────────────┐"
echo "│  Setup complete                                           │"
echo "│                                                           │"
echo "│  App:      http://$IP:3000                         │"
echo "│  Service:  sudo systemctl [start|stop|status|restart] poh │"
echo "│  Logs:     journalctl -u poh -f                           │"
echo "│                                                           │"
echo "│  Ollama models: downloading in background                 │"
echo "│  Qvac:  cd $APP_DIR && qvac serve openai                  │"
echo "│                                                           │"
if [[ ! -f "$APP_DIR/.env" ]] || grep -q "^SOLANA_RPC=$" "$APP_DIR/.env" 2>/dev/null; then
echo "│  ⚠  Edit $APP_DIR/.env then: sudo systemctl start poh     │"
fi
echo "└──────────────────────────────────────────────────────────┘"
