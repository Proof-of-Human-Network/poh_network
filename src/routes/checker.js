'use strict';

const express = require('express');
const router  = express.Router();
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const { getRpcUrl, callContract } = require('../utils/evm');
const { evaluate }                = require('../eval/evaluator');
const multer                      = require('multer');
const { parse }                   = require('csv-parse/sync');
const { getCachedResponse, setCachedResponse } = require('../utils/redis');
const { verifyPohTransfer }       = require('../utils/solana');
const brain                       = require('../utils/brain');
const { recordMethodResult }      = require('../utils/methodHealth');
const { analyzeTransactionGraph } = require('../utils/txGraph');
const { checkHumanityVerified }   = require('../utils/humanityProtocol');
const { createJob, getJob }       = require('../utils/jobQueue');
const {
  getProfile, getProfiles, consumeFreeScan, calcScanCost,
  getFreeScansLeft, distributeRewards, isIpAbuse, recordIp,
} = require('../utils/profiles');

const upload = multer({ dest: 'uploads/' });

const METHODS_PATH = path.join(__dirname, '../../data/methods.json');
const DATASET_PATH = path.join(__dirname, '../../data/dataset.json');

// Async brain verdicts for single-wallet scans
const brainPending = {};

// ── Helpers ───────────────────────────────────────────────────────────────────

function getMethods() {
  try {
    if (!fs.existsSync(METHODS_PATH)) return [];
    const raw = fs.readFileSync(METHODS_PATH, 'utf-8');
    return raw ? JSON.parse(raw) : [];
  } catch (err) {
    console.error('[db] Error reading methods:', err.message);
    return [];
  }
}

function appendToDataset(record) {
  let dataset = [];
  if (fs.existsSync(DATASET_PATH)) {
    try { dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8')); } catch {}
  }
  dataset.push(record);
  const tmp = DATASET_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(dataset, null, 2));
  fs.renameSync(tmp, DATASET_PATH);
}

// ── ZNS domain resolution ─────────────────────────────────────────────────────

const ZNS_TLD_CHAIN = {
  ink: 57073, bnb: 56, base: 8453, blast: 81457, polygon: 137,
  zora: 7777777, scroll: 534352, taiko: 167000, bera: 80094,
  sonic: 146, kaia: 8217, abstract: 2741, defi: 1301, unichain: 1301,
  soneium: 1868, plume: 98865, hemi: 43111, xrpl: 1440002,
  coti: 7771, katana: 2020, hyper: 999,
};

async function resolveZnsDomain(name) {
  const tld    = name.split('.').pop()?.toLowerCase();
  const domain = name.split('.').slice(0, -1).join('.');
  const chains = tld && ZNS_TLD_CHAIN[tld]
    ? [ZNS_TLD_CHAIN[tld]]
    : Object.values(ZNS_TLD_CHAIN);
  for (const chain of chains) {
    try {
      const res = await axios.get('https://zns.bio/api/resolveDomain', {
        params: { chain, domain }, timeout: 5000,
      });
      if (res.data?.code === 200 && res.data?.address) return res.data.address;
    } catch { /* try next */ }
  }
  return null;
}

// ── Single-method executor ────────────────────────────────────────────────────

