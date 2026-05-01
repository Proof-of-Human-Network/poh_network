'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { getVoteTokenStake, verifyTxSuccess } = require('../utils/solana');
const { recordVote, getMyVotes, hasVoted, isTxUsed, recordTx } = require('../utils/profiles');
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
 * POST /listing/validate-description
 * Pre-submit LLM check that the description is meaningful.
 */
router.post('/listing/validate-description', async (req, res, next) => {
  try {
    const { description } = req.body;
    if (!description) return res.status(400).json({ error: 'description required' });
    const result = await brain.validateDescription(description);
    res.json(result);
  } catch (err) { next(err); }
});

/**
 * POST /listing
 * Register a new method.
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

    // Payment is enforced on-chain by the registerMethod Anchor instruction
    // (1000 POH: 500 to deployer vault + 500 to staker fee vault).
    // We only verify the transaction was confirmed successfully.
    const isConfirmed = await verifyTxSuccess(txHash);
    if (!isConfirmed) {
      return res.status(402).json({ error: 'Transaction not confirmed — please wait and retry, or check your POH balance' });
    }

    const currentMethods = getMethods();
    newMethods.forEach(m => {
      // Ensure complex fields are strings if they aren't already
      if (typeof m.abiTypes === 'object') m.abiTypes = JSON.stringify(m.abiTypes);
      if (typeof m.returnTypes === 'object') m.returnTypes = JSON.stringify(m.returnTypes);

      m.id = Date.now() + Math.random().toString(36).substr(2, 9);
      m.score = 0;
      m.ownerWallet = walletAddress || null;
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

    // NOTE: staker share (500 POH) is handled entirely on-chain by the Anchor registerMethod
    // instruction → SFEE_PDA. Stakers claim via claimStakerRewards. No off-chain distribution needed.

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
 * Returns methods for voting.
 * ?address=<wallet> — annotates each method with myVoted and filters out already-voted ones.
 * Order: random shuffle, but least-voted (lowest score) methods surface first.
 */
router.get('/verifyer', (req, res) => {
  const { address } = req.query;
  let methods = getMethods();

  const myVotes = address ? getMyVotes(address) : {};

  // Annotate and sort: least-voted (lowest score) first, shuffled within same score bucket
  methods = methods
    .map(m => ({ ...m, myVoted: !!myVotes[m.id] }))
    .sort((a, b) => {
      const scoreDiff = (a.score || 0) - (b.score || 0);
      if (scoreDiff !== 0) return scoreDiff;
      return Math.random() - 0.5; // shuffle within same score
    });

  res.json(methods);
});

/**
 * POST /verifyer/vote
 * Votes: description_prover, method_prover, risk_prover
 */
router.post('/verifyer/vote', async (req, res, next) => {
  try {
    const { methodId, type, vote, walletAddress, txHash, feedback } = req.body;
    // type: 'description' | 'method' | 'risk'
    // vote: true | false
    // feedback: optional natural-language reasoning from the voter

    if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });
    if (!txHash)        return res.status(400).json({ error: 'txHash required' });

    // Prevent replaying a txHash that was already accepted for any action
    if (isTxUsed(txHash)) return res.status(409).json({ error: 'Transaction already used' });

    const isConfirmed = await verifyTxSuccess(txHash);
    if (!isConfirmed) return res.status(402).json({ error: 'Transaction not confirmed' });

    const methods = getMethods();
    const method = methods.find(m => m.id === methodId);
    if (!method) return res.status(404).json({ error: 'Method not found' });

    if (hasVoted(walletAddress, methodId)) {
      return res.status(409).json({ error: 'Already voted on this method' });
    }

    const stakeWeight = await getVoteTokenStake(walletAddress);
    // Scale impact: base 1 + stake fraction * 9 → range [1, 10]
    const impact = 1 + stakeWeight * 9;

    if (type === 'risk') {
      method.score += (vote === true ? -impact : impact);
    } else {
      method.score += (vote === true ? impact : -impact);
    }
    method.voteCount = (method.voteCount || 0) + 1;

    saveMethods(methods);

    recordTx(txHash, { action: 'vote', wallet: walletAddress, methodId });
    recordVote(walletAddress, methodId, vote);

    appendToDataset({
      instruction: `Voter assessment for method: ${method.description}`,
      input: `Type: ${type}, Vote: ${vote}, StakeWeight: ${stakeWeight}${feedback ? `, Feedback: ${feedback}` : ''}`,
      output: vote ? "Representative of human nature" : "Not human nature"
    });

    brain.onVote(method, type || 'description', vote, stakeWeight, feedback || null)
      .catch(err => console.error('[brain] onVote error:', err.message));

    res.json({ status: 'voted', newScore: method.score });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
