# Proof of Human Network (POH)

A decentralized, AI-enhanced verification layer that identifies human vs. automated behaviour across EVM and Solana ecosystems. Detection methods are community-submitted and community-curated; an on-device multi-role AI brain produces weighted verdicts in real time.

---

## Quick Start

```bash
# Install dependencies (backend + frontend)
npm install
cd frontend && npm install && cd ..

# Configure environment
cp .env.example .env
# Edit .env — minimum required: SOLANA_RPC, FEE_RECIPIENT

# Pull AI models
ollama pull qwen2.5:1.5b      # Learner role
ollama pull deepseek-r1:1.5b  # Evaluator fallback
ollama pull mixtral            # Compiler role

# Start everything (Redis + Ollama + Qvac + backend + frontend)
npm run dev:all        # hot-reload (nodemon + vite dev server)
npm run start:all      # production build

# Redis must be installed separately:
# sudo apt-get install -y redis-server && sudo systemctl enable --now redis-server
```

Runs at **http://localhost:3000** (backend + built frontend).  
Dev frontend: **http://localhost:5173**

---

## Architecture

```
poh/dev/
├── src/
│   ├── server.js              Express entry — routes, config endpoint, static
│   ├── routes/
│   │   ├── checker.js         POST /checker — scan address against all methods
│   │   ├── methods.js         POST /methods/listing, GET/POST /methods/verifyer
│   │   ├── profile.js         GET/POST /profile — signup, API keys, rewards, faucet
│   │   ├── abi.js             GET /abi/evm, GET /abi/solana (ABI/IDL fetch)
│   │   ├── evm.js             POST /evm — raw EVM contract eval
│   │   └── rest.js            POST /rest — raw REST eval
│   ├── eval/
│   │   └── evaluator.js       Multi-language expression sandbox (JS/Go/Rust/PHP/Java)
│   └── utils/
│       ├── brain.js           Multi-role AI brain (Evaluator · Learner · Compiler)
│       ├── profiles.js        Profile storage — API keys, balances, votes, rewards
│       ├── jobQueue.js        Async job queue — bulk scans, 2 concurrent jobs, 5 wallets/batch
│       ├── scheduler.js       Hourly brain consolidation via node-cron
│       ├── redis.js           Response cache (falls back to in-memory)
│       ├── solana.js          Solana RPC helpers (balance, SPL token, burn verify)
│       └── evm.js             EVM RPC helpers (callContract, toHexSelector)
├── frontend/
│   └── src/components/
│       └── HumanPower.vue     Vue 3 SPA — Landing / Scanner / Listing / Votes / Profile
├── data/
│   ├── methods.json           Registered detection methods
│   ├── weights.json           Per-method AI weights (updated by Learner role)
│   ├── dataset.json           Scan + vote training records (Alpaca format)
│   ├── profiles.json          User profiles, API keys, balances
│   ├── rewards.json           Per-method scan earnings and pending withdrawals
│   ├── method_health.json     Per-method pass/fail stats
│   └── brain_state.md         Compiler output — compact system summary (updated hourly)
└── scripts/
    ├── setup.sh               Server provisioning — installs Node, Ollama, Qvac, Redis, builds app
    ├── deploy.sh              One-command deploy to remote server via SSH
    ├── launch.js              Orchestrator: Redis · Ollama · Qvac · backend · frontend
    ├── start-ollama.js        Ensures dedicated Ollama instance on :11434
    └── start-qvac.js          Ensures Qvac OpenAI-compatible server on :11435
```

---

## Core APIs

### `POST /checker`
Scans one or more wallet addresses against all registered methods.

| Field | Description |
|---|---|
| `input` | EVM address, Solana base58, ZNS domain (`.eth`, `.bnb`, `.defi`…), or array |
| `walletAddress` | Connected wallet (for free-tier tracking) |
| `apiKey` | API key from profile (alternative to `walletAddress`) |
| `txHash` | POH burn transaction hash (required for paid scans) |
| `chainIds` | Optional EVM chain filter, e.g. `1,56` |
| `csv` | Multipart CSV upload with `address` column (bulk mode) |

**Single address** → synchronous `{ result, count, brainKey, freeScansLeft }`.  
**Multiple addresses / CSV** → async `{ jobId, status: "queued", total, pollUrl }`.

### `GET /checker/job/:jobId`
Poll the status of a bulk scan job. Retained for 2 hours after completion.

```json
{
  "jobId": "...",
  "status": "queued | running | done",
  "total": 1000,
  "done": 423,
  "percent": 42,
  "results": [...],
  "errors": [...]
}
```

**Concurrency limits:** 2 jobs run simultaneously; within each job, 5 wallets are processed in parallel. Up to 10 concurrent API requests map onto 2 running jobs — additional jobs queue automatically.