async function executeMethod(m, address) {
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000));
  const run = (async () => {
    if (m.type === 'evm') {
      const { ethers } = require('ethers');
      const rpcUrl   = getRpcUrl(Number(m.chainId));
      const decimals = m.decimals != null ? Number(m.decimals) : 18;
      const network  = new ethers.Network(String(m.chainId), Number(m.chainId));
      let result;
      if (m.method === 'eth_getBalance') {
        const p = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
        result = [await p.getBalance(address)];
      } else if (m.method === 'eth_getTransactionCount') {
        const p = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
        result = [BigInt(await p.getTransactionCount(address))];
      } else if (m.method === 'eth_getCode') {
        const p = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
        result = [await p.getCode(address)];
      } else {
        result = await callContract(rpcUrl, m.address, m.method,
          JSON.parse(m.abiTypes || '[]'), JSON.parse(m.returnTypes || '[]'), [address], m.chainId);
      }
      return evaluate(m.expression, { result, decimals }, m.lang || 'js');

    } else if (m.type === 'rest') {
      const rawUrl     = m.address;
      const hasHolder  = rawUrl.includes('{address}');
      const url        = hasHolder ? rawUrl.replace(/\{address\}/g, encodeURIComponent(address)) : rawUrl;
      const method     = (m.method || 'GET').toUpperCase();
      const headers    = m.headers ? JSON.parse(m.headers) : {};
      const decimals   = m.decimals != null ? Number(m.decimals) : 18;
      const validate   = s => s < 500;
      let response;
      if (method === 'POST') {
        const body = JSON.parse((m.body || '{}').replace(/\{address\}/g, address));
        response = await axios.post(url, body, { headers, timeout: 7000, validateStatus: validate });
      } else {
        const params = hasHolder ? {} : { address };
        response = await axios.get(url, { params, headers, timeout: 7000, validateStatus: validate });
      }
      return evaluate(m.expression, { data: response.data, status: response.status, decimals }, m.lang || 'js');

    } else if (m.type === 'solana') {
      const { Connection, PublicKey }              = require('@solana/web3.js');
      const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
      const conn     = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
      const pubkey   = new PublicKey(address);
      const decimals = m.decimals != null ? Number(m.decimals) : 9;
      let result = null;
      if (m.method === 'getBalance') {
        result = await conn.getBalance(pubkey);
      } else if (m.method === 'getTransactionCount') {
        result = await conn.getTransactionCount(pubkey);
      } else if (m.method === 'getTokenBalance' && m.address) {
        const mint    = new PublicKey(m.address);
        const ata     = await getAssociatedTokenAddress(mint, pubkey);
        const account = await getAccount(conn, ata);
        result = Number(account.amount);
      } else if (m.method === 'getAccountInfo') {
        const info = await conn.getAccountInfo(pubkey);
        result = info?.executable ?? false;
      } else if (m.method === 'getProgramAccounts' && m.address) {
        const programId = new PublicKey(m.address);
        const accounts  = await conn.getProgramAccounts(programId, {
          filters: [{ memcmp: { offset: 8, bytes: address } }],
        });
        result = accounts.length > 0;
      }
      return evaluate(m.expression, { result, decimals }, m.lang || 'js');
    }
    return false;
  })();
  return Promise.race([run, timeout]);
}

// ── Scan a single wallet against filtered methods ─────────────────────────────

async function scanWallet(rawInput, { allMethods, chainFilter }) {
  // ZNS resolution
  const isZnsDomain = /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(rawInput) && !/^0x/.test(rawInput);
  let address = rawInput;
  if (isZnsDomain) {
    const resolved = await resolveZnsDomain(rawInput);
    if (!resolved) return [{ input: rawInput, error: 'ZNS domain could not be resolved' }];
    console.log(`[checker] ZNS resolved ${rawInput} → ${resolved}`);
    address = resolved;
  }

  const isEvm    = /^0x[0-9a-fA-F]{40}$/.test(address);
  const isSolana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (!isEvm && !isSolana) return [{ input: address, error: 'Unrecognised address format' }];

  let methods = [...allMethods];
  if (isEvm) {
    methods = methods.filter(m => m.type === 'evm' || m.type === 'rest');
    methods = methods.filter(m => !m.addressType || m.addressType === 'evm');
    if (chainFilter) {
      const allowed = chainFilter.split(',').map(Number);
      methods = methods.filter(m => m.type === 'rest' || allowed.includes(Number(m.chainId)));
    }
  } else {
    methods = methods.filter(m => m.type === 'solana' || m.type === 'rest');
    methods = methods.filter(m => !m.addressType || m.addressType === 'solana');
  }
  if (methods.length === 0) return [];

  // Cache check
  const cacheKey = `check:${address}:${chainFilter || 'all'}`;
  const cached   = await getCachedResponse(cacheKey);
  if (cached && cached.methodCount === methods.length) return cached.data;

  console.log(`[checker] Scanning ${methods.length} methods for ${address}`);

  const [settled, graphResults, humanityResult] = await Promise.all([
    Promise.allSettled(methods.map(m => executeMethod(m, address))),
    analyzeTransactionGraph(address),
    checkHumanityVerified(address),
  ]);

  const results = settled.map((s, i) => {
    const m       = methods[i];
    const isError = s.status === 'rejected';
    const outcome = s.status === 'fulfilled' ? Boolean(s.value) : false;
    if (isError) console.error(`[checker] ✗ "${m.description.slice(0, 50)}" failed: ${s.reason?.message}`);
    if (m.type === 'rest' || m.type === 'evm') recordMethodResult(m.id, isError);
    appendToDataset({
      instruction: `Verification response for ${address} using ${m.description}`,
      input:  JSON.stringify(m),
      output: outcome ? 'Evidence of human activity' : 'No evidence of human activity',
    });
    return { input: address, methodId: m.id, description: m.description, result: outcome };
  });

  results.push(...graphResults);
  if (humanityResult) results.push(humanityResult);

  await setCachedResponse(cacheKey, { data: results, methodCount: methods.length });
  return results;
}

