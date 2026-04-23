'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const { getRpcUrl, callContract } = require('../utils/evm');
const { evaluate } = require('../eval/evaluator');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { getCachedResponse, setCachedResponse } = require('../utils/redis');
const { getVoteTokenStake, verifyBurnTransaction } = require('../utils/solana');
const brain = require('../utils/brain');
const {
  getProfile, getProfiles, consumeFreeScan, calcScanCost,
  getFreeScansLeft, distributeRewards, isIpAbuse, recordIp,
} = require('../utils/profiles');

const upload = multer({ dest: 'uploads/' });

const METHODS_PATH = path.join(__dirname, '../../data/methods.json');
const DATASET_PATH = path.join(__dirname, '../../data/dataset.json');

// In-memory store for async brain verdicts { [address]: { status, verdict, confidence, reasoning } }
const brainPending = {};

function getMethods() {
  try {
    if (!fs.existsSync(METHODS_PATH)) return [];
    const content = fs.readFileSync(METHODS_PATH, 'utf-8');
    return content ? JSON.parse(content) : [];
  } catch (err) {
    console.error('[db] Error reading methods:', err.message);
    return [];
  }
}

function appendToDataset(record) {
  let dataset = [];
  if (fs.existsSync(DATASET_PATH)) {
    dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
  }
  dataset.push(record);
  fs.writeFileSync(DATASET_PATH, JSON.stringify(dataset, null, 2));
}

/**
 * POST /checker
 * Scans a wallet or profile against registered methods.
 * First 100 scans per wallet are free (one free-tier per IP).
 * Beyond free tier: costs POH tokens with bulk curve pricing.
 */
