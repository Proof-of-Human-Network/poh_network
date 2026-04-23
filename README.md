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

# Start everything (Redis + Ollama + backend + frontend)
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
│   │   ├── abi.js             GET /abi/evm, GET /abi/solana (ABI/IDL fetch)
│   │   ├── evm.js             POST /evm — raw EVM contract eval
│   │   └── rest.js            POST /rest — raw REST eval
│   ├── eval/
│   │   └── evaluator.js       Multi-language expression sandbox (JS/Go/Rust/PHP/Java)
│   └── utils/
│       ├── brain.js           Multi-role AI brain (Evaluator · Learner · Compiler)
│       ├── scheduler.js       Hourly brain consolidation via node-cron
│       ├── redis.js           Response cache (falls back to in-memory)
│       ├── solana.js          Solana RPC helpers (balance, SPL token, burn verify)
│       └── evm.js             EVM RPC helpers (callContract, toHexSelector)
├── frontend/
│   └── src/components/
│       └── HumanPower.vue     Vue 3 SPA — Landing / Scanner / Listing / Votes
├── data/
│   ├── methods.json           Registered detection methods
│   ├── weights.json           Per-method AI weights (updated by Learner role)
│   ├── dataset.json           Scan + vote training records (Alpaca format)
│   └── brain_state.md         Compiler output — compact system summary (updated hourly)
└── scripts/
    ├── launch.js              Orchestrator: Redis · Ollama · backend · frontend
    └── start-ollama.js        Ensures dedicated Ollama instance on :11435
```

---

## Core APIs

### `POST /checker`
Scans a wallet against all registered methods in parallel.

| Field | Description |
|---|---|
| `input` | EVM address, Solana base58 address, Space ID name (`.eth`, `.bnb`…), or CSV upload |
| `walletAddress` | Connected wallet (for burn verification) |
| `txHash` | POH burn transaction hash |
| `chainIds` | Optional chain filter, e.g. `1,56` |

Returns `{ result, count, brainKey }`. Poll `brainKey` for the AI verdict.

**`GET /checker/brain/:key`**  
Poll for the async brain verdict after a scan. Returns:
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

### `POST /methods/listing`
Register a new detection method. Costs **0.01 SOL** per method.

Supported types: `evm` · `solana` · `rest`

### `GET /methods/verifyer`
Returns all registered methods for the community voting queue.

### `POST /methods/verifyer/vote`
Community vote on a method. Vote weight is proportional to POH token stake.

| Field | Type |
|---|---|
| `methodId` | string |
| `type` | `description` \| `method` \| `risk` |
| `vote` | boolean |
| `walletAddress` | string |
| `txHash` | string (0.001 SOL gas fee) |

### `GET /abi/evm?address=&chainId=`
Fetches verified ABI from Etherscan → Sourcify fallback. Returns function list with input/output types for the listing UI picker.

### `GET /abi/solana?programId=`
Fetches Anchor IDL from apr.dev registry or on-chain IDL account.

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

- Takes top 5 signals by community score + per-method weights from `weights.json`
- Scores each signal contribution, detects conflicts between signals
- If signals are weak or conflicting → outputs `UNCERTAIN` instead of a false positive
- Runs a **second verification pass** after the first: checks for overconfidence (>0.85 needs strong multi-signal support) and ignored weights
- Appends `"You will be evaluated for consistency. Different outputs for similar inputs are considered failure."` to every prompt — stabilises weaker open models

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
All brain calls use `ollamaChatJSON()`:
1. Extracts the first `{...}` block from model output
2. Validates required fields are present
3. On failure, retries once with: `"Your previous output was invalid. Fix format only."`

---

## Detection Methods (35 built-in)

### EVM Chains
| Chain | Methods |
|---|---|
| Ethereum (1) | ETH balance, tx count, USDC balance, AAVE deposit, Proof of Humanity |
| Base (8453) | ETH balance, tx count, USDC balance, WETH balance |
| Arbitrum (42161) | ETH balance, USDC balance |
| Polygon (137) | Tx count, USDC balance |
| BSC (56) | BNB balance, tx count, Assetux stake |
| Berachain (80094) | BERA balance, tx count, BGT token, HONEY token, WBERA token |

### Solana
| Method | Signal |
|---|---|
| `getBalance` | SOL balance > 0.01 SOL |
| `getTransactionCount` | Tx count > 5 |
| `getTokenBalance` (USDC) | USDC SPL balance > 0 |

### REST APIs
| API | Signal |
|---|---|
| Alchemy NFT (ETH/Polygon/Base) | NFT ownership > 0 |
| Farcaster | Has social profile |
| ENS (ensdata.net) | Has reverse ENS name |
| Etherscan | First tx > 90 days ago |
| Assetux Stake (ETH/BSC/Polygon) | Active staker |
| Lens Protocol | Has Lens profile |
| Snapshot | Has governance voting power |

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

## Environment Variables

```env
# Server
PORT=3000

# Solana
SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=...
POH_TOKEN_MINT=<SPL mint address>
FEE_RECIPIENT=<Solana wallet address>

# EVM
ALCHEMY_KEY=<Alchemy API key>
RPC_1=https://eth-mainnet.g.alchemy.com/v2/<key>
RPC_56=...        # RPC_{chainId} for any additional EVM chain

# Ollama — base model (fallback for all roles if role-specific vars not set)
OLLAMA_URL=http://localhost:11435
OLLAMA_MODEL=llama3.2

# Brain roles — override per role with a different model
# Recommended: DeepSeek R1 (evaluator), Qwen 2.5 (learner), Mixtral (compiler)
EVALUATOR_MODEL=deepseek-r1:1.5b
LEARNER_MODEL=qwen2.5:1.5b
COMPILER_MODEL=mixtral

# Cache
REDIS_URL=redis://localhost:6379
```

Pulling the recommended models:
```bash
ollama pull deepseek-r1:1.5b
ollama pull qwen2.5:1.5b
ollama pull mixtral
```

---

## $POH Token

Fair launch via bonding curve. No VC. No pre-mine.

| Allocation | % | Notes |
|---|---|---|
| Community Reward Pool | 80% | Bonding curve · scan fees · staking rewards |
| Team & Contributors | 20% | 1 month cliff · 6 month linear vesting |

Token utility: scan fee payment · stake-weighted voting · method reward distribution · burn-per-scan deflation.

---

## Tech Stack

| Layer | Tech |
|---|---|
| Backend | Node.js · Express · ethers.js v6 · @solana/web3.js |
| Frontend | Vue 3 · Vite · Lucide icons |
| AI | Ollama — local, multi-role (Evaluator · Learner · Compiler) |
| Cache | Redis (in-memory fallback) |
| Scheduler | node-cron (hourly brain consolidation) |
| Wallet | Phantom · Solflare (Solana) |
| Multi-chain | 32 EVM chains via Alchemy + built-in RPC registry |

---

## Community

- Telegram: https://t.me/poh_network_group  
- X / Twitter: https://x.com/poh_network

---

© 2026 PROXIMA CORE | SECURED BY HUMAN POWER