// ── POST /checker ─────────────────────────────────────────────────────────────

router.post('/', upload.single('csv'), async (req, res, next) => {
  console.log('[checker] Received scan request');
  try {
    const { input, walletAddress, chainIds: chainFilter, txHash, apiKey } = req.body;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || req.socket?.remoteAddress || null;

    // Parse inputs
    let inputs = [];
    if (req.file) {
      const content = fs.readFileSync(req.file.path, 'utf-8');
      const records = parse(content, { columns: true, skip_empty_lines: true });
      inputs = records.map(r => r.address || r.input || Object.values(r)[0]).filter(Boolean);
      fs.unlinkSync(req.file.path);
    } else if (input) {
      inputs = Array.isArray(input) ? input : [input];
    }
    if (inputs.length === 0) return res.status(400).json({ error: 'No input provided' });

    // Auth
    let effectiveWallet = walletAddress;
    if (apiKey) {
      const profiles = getProfiles();
      const match = Object.values(profiles).find(p => p.apiKey === apiKey);
      if (!match) return res.status(401).json({ error: 'Invalid API key' });
      effectiveWallet = match.address;
    }

    // Free tier / payment
    const freeLeft = effectiveWallet ? getFreeScansLeft(effectiveWallet) : 0;
    const isFree   = freeLeft >= inputs.length;
    if (!isFree) {
      if (!txHash) {
        const { total, perAddress } = calcScanCost(inputs.length);
        return res.status(402).json({ error: 'Payment required', required: total, perAddress, count: inputs.length, freeScansLeft: freeLeft });
      }
      const { total } = calcScanCost(inputs.length);
      const isPaid = await verifyPohTransfer(txHash, total, effectiveWallet);
      if (!isPaid) return res.status(402).json({ error: `POH payment not verified — expected ${total / 1e6} POH` });
    } else {
      if (effectiveWallet && isIpAbuse(clientIp, effectiveWallet))
        return res.status(403).json({ error: 'Free tier already used from this IP on another wallet' });
      if (effectiveWallet) recordIp(effectiveWallet, clientIp);
    }

    if (isFree && effectiveWallet) {
      for (let i = 0; i < inputs.length; i++) consumeFreeScan(effectiveWallet);
    }

    const allMethods = getMethods();
    const scanCtx    = { allMethods, chainFilter };

    // ── Bulk: job queue ───────────────────────────────────────────────────
    if (inputs.length > 1) {
      const jobId = createJob(inputs, input => scanWallet(input, scanCtx));

      // Distribute rewards after job completes (fire-and-forget)
      if (!isFree && txHash) {
        const { total } = calcScanCost(inputs.length);
        const pollRewards = setInterval(() => {
          const job = getJob(jobId);
          if (!job || job.status !== 'done') return;
          clearInterval(pollRewards);
          const executedIds = [...new Set(job.results.map(r => r.methodId).filter(Boolean))];
          distributeRewards(total, executedIds, allMethods, brain.getWeights());
        }, 5000);
      }

      return res.json({
        jobId,
        status:    'queued',
        total:     inputs.length,
        pollUrl:   `/checker/job/${jobId}`,
        freeScansLeft: effectiveWallet ? getFreeScansLeft(effectiveWallet) : null,
      });
    }

    // ── Single wallet: sync (existing behaviour) ──────────────────────────
    const results = await scanWallet(inputs[0], scanCtx);

    if (!isFree && txHash) {
      const { total } = calcScanCost(1);
      const executedIds = [...new Set(results.map(r => r.methodId).filter(Boolean))];
      distributeRewards(total, executedIds, allMethods, brain.getWeights());
    }

    const scanKey = inputs[0];
    brainPending[scanKey] = { status: 'pending', startedAt: Date.now() };
    res.json({
      result:  results,
      count:   results.length,
      source:  'processed',
      brainKey: scanKey,
      freeScansLeft: effectiveWallet ? getFreeScansLeft(effectiveWallet) : null,
    });

    brain.analyzeHumanness(scanKey, results, allMethods)
      .then(verdict => {
        brainPending[scanKey] = { status: 'done', ...verdict, signals: results };
        console.log(`[brain] Verdict for ${scanKey}: ${verdict.verdict} (${(verdict.confidence * 100).toFixed(0)}%)`);
      })
      .catch(err => {
        brainPending[scanKey] = { status: 'error', reasoning: err.message };
        console.error('[brain] analyzeHumanness failed:', err.message);
      });

  } catch (err) {
    next(err);
  }
});