router.post('/', upload.single('csv'), async (req, res, next) => {
  console.log('[checker] Received scan request');
  try {
    const { input, walletAddress, chainIds: chainFilter, txHash, apiKey } = req.body;
    const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim()
                  || req.socket?.remoteAddress
                  || null;

    let inputs = [];
    if (req.file) {
      const content = fs.readFileSync(req.file.path, 'utf-8');
      const records = parse(content, { columns: true, skip_empty_lines: true });
      inputs = records.map(r => r.address || r.input || Object.values(r)[0]);
      fs.unlinkSync(req.file.path);
    } else if (input) {
      inputs = Array.isArray(input) ? input : [input];
    }

    if (inputs.length === 0) return res.status(400).json({ error: 'No input provided' });

    // ── Auth: API key OR wallet ────────────────────────────────────────────
    let effectiveWallet = walletAddress;
    if (apiKey) {
      const profiles = getProfiles();
      const match = Object.values(profiles).find(p => p.apiKey === apiKey);
      if (!match) return res.status(401).json({ error: 'Invalid API key' });
      effectiveWallet = match.address;
    }

    // ── Free tier check ───────────────────────────────────────────────────
    const freeLeft = effectiveWallet ? getFreeScansLeft(effectiveWallet) : 0;
    const isFree   = freeLeft >= inputs.length;

    if (!isFree) {
      // Paid path: verify POH burn transaction
      if (!txHash) {
        const { total, perAddress } = calcScanCost(inputs.length);
        return res.status(402).json({
          error: 'Payment required',
          required: total,
          perAddress,
          count: inputs.length,
          freeScansLeft: freeLeft,
        });
      }
      const isPaid = await verifyBurnTransaction(txHash, inputs.length, effectiveWallet);
      if (!isPaid) return res.status(402).json({ error: `Burn verification failed for ${inputs.length} POH` });
    } else {
      // Free tier: IP abuse check
      if (effectiveWallet && isIpAbuse(clientIp, effectiveWallet)) {
        return res.status(403).json({ error: 'Free tier already used from this IP on another wallet' });
      }
      if (effectiveWallet) recordIp(effectiveWallet, clientIp);
    }

    // Consume free scans or record paid scan
    if (isFree && effectiveWallet) {
      for (let i = 0; i < inputs.length; i++) consumeFreeScan(effectiveWallet);
    }

    const allResults = [];

    for (const singleInput of inputs) {
      let methods = getMethods();
      
      // Filter methods — REST is always included, chain-specific types are filtered by input
      if (singleInput.startsWith('0x')) {
        methods = methods.filter(m => m.type === 'evm' || m.type === 'rest');
        if (chainFilter) {
          const allowedChains = chainFilter.split(',').map(Number);
          methods = methods.filter(m => m.type === 'rest' || allowedChains.includes(Number(m.chainId)));
        }
      } else if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(singleInput)) {
        // Solana base58
        methods = methods.filter(m => m.type === 'solana' || m.type === 'rest');
      }

      if (methods.length === 0) continue;

      // Redis Cache Check
      const cacheKey = `check:${singleInput}:${chainFilter || 'all'}`;
      const cached = await getCachedResponse(cacheKey);
      
      if (cached && cached.methodCount === methods.length) {
        allResults.push(...cached.data);
        continue;
      }

      console.log(`\n[checker] ── Scanning ${methods.length} methods in parallel for ${singleInput} ──`);

      async function executeMethod(m) {
        const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 8000));
        const run = (async () => {
          if (m.type === 'evm') {
            const { ethers } = require('ethers');
            const rpcUrl = getRpcUrl(Number(m.chainId));
            const decimals = m.decimals != null ? Number(m.decimals) : 18;
            let result;
            if (m.method === 'eth_getBalance') {
              const provider = new ethers.JsonRpcProvider(rpcUrl);
              result = [await provider.getBalance(singleInput)];
            } else if (m.method === 'eth_getTransactionCount') {
              const provider = new ethers.JsonRpcProvider(rpcUrl);
              result = [BigInt(await provider.getTransactionCount(singleInput))];
            } else {
              result = await callContract(rpcUrl, m.address, m.method, JSON.parse(m.abiTypes || '[]'), JSON.parse(m.returnTypes || '[]'), [singleInput]);
            }
            console.log(`[checker] [${m.type}] "${m.description.slice(0,50)}" → raw: ${result.map(v => v?.toString()).join(', ')}`);
            return evaluate(m.expression, { result, decimals }, m.lang || 'js');

          } else if (m.type === 'rest') {
            const rawUrl = m.address;
            const hasPlaceholder = rawUrl.includes('{address}');
            const resolvedUrl = hasPlaceholder ? rawUrl.replace(/\{address\}/g, encodeURIComponent(singleInput)) : rawUrl;
            const httpMethod = (m.method || 'GET').toUpperCase();
            const headers = m.headers ? JSON.parse(m.headers) : {};
            const decimals = m.decimals != null ? Number(m.decimals) : 18;
            let response;
            if (httpMethod === 'POST') {
              const body = JSON.parse((m.body || '{}').replace(/\{address\}/g, singleInput));
              response = await axios.post(resolvedUrl, body, { headers, timeout: 7000 });
            } else {
              const params = hasPlaceholder ? {} : { address: singleInput };
              response = await axios.get(resolvedUrl, { params, headers, timeout: 7000 });
            }
            console.log(`[checker] [${m.type}] "${m.description.slice(0,50)}" → status: ${response.status} | ${JSON.stringify(response.data).slice(0, 120)}`);
            return evaluate(m.expression, { data: response.data, status: response.status, decimals }, m.lang || 'js');

          } else if (m.type === 'solana') {
            const { Connection, PublicKey } = require('@solana/web3.js');
            const { getAssociatedTokenAddress, getAccount } = require('@solana/spl-token');
            const conn = new Connection(process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
            const pubkey = new PublicKey(singleInput);
            const decimals = m.decimals != null ? Number(m.decimals) : 9;
            let result = null;
            if (m.method === 'getBalance') {
              result = await conn.getBalance(pubkey);
            } else if (m.method === 'getTransactionCount') {
              result = await conn.getTransactionCount(pubkey);
            } else if (m.method === 'getTokenBalance' && m.address) {
              const mint = new PublicKey(m.address);
              const ata = await getAssociatedTokenAddress(mint, pubkey);
              const account = await getAccount(conn, ata);
              result = Number(account.amount);
            }
            console.log(`[checker] [${m.type}] "${m.description.slice(0,50)}" → raw: ${result}`);
            return evaluate(m.expression, { result, decimals }, m.lang || 'js');
          }
          return false;
        })();

        return Promise.race([run, timeout]);
      }

      const settled = await Promise.allSettled(methods.map(m => executeMethod(m)));

      const results = settled.map((s, i) => {
        const m = methods[i];
        const outcome = s.status === 'fulfilled' ? Boolean(s.value) : false;
        if (s.status === 'rejected') {
          console.error(`[checker] ✗ "${m.description.slice(0,50)}" failed: ${s.reason?.message}`);
        }
        console.log(`[checker] ${outcome ? '✓' : '✗'} ${m.description.slice(0,60)}`);
        appendToDataset({
          instruction: `Verification response for ${singleInput} using ${m.description}`,
          input: JSON.stringify(m),
          output: outcome ? "Evidence of human activity" : "No evidence of human activity"
        });
        return { input: singleInput, methodId: m.id, description: m.description, result: outcome };
      });

      allResults.push(...results);
      await setCachedResponse(cacheKey, { data: results, methodCount: methods.length });
    }

    // ── Reward distribution (50% of paid POH to method owners) ──────────
    if (!isFree && txHash) {
      const { total } = calcScanCost(inputs.length);
      const executedIds = [...new Set(allResults.map(r => r.methodId))];
      const allMethods  = getMethods();
      const weights     = brain.getWeights();
      distributeRewards(total, executedIds, allMethods, weights);
    }

    // ── Brain analysis (async — don't block the response) ────────────────
    const scanKey = inputs[0] || 'batch';
    brainPending[scanKey] = { status: 'pending', startedAt: Date.now() };
    res.json({
      result: allResults,
      count: allResults.length,
      source: 'processed',
      brainKey: scanKey,
      freeScansLeft: effectiveWallet ? getFreeScansLeft(effectiveWallet) : null,
    });

    // Run in background
    const allMethods = getMethods();
    brain.analyzeHumanness(scanKey, allResults, allMethods)
      .then(verdict => {
        brainPending[scanKey] = { status: 'done', ...verdict };
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

/**
 * GET /checker/brain/:key
 * Poll for an async brain verdict after a scan.
 */
router.get('/brain/:key', (req, res) => {
  const entry = brainPending[req.params.key];
  if (!entry) return res.json({ status: 'not_found' });
  res.json(entry);
});

/**
 * GET /checker/pricing?count=N
 * Returns cost breakdown for N addresses.
 */
router.get('/pricing', (req, res) => {
  const count = Math.max(1, parseInt(req.query.count) || 1);
  const { total, rate, perAddress } = calcScanCost(count);
  res.json({
    count,
    perAddress,
    total,
    tiers: [
      { minAddresses: 1,   rate: 1.00, label: '1–9' },
      { minAddresses: 10,  rate: 0.85, label: '10–49' },
      { minAddresses: 50,  rate: 0.70, label: '50–99' },
      { minAddresses: 100, rate: 0.55, label: '100–499' },
      { minAddresses: 500, rate: 0.40, label: '500+' },
    ],
  });
});

module.exports = router;
