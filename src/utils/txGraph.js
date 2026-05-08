'use strict';

const axios      = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');

const TX_LIMIT = 50;
const MIN_TXS  = 5;

// Etherscan v2 free tier covers ETH + Arbitrum. Base + BNB require paid plan.
// Base → Blockscout (free, no key). BNB → Alchemy (existing key via RPC_56).
const ETHERSCAN_V2  = 'https://api.etherscan.io/v2/api';
const BLOCKSCOUT_BASE = 'https://base.blockscout.com/api';

const ETHERSCAN_CHAINS = [
  { id: 1,     name: 'ETH' },
  { id: 42161, name: 'Arbitrum' },
];

// ── Etherscan v2: ETH + Arbitrum ─────────────────────────────────────────────

async function fetchEtherscanTxs(address, chainId) {
  const apikey = process.env.ETHERSCAN_API_KEY;
  if (!apikey) return null;
  try {
    const res = await axios.get(ETHERSCAN_V2, {
      params: { chainid: chainId, module: 'account', action: 'txlist',
                address, page: 1, offset: TX_LIMIT, sort: 'desc', apikey },
      timeout: 8000,
    });
    if (res.data?.status !== '1' || !Array.isArray(res.data.result)) return null;
    return res.data.result.map(tx => ({
      from: tx.from, to: tx.to,
      ts: parseInt(tx.timeStamp, 10),
    }));
  } catch { return null; }
}

// ── Blockscout: Base (free, no key) ──────────────────────────────────────────

async function fetchBlockscoutTxs(address) {
  try {
    const res = await axios.get(BLOCKSCOUT_BASE, {
      params: { module: 'account', action: 'txlist',
                address, page: 1, offset: TX_LIMIT, sort: 'desc' },
      timeout: 8000,
    });
    if (res.data?.status !== '1' || !Array.isArray(res.data.result)) return null;
    return res.data.result.map(tx => ({
      from: tx.from, to: tx.to,
      ts: parseInt(tx.timeStamp, 10),
    }));
  } catch { return null; }
}

// ── Alchemy: fetch BNB transactions via alchemy_getAssetTransfers ─────────────
// BNB (chainid=56) is not on Etherscan's free tier, so we use Alchemy instead.
// alchemy_getAssetTransfers covers external + internal + token transfers.

async function fetchAlchemyTxs(address) {
  const rpcUrl = process.env.RPC_56;
  if (!rpcUrl) return null;
  try {
    const [sent, received] = await Promise.all([
      axios.post(rpcUrl, {
        jsonrpc: '2.0', id: 1,
        method: 'alchemy_getAssetTransfers',
        params: [{ fromAddress: address, category: ['external', 'internal'],
                   maxCount: `0x${TX_LIMIT.toString(16)}`, order: 'desc' }],
      }, { timeout: 8000 }),
      axios.post(rpcUrl, {
        jsonrpc: '2.0', id: 2,
        method: 'alchemy_getAssetTransfers',
        params: [{ toAddress: address, category: ['external', 'internal'],
                   maxCount: `0x${TX_LIMIT.toString(16)}`, order: 'desc' }],
      }, { timeout: 8000 }),
    ]);
    const toNorm = t => ({
      from: t.from, to: t.to,
      ts: t.metadata?.blockTimestamp ? Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000) : 0,
    });
    const sentTxs     = sent.data?.result?.transfers?.map(toNorm)    || [];
    const receivedTxs = received.data?.result?.transfers?.map(toNorm) || [];
    // Deduplicate by hash position (no hash in response but dedup by from+to+ts)
    const seen = new Set();
    const all  = [];
    for (const t of [...sentTxs, ...receivedTxs]) {
      const key = `${t.from}:${t.to}:${t.ts}`;
      if (!seen.has(key)) { seen.add(key); all.push(t); }
    }
    return all.length >= MIN_TXS ? all.slice(0, TX_LIMIT) : null;
  } catch { return null; }
}

// ── Shared metric computation ─────────────────────────────────────────────────

function computeMetrics(address, txs) {
  const self = address.toLowerCase();
  const counterparties = new Set();
  const timestamps = [];
  let selfCount = 0;

  for (const tx of txs) {
    const from = (tx.from || '').toLowerCase();
    const to   = (tx.to   || '').toLowerCase();
    if (tx.ts) timestamps.push(tx.ts);
    const other = from === self ? to : from;
    if (!other || other === self) { selfCount++; continue; }
    counterparties.add(other);
  }

  const n           = txs.length;
  const unique      = counterparties.size;
  const repeatRatio = n > 0 ? +(1 - unique / n).toFixed(3) : 0;
  const selfRatio   = n > 0 ? +(selfCount / n).toFixed(3) : 0;

  let timingCv = null;
  if (timestamps.length >= MIN_TXS) {
    const sorted = [...timestamps].sort((a, b) => a - b);
    const gaps   = [];
    for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
    const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
    const std  = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
    timingCv = mean > 0 ? +(std / mean).toFixed(3) : 0;
  }

  const isHuman = (
    unique >= 8 &&
    repeatRatio < 0.5 &&
    selfRatio   < 0.3 &&
    (timingCv === null || timingCv > 0.3)
  );

  return { txCount: n, uniqueCounterparties: unique, repeatRatio, selfRatio, timingCv, isHuman };
}

