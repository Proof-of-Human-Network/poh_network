# Human-powered Proof of Human Network (POH)

A decentralized, AI-enhanced verification layer to identify human vs. automated behaviour across EVM and Solana ecosystems.

## Quick Start

```bash
# Install dependencies (backend + frontend)
npm install
cd frontend && npm install && cd ..

# Configure environment
cp .env.example .env
# Edit .env — set SOLANA_RPC, VOTE_TOKEN_MINT, FEE_RECIPIENT, ALCHEMY_KEY

# Start everything (backend + frontend + Ollama)
npm run dev:all        # hot-reload (nodemon + vite)
npm run start:all      # production
```

Runs at **http://localhost:3000** (backend serves built frontend at `/`).  
Frontend dev server: **http://localhost:5173**

---

## Architecture

```
poh/dev/
├── src/
│   ├── server.js              Express entry point
│   ├── routes/
│   │   ├── checker.js         POST /checker — scan address against all methods
│   │   ├── methods.js         POST /methods/listing, GET/POST /methods/verifyer
│   │   ├── abi.js             GET /abi/evm, GET /abi/solana — ABI/IDL fetch
│   │   ├── evm.js             POST /evm — raw EVM contract eval
│   │   └── rest.js            POST /rest — raw REST eval
│   ├── eval/
│   │   └── evaluator.js       Multi-language expression sandbox (JS/Go/Rust/PHP/Java)
│   └── utils/
│       ├── brain.js           Ollama AI brain — real-time humanness analysis
│       ├── scheduler.js       Hourly brain consolidation via node-cron
│       ├── redis.js           Response cache (falls back to in-memory)
│       ├── solana.js          Solana RPC helpers (balance, SPL token, burn verify)
│       └── evm.js             EVM RPC helpers (callContract, toHexSelector)
├── frontend/
│   └── src/components/
│       └── HumanPower.vue     Single-page Vue 3 app (Checker / Listing / Votes)
├── data/
│   ├── methods.json           Registered detection methods
│   ├── dataset.json           Scan + vote training records (Alpaca format)
│   └── brain_state.md         Ollama's accumulated knowledge (updated hourly)
└── scripts/
    └── start-ollama.js        Ensures dedicated Ollama instance on :11435
```

---

## Core APIs

### `POST /checker`
Scans an EVM or Solana address against all registered methods.

| Field | Description |
|---|---|
| `input` | EVM address, Solana address, Space ID name (`.eth`, `.bnb`, etc.), or CSV upload |
| `walletAddress` | Connected wallet (for burn verification) |
| `txHash` | VOTE burn transaction hash |
| `chainIds` | Optional filter, e.g. `1,56` |

Returns method results + async `brainKey` for AI verdict polling.

**`GET /checker/brain/:key`** — poll for the Ollama AI verdict after scanning.

### `POST /methods/listing`
Register a new detection method. Costs **0.01 SOL** per method.

Supported types: `evm` · `solana` · `rest`

### `GET/POST /methods/verifyer`
Community voting on methods. Weighted by VOTE token stake (PoS).

### `GET /abi/evm?address=&chainId=`
Fetches verified contract ABI from Etherscan → Sourcify fallback.
Returns list of functions with input/output types for the listing UI picker.

### `GET /abi/solana?programId=`
Fetches Anchor IDL from apr.dev registry or on-chain IDL account.

---

## Detection Methods (35 registered)

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

## AI Brain (Ollama)

POH runs a **dedicated Ollama instance on port 11435** (separate from other local Ollama usage).

- **On every scan** — Ollama analyses method results + community scores → returns `VERDICT` (HUMAN/AI), `CONFIDENCE`, and `REASONING`
- **On new method** — Ollama evaluates signal quality, updates `brain_state.md`
- **On every vote** — Ollama processes community feedback, updates `brain_state.md`
- **Hourly** — scheduler consolidates all data into an updated brain state (max ~400 words)

Model: `llama3.2` · Timeout: 2 minutes · URL configurable via `OLLAMA_URL` in `.env`

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
// Examples
result[0] > 0n                          // BigInt token balance > 0
result[0] / 10n ** BigInt(decimals) > 1 // normalised balance > 1
data.has_active_stake === 1             // REST field check
data.totalCount > 0                     // NFT count
```

Supported languages: **JS · Go · Rust · PHP · Java** (all normalized to JS sandbox)

---

## Tech Stack

| Layer | Tech |
|---|---|
| Backend | Node.js · Express · ethers.js v6 · @solana/web3.js · vm2 |
| Frontend | Vue 3 · Vite · Lucide icons |
| AI | Ollama (`llama3.2`) — local, dedicated instance on :11435 |
| Cache | Redis (in-memory fallback) |
| Scheduler | node-cron (hourly brain consolidation) |
| Wallet | Phantom · Solflare (Solana wallet adapter) |
| Multi-chain | 32 EVM chains via Alchemy + built-in RPC registry |

---

## Environment Variables

```env
PORT=3000
SOLANA_RPC=https://mainnet.helius-rpc.com/?api-key=...
VOTE_TOKEN_MINT=<SPL mint address>
FEE_RECIPIENT=<Solana wallet address>
ALCHEMY_KEY=<Alchemy API key>
OLLAMA_URL=http://localhost:11435
OLLAMA_MODEL=llama3.2
REDIS_URL=redis://localhost:6379
RPC_1=https://eth-mainnet.g.alchemy.com/v2/<key>
RPC_56=...   # add RPC_{chainId} for any EVM chain
```

---

© 2026 PROXIMA CORE | SECURED BY HUMAN POWER
# poh_network