```js
// Poll until complete
async function pollJob(jobId) {
  while (true) {
    const job = await fetch(`/checker/job/${jobId}`).then(r => r.json())
    if (job.status === 'done') return job.results
    await new Promise(r => setTimeout(r, 3000))
  }
}
```

### `GET /checker/brain/:key`
Poll for the async AI verdict after a single-wallet scan. `brainKey` is returned by `POST /checker`.

```json
{
  "status": "done",
  "verdict": "HUMAN | AI | UNCERTAIN",
  "confidence": 0.0,
  "reasoning": "...",
  "signal_contributions": { "method_name": 0.0 },
  "conflicts": []
}
```

### `GET /checker/pricing?count=N`
Returns cost breakdown for a given batch size before committing.

```json
{ "count": 100, "perAddress": 0.55, "total": 55000000, "tiers": [...] }
```

### `POST /methods/listing`
Register a new detection method. Costs **0.01 SOL** per method.

Supported types: `evm` · `solana` · `rest`

### `GET /methods/verifyer`
Returns all registered methods for the community voting queue.

### `POST /methods/verifyer/vote`
Community vote on a method. Vote weight is proportional to POH token stake. Uses ed25519 `signMessage` — no on-chain transaction required.

| Field | Type |
|---|---|
| `methodId` | string |
| `type` | `description` \| `method` \| `risk` |
| `vote` | boolean |
| `walletAddress` | string |
| `signature` | string — base58 ed25519 signature of `poh-vote-v1:{methodId}:{vote}:{timestamp}` |
| `message` | string — the signed message |
| `feedback` | string (optional) — LLM-validated before storing |

### `POST /methods/verifyer/validate-feedback`
LLM pre-check for vote feedback and method descriptions. Rejects gibberish, spam, and off-topic content.

```json
{ "feedback": "your comment", "context": "vote | description" }
→ { "valid": true | false, "reason": "..." }
```

### `GET /abi/evm?address=&chainId=`
Fetches verified ABI from Etherscan → Sourcify fallback. Returns function list with input/output types for the listing UI picker.

### `GET /abi/solana?programId=`
Fetches Anchor IDL from apr.dev registry or on-chain IDL account.

---

## Profile API

### `POST /profile/signup`
Create or update a profile. Requires ed25519 signature of `poh-profile-v1:{address}:{timestamp}`.

Returns `{ profile: { apiKey, balance, freeScansLeft, totalScans, stakedAmount } }`.

### `GET /profile/:address`
Returns profile stats, submitted methods, and reward totals.

### `GET /profile/:address/votes`
Returns the wallet's full vote history with method descriptions and feedback.

### `POST /profile/deposit`
Credit profile balance from a verified POH token transfer.

### `POST /profile/claim`
Withdraw off-chain balance + scan earnings as on-chain POH tokens.

### `POST /profile/apikey/rotate`
Rotate the API key for a profile.

### `GET /profile`
Leaderboard — top 20 method earners by total POH earned.

### `POST /profile/faucet`
**Devnet only.** Sends 10 000 POH to the caller. 24-hour cooldown per address.

---

## AI Brain

POH runs a **multi-role brain** entirely on-device via Ollama. Three separate model roles handle distinct responsibilities, each with enforced JSON output contracts.

### Download models

```bash
ollama pull deepseek-r1:1.5b
ollama pull qwen2.5:1.5b
ollama pull mixtral
```

### Role 1 — Evaluator (`analyzeHumanness`)
Called after every scan. Uses strict signal interpretation — no free-form guessing.

- Sends all passing signals + the top-10 failing signals by weight (compact format)
- Scores each signal contribution, detects conflicts between signals
- If signals are weak or conflicting → outputs `UNCERTAIN` instead of a false positive
- Runs a **second verification pass** after the first: checks for overconfidence (>0.85 needs strong multi-signal support) and ignored weights
- Appends `"You will be evaluated for consistency. Different outputs for similar inputs are considered failure."` to every prompt — stabilises weaker open models