function buildResult(address, chainName, m) {
  const cv = m.timingCv !== null ? m.timingCv : 'n/a';
  return {
    methodId:    `tx_graph_${chainName.toLowerCase()}`,
    description: `Tx graph (${chainName}): ${m.txCount} txs, ${m.uniqueCounterparties} unique counterparties, repeat ${(m.repeatRatio * 100).toFixed(0)}%, timing CV ${cv}`,
    result:      m.isHuman,
    input:       address,
  };
}

// ── EVM: Etherscan chains + Alchemy BNB ──────────────────────────────────────

async function analyzeEvm(address) {
  const tasks = [
    // ETH + Arbitrum via Etherscan v2
    ...ETHERSCAN_CHAINS.map(({ id, name }) => async () => {
      const txs = await fetchEtherscanTxs(address, id);
      if (!txs || txs.length < MIN_TXS) return null;
      const m = computeMetrics(address, txs);
      console.log(`[txGraph] ${name}: ${m.txCount} txs, ${m.uniqueCounterparties} unique, CV=${m.timingCv}`);
      return buildResult(address, name, m);
    }),
    // Base via Blockscout (Etherscan free tier doesn't cover Base)
    async () => {
      const txs = await fetchBlockscoutTxs(address);
      if (!txs || txs.length < MIN_TXS) return null;
      const m = computeMetrics(address, txs);
      console.log(`[txGraph] Base: ${m.txCount} txs, ${m.uniqueCounterparties} unique, CV=${m.timingCv}`);
      return buildResult(address, 'Base', m);
    },
    // BNB via Alchemy (Etherscan free tier doesn't support BNB)
    async () => {
      const txs = await fetchAlchemyTxs(address);
      if (!txs || txs.length < MIN_TXS) return null;
      const m = computeMetrics(address, txs);
      console.log(`[txGraph] BNB: ${m.txCount} txs, ${m.uniqueCounterparties} unique, CV=${m.timingCv}`);
      return buildResult(address, 'BNB', m);
    },
  ];

  const settled = await Promise.allSettled(tasks.map(fn => fn()));
  return settled
    .filter(s => s.status === 'fulfilled' && s.value !== null)
    .map(s => s.value);
}

// ── Solana: getSignaturesForAddress + transaction account key sampling ─────────
//
// Solana txs don't have a simple from/to — each tx is a multi-party instruction
// touching many accounts simultaneously. Strategy:
//   1. getSignaturesForAddress(limit=50) — lightweight, returns sig + blockTime
//   2. Sample 20 full txs via getTransaction() to extract all account keys
//   3. Every account key that isn't the wallet = potential counterparty
//   4. Timing CV computed from blockTime across all 50 signatures

async function analyzeSolana(address) {
  try {
    const conn   = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
    const pubkey = new PublicKey(address);

    const sigs = await conn.getSignaturesForAddress(pubkey, { limit: TX_LIMIT });
    if (sigs.length < MIN_TXS) return [];

    const timestamps = sigs.map(s => s.blockTime).filter(Boolean);

    // Fetch up to 20 full transactions to extract counterparty account keys
    const fetched = await Promise.allSettled(
      sigs.slice(0, 20).map(s =>
        conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 })
      )
    );

    const counterparties = new Set();
    for (const t of fetched) {
      if (t.status !== 'fulfilled' || !t.value) continue;
      const msg      = t.value.transaction?.message;
      const accounts = msg?.staticAccountKeys ?? msg?.accountKeys ?? [];
      for (const acc of accounts) {
        const key = acc?.toBase58 ? acc.toBase58() : String(acc);
        if (key && key !== address) counterparties.add(key);
      }
    }

    const n           = sigs.length;
    const unique      = counterparties.size;
    const repeatRatio = n > 0 ? +(1 - unique / n).toFixed(3) : 0;
    let timingCv = null;
    if (timestamps.length >= MIN_TXS) {
      const sorted = [...timestamps].sort((a, b) => a - b);
      const gaps   = [];
      for (let i = 1; i < sorted.length; i++) gaps.push(sorted[i] - sorted[i - 1]);
      const mean = gaps.reduce((s, g) => s + g, 0) / gaps.length;
      const std  = Math.sqrt(gaps.reduce((s, g) => s + (g - mean) ** 2, 0) / gaps.length);
      timingCv = mean > 0 ? +(std / mean).toFixed(3) : 0;
    }
    const isHuman = unique >= 8 && repeatRatio < 0.5 && (timingCv === null || timingCv > 0.3);

    const m = { txCount: n, uniqueCounterparties: unique, repeatRatio, timingCv, isHuman };
    console.log(`[txGraph] Solana: ${m.txCount} txs, ${m.uniqueCounterparties} unique accounts, CV=${m.timingCv}`);
    return [buildResult(address, 'Solana', m)];
  } catch (err) {
    console.error('[txGraph] Solana error:', err.message);
    return [];
  }
}

// ── Public entry point ────────────────────────────────────────────────────────

async function analyzeTransactionGraph(address) {
  if (/^0x[0-9a-fA-F]{40}$/.test(address))          return analyzeEvm(address);
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address)) return analyzeSolana(address);
  return [];
}

module.exports = { analyzeTransactionGraph };