// ── GET /checker/job/:jobId ───────────────────────────────────────────────────

router.get('/job/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({
    jobId:       job.id,
    status:      job.status,
    total:       job.total,
    done:        job.done,
    percent:     Math.round((job.done / job.total) * 100),
    results:     job.results,
    errors:      job.errors,
    createdAt:   job.createdAt,
    completedAt: job.completedAt,
  });
});

// ── GET /checker/brain/:key ───────────────────────────────────────────────────

router.get('/brain/:key', (req, res) => {
  const entry = brainPending[req.params.key];
  if (!entry) return res.json({ status: 'not_found' });
  res.json(entry);
});

// ── POST /checker/feedback ────────────────────────────────────────────────────
// Body: { brainKey, address, aiVerdict, correction: 'HUMAN'|'AI', comment? }

router.post('/feedback', async (req, res) => {
  const { brainKey, address, aiVerdict, correction, comment } = req.body || {};
  if (!address || !aiVerdict || !correction) {
    return res.status(400).json({ error: 'address, aiVerdict and correction are required' });
  }
  if (!['HUMAN', 'AI', 'UNCERTAIN'].includes(correction)) {
    return res.status(400).json({ error: 'correction must be HUMAN, AI, or UNCERTAIN' });
  }

  // Grab the signals from the stored verdict if available
  const entry = brainKey ? brainPending[brainKey] : null;
  const signals = entry?.signals || [];

  // Fire-and-forget — don't block the response on LLM call
  brain.onVerdictFeedback(address, aiVerdict, correction, comment || null, signals)
    .catch(err => console.error('[feedback] onVerdictFeedback failed:', err.message));

  res.json({ ok: true });
});

// ── GET /checker/pricing?count=N ─────────────────────────────────────────────

router.get('/pricing', (req, res) => {
  const count = Math.max(1, parseInt(req.query.count) || 1);
  const { total, perAddress } = calcScanCost(count);
  res.json({
    count, perAddress, total,
    tiers: [
      { minAddresses: 1,   rate: 1.00, label: '1–9' },
      { minAddresses: 10,  rate: 0.85, label: '10–49' },
      { minAddresses: 50,  rate: 0.70, label: '50–99' },
      { minAddresses: 100, rate: 0.55, label: '100–499' },
      { minAddresses: 500, rate: 0.40, label: '500+' },
    ],
  });
});

// ── POST /checker/preview ─────────────────────────────────────────────────────
// Test a method definition against an address without writing to dataset.
// Body: { address, method: { type, address, method, expression, ... } }

