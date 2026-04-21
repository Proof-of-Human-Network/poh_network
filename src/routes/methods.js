'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { verifySolPayment, getVoteTokenStake } = require('../utils/solana');
const brain = require('../utils/brain');

const METHODS_PATH = path.join(__dirname, '../../data/methods.json');
const DATASET_PATH = path.join(__dirname, '../../data/dataset.json');

const upload = multer({ dest: 'uploads/' });

// Helper to save methods
function saveMethods(methods) {
  fs.writeFileSync(METHODS_PATH, JSON.stringify(methods, null, 2));
}

// Helper to get methods
function getMethods() {
  if (!fs.existsSync(METHODS_PATH)) return [];
  return JSON.parse(fs.readFileSync(METHODS_PATH, 'utf-8'));
}

// Helper to append to dataset
function appendToDataset(record) {
  let dataset = [];
  if (fs.existsSync(DATASET_PATH)) {
    dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
  }
  dataset.push(record);
  fs.writeFileSync(DATASET_PATH, JSON.stringify(dataset, null, 2));
}

/**
 * POST /listing
 * Register a new method. 
 * Charges 0.01 SOL.
 */
router.post('/listing', upload.single('csv'), async (req, res, next) => {
  try {
    const { txHash, walletAddress } = req.body;
    if (!txHash) return res.status(400).json({ error: 'txHash is required for payment confirmation' });

    let newMethods = [];
    if (req.file) {
      const content = fs.readFileSync(req.file.path, 'utf-8');
      newMethods = parse(content, { columns: true, skip_empty_lines: true });
      fs.unlinkSync(req.file.path);
    } else {
      const { type, chainId, address, method, abiTypes, returnTypes, expression, lang, description, headers, body, decimals } = req.body;
      if (!description) return res.status(400).json({ error: 'description is mandatory' });
      newMethods.push({ type, chainId, address, method, abiTypes, returnTypes, expression, lang, description, headers, body, decimals });
    }

    const feePerMethod = 0.01;
    const totalFee = newMethods.length * feePerMethod;
    const recipient = process.env.FEE_RECIPIENT || 'YOUR_SOLANA_ADDRESS';

    const isPaid = await verifySolPayment(txHash, totalFee, recipient);
    if (!isPaid) {
      return res.status(402).json({ error: `Payment verification failed. Expected ${totalFee} SOL to ${recipient}` });
    }

    const currentMethods = getMethods();
    newMethods.forEach(m => {
      // Ensure complex fields are strings if they aren't already
      if (typeof m.abiTypes === 'object') m.abiTypes = JSON.stringify(m.abiTypes);
      if (typeof m.returnTypes === 'object') m.returnTypes = JSON.stringify(m.returnTypes);

      m.id = Date.now() + Math.random().toString(36).substr(2, 9);
      m.score = 0;
      m.created_at = new Date().toISOString();
      currentMethods.push(m);

      // Record as inference for LLM training
      appendToDataset({
        instruction: `Analyze implementation for ${m.description}`,
        input: JSON.stringify(m),
        output: "Human" // Default reasoning placeholder
      });
    });

    saveMethods(currentMethods);

    // ── Brain: evaluate each new method ──────────────────────────────────
    for (const m of newMethods) {
      brain.onNewMethod(m).catch(err => console.error('[brain] onNewMethod error:', err.message));
    }

    res.json({ status: 'success', added: newMethods.length, txHash });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /verifyer
 * Returns methods for voting
 */
router.get('/verifyer', (req, res) => {
  res.json(getMethods());
});

/**
 * POST /verifyer/vote
 * Votes: description_prover, method_prover, risk_prover
 */
router.post('/verifyer/vote', async (req, res, next) => {
  try {
    const { methodId, type, vote, walletAddress, txHash } = req.body;
    // type: 'description' | 'method' | 'risk'
    // vote: true | false (or yes/no)

    if (!txHash) return res.status(400).json({ error: 'Gas fee payment txHash required' });

    // Verify "gas fee" (e.g. 0.001 SOL)
    const isPaid = await verifySolPayment(txHash, 0.001, process.env.FEE_RECIPIENT || 'YOUR_SOLANA_ADDRESS');
    if (!isPaid) return res.status(402).json({ error: 'Gas fee payment verification failed' });

    const methods = getMethods();
    const method = methods.find(m => m.id === methodId);
    if (!method) return res.status(404).json({ error: 'Method not found' });

    const stakeWeight = await getVoteTokenStake(walletAddress);
    const impact = stakeWeight * 10; // Scale impact by stake

    if (type === 'risk') {
      method.score += (vote === true ? -impact : impact);
    } else {
      // 'description', 'method', or unspecified — all increase/decrease score directly
      method.score += (vote === true ? impact : -impact);
    }

    saveMethods(methods);

    // Record vote for training
    appendToDataset({
      instruction: `Voter assessment for method: ${method.description}`,
      input: `Type: ${type}, Vote: ${vote}, StakeWeight: ${stakeWeight}`,
      output: vote ? "Representative of human nature" : "Not human nature"
    });

    // ── Brain: process the vote ───────────────────────────────────────────
    brain.onVote(method, type || 'description', vote, stakeWeight)
      .catch(err => console.error('[brain] onVote error:', err.message));

    res.json({ status: 'voted', newScore: method.score });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