**Optional: accelerate with Qvac**  
The Evaluator natively integrates with [Qvac](https://qvac.tether.io) — an on-device OpenAI-compatible inference server by Tether. When `QVAC_URL` is set, small quantised models (Qwen3 600M) run locally for faster verdicts with a heuristic fallback if JSON parsing fails. Ollama is used automatically when `QVAC_URL` is unset.

```bash
# Install Qvac CLI and SDK globally
npm install -g @qvac/cli @qvac/sdk

# Start the evaluator model (runs on :11435)
yarn qvac

# then in .env:
QVAC_URL=http://localhost:11435
QVAC_MODEL=evaluator
```

Model config lives in `qvac.config.json` at the project root. The Evaluator sends `POST /v1/chat/completions` — any OpenAI-compatible server works (LM Studio, llama.cpp ≥ b3670, Ollama with `/v1` prefix).

**Output schema:**
```json
{
  "verdict": "HUMAN | AI | UNCERTAIN",
  "confidence": 0.82,
  "signal_contributions": { "ETH Balance": 0.4, "ENS Name": 0.3 },
  "conflicts": [],
  "reasoning": "strong on-chain activity across 3 independent signals"
}
```

### Role 2 — Learner (`onVote`)
Called on every community vote. Updates `data/weights.json`.

- Adjusts per-method weights gradually — max ±0.05 per vote
- Weights clamped to 0.1–3.0; no single vote can cause large drift
- Penalises methods with conflicting vote history; rewards long-term accuracy
- Qwen 2.5 is recommended here (better structured output, less philosophical than reasoning models)

### Role 3 — Compiler (`consolidate`)
Runs hourly via scheduler. Rewrites `data/brain_state.md`.

- Reads top/weak methods by weight, last 8 scans, last 8 votes
- Outputs a ≤400-word technical summary — no speculation, no repetition
- Mixtral or DeepSeek recommended for speed + summarisation quality

### Method assessment (`onNewMethod`)
Called when a listing is submitted. Evaluates signal quality and edge-case risk (`none | low | medium | high`). Result is appended to `brain_state.md`.

### JSON contract enforcement
All brain calls use `evaluatorChatJSON()` / `ollamaChatJSON()`:
1. Extracts the first `{...}` block from model output
2. Validates required fields are present
3. On failure, retries once with: `"Your previous output was invalid. Fix format only."`

Qvac path additionally sets `response_format: { type: "json_object" }` for native JSON mode — eliminates the need for regex extraction on capable models.

---

## Expression Sandbox

Methods use expressions evaluated in a sandboxed VM. Available variables:

| Variable | Type | Description |
|---|---|---|
| `result` | `any[]` | ABI-decoded return values (EVM) |
| `data` | `object` | Parsed response body (REST) |
| `status` | `number` | HTTP status code (REST) |
| `decimals` | `number` | Configured decimals (default: 18 EVM, 9 Solana) |

```js
result[0] > 0n                           // BigInt token balance > 0
result[0] / 10n ** BigInt(decimals) > 1  // normalised balance > 1
data.has_active_stake === 1              // REST field check
data.totalCount > 0                      // NFT count
```

Supported languages: **JS · Go · Rust · PHP · Java** (all normalised to JS sandbox internally)

---

## Tech Stack

| Layer | Tech |
|---|---|
| Backend | Node.js · Express · ethers.js v6 · @solana/web3.js |
| Frontend | Vue 3 · Vite · Lucide icons |
| AI (Evaluator) | Qvac |
| AI (Learner · Compiler) | Ollama — local inference |
| Cache | Redis (in-memory fallback) |
| Scheduler | node-cron (hourly brain consolidation) |
| Wallet | @solana/wallet-adapter (Phantom · Solflare · Coinbase · Trust · Ledger · Torus · Nightly + Wallet Standard) |
| Multi-chain | 32 EVM chains via Alchemy + built-in RPC registry |

---

## Roadmap

### Done
- [x] Multi-chain EVM scanner (32 chains) + Solana + REST identity APIs
- [x] Community vote queue with stake-weighted scoring and ed25519 signature auth
- [x] Three-role local AI brain (Evaluator · Learner · Compiler) via Qvac + Ollama
- [x] Method listing with LLM pre-validation and on-chain payment (Anchor)
- [x] Staking contract integration — stake POH, earn from scan fees
- [x] Job queue for bulk CSV scanning with async polling
- [x] RWA detection methods: EVM (PAXG, Ondo, Goldfinch, RealT, Backed, Matrixdock, …) + Solana (Parcl, Artrade, Helium, Credix, …)
- [x] web3.bio social graph methods (Twitter, GitHub, Farcaster, Lens, ENS)
- [x] Galxe identity methods (humanityType, connected socials, Worldcoin, Solana address)
- [x] Vote feedback LLM validation — blocks gibberish comments
- [x] Vote confirmation modal — irreversible vote warning
- [x] Wallet adapter — all major Solana wallets via Wallet Standard
- [x] Devnet POH faucet (10 000 POH, 24h cooldown)
- [x] Profile system — API keys, off-chain balance, scan earnings, leaderboard
- [x] Nginx + Let's Encrypt SSL on proofofhuman.ge
- [x] Landing-only branch — standalone marketing page, no wallet/scanner surface

### Planned
- [ ] EVM wallet support (MetaMask / WalletConnect) for cross-chain identity
- [ ] Public API key dashboard with rate limits and usage stats
- [ ] Method marketplace — buy/sell detection method weights
- [ ] Browser extension — one-click POH badge on any wallet address
- [ ] DAO governance for method whitelist and score threshold changes
- [ ] ZK proof of humanness — export verifiable credential without revealing wallet

---

## Community

- Telegram: https://t.me/poh_network_group  
- X / Twitter: https://x.com/poh_network

---