router.post('/preview', async (req, res) => {
  const { address, method: m } = req.body || {};
  if (!address || !m) return res.status(400).json({ error: 'address and method required' });

  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Timeout after 8s')), 8000)
  );

  const serialize = v => {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(serialize);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, val]) => [k, serialize(val)]));
    }
    return v;
  };

  const run = (async () => {
    if (m.type === 'evm') {
      const { ethers } = require('ethers');
      const rpcUrl   = getRpcUrl(Number(m.chainId));
      const decimals = m.decimals != null ? Number(m.decimals) : 18;
      const network  = new ethers.Network(String(m.chainId), Number(m.chainId));
      let result;
      if (m.method === 'eth_getBalance') {
        const p = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
        result = [await p.getBalance(address)];
      } else if (m.method === 'eth_getTransactionCount') {
        const p = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
        result = [BigInt(await p.getTransactionCount(address))];
      } else if (m.method === 'eth_getCode') {
        const p = new ethers.JsonRpcProvider(rpcUrl, network, { staticNetwork: network });
        result = [await p.getCode(address)];
      } else {
        result = await callContract(rpcUrl, m.address, m.method,
          JSON.parse(m.abiTypes || '[]'), JSON.parse(m.returnTypes || '[]'), [address], m.chainId);
      }
      const expressionResult = await evaluate(m.expression, { result, decimals }, m.lang || 'js');
      return { rawResult: serialize(result), expressionResult };

    } else if (m.type === 'rest') {
      const rawUrl    = m.address;
      const hasHolder = rawUrl.includes('{address}');
      const url       = hasHolder ? rawUrl.replace(/\{address\}/g, encodeURIComponent(address)) : rawUrl;
      const method    = (m.method || 'GET').toUpperCase();
      const headers   = m.headers
        ? (typeof m.headers === 'string' ? JSON.parse(m.headers) : m.headers)
        : {};
      const decimals  = m.decimals != null ? Number(m.decimals) : 18;
      const validate  = s => s < 500;
      let response;
      if (method === 'POST') {
        const body = JSON.parse((m.body || '{}').replace(/\{address\}/g, address));
        response = await axios.post(url, body, { headers, timeout: 7000, validateStatus: validate });
      } else {
        const params = hasHolder ? {} : { address };
        response = await axios.get(url, { params, headers, timeout: 7000, validateStatus: validate });
      }
      const expressionResult = await evaluate(
        m.expression, { data: response.data, status: response.status, decimals }, m.lang || 'js'
      );
      return { rawResult: { status: response.status, data: response.data }, expressionResult };

    } else if (m.type === 'solana') {
      const { Connection, PublicKey }              = require('@solana/web3.js');
      const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
      const conn     = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
      const pubkey   = new PublicKey(address);
      const decimals = m.decimals != null ? Number(m.decimals) : 9;
      let result = null;
      if (m.method === 'getBalance') {
        result = await conn.getBalance(pubkey);
      } else if (m.method === 'getTransactionCount') {
        result = await conn.getTransactionCount(pubkey);
      } else if (m.method === 'getTokenBalance' && m.address) {
        const mint    = new PublicKey(m.address);
        const ata     = await getAssociatedTokenAddress(mint, pubkey);
        const account = await getAccount(conn, ata);
        result = Number(account.amount);
      } else if (m.method === 'getAccountInfo') {
        const info = await conn.getAccountInfo(pubkey);
        result = info?.executable ?? false;
      } else if (m.method === 'getProgramAccounts' && m.address) {
        const programId = new PublicKey(m.address);
        const accounts  = await conn.getProgramAccounts(programId, {
          filters: [{ memcmp: { offset: 8, bytes: address } }],
        });
        result = accounts.length > 0;
      }
      const expressionResult = await evaluate(m.expression, { result, decimals }, m.lang || 'js');
      return { rawResult: serialize(result), expressionResult };
    }
    throw new Error('Unknown method type: ' + m.type);
  })();

  try {
    const result = await Promise.race([run, timeout]);
    res.json(result);
  } catch (err) {
    res.json({ error: err.message });
  }
});

module.exports = router;
