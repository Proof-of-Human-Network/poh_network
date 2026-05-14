'use strict';

const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const { getVoteTokenStake, verifyWalletSignature, verifyTxSuccess } = require('../utils/solana');
const { recordVote, getMyVotes, hasVoted, isTxUsed, recordTx } = require('../utils/profiles');
const brain = require('../utils/brain');

const METHODS_PATH = path.join(__dirname, '../../data/methods.json');
const DATASET_PATH = path.join(__dirname, '../../data/dataset.json');

const upload = multer({ dest: 'uploads/' });

// Helper to save methods
function saveMethods(methods) {
  const tmp = METHODS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(methods, null, 2));
  fs.renameSync(tmp, METHODS_PATH);
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
 * POST /verifyer/validate-feedback
 * Pre-vote LLM check that the feedback comment is meaningful.
 */
router.post('/verifyer/validate-feedback', async (req, res, next) => {
  try {
    const { feedback } = req.body;
    if (!feedback?.trim()) return res.json({ valid: true, reason: 'No comment' });
    const result = await brain.validateFeedback(feedback);
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

  // Weighted random: methods with fewer votes surface more often but order is never fixed.
  // Weight = Math.random() / (1 + voteCount) — highest weight wins first slot.
  methods = methods
    .map(m => ({ ...m, myVoted: !!myVotes[m.id], _w: Math.random() / (1 + (m.voteCount || 0)) }))
    .sort((a, b) => b._w - a._w)
    .map(({ _w, ...m }) => m);

  res.json(methods);
});

/**
 * POST /verifyer/vote
 * Votes: description_prover, method_prover, risk_prover
 */
router.post('/verifyer/vote', async (req, res, next) => {
  try {
    const { methodId, type, vote, walletAddress, signature, message, feedback } = req.body;
    // type: 'description' | 'method' | 'risk'
    // vote: true | false
    // signature: base58 wallet signature over `message`
    // message: "poh-vote-v1:{methodId}:{vote}:{type}:{walletAddress}:{timestamp}"

    if (!walletAddress) return res.status(400).json({ error: 'walletAddress required' });
    if (!signature || !message) return res.status(400).json({ error: 'signature and message required' });

    // Verify the wallet actually signed this exact message
    if (!verifyWalletSignature(message, signature, walletAddress))
      return res.status(401).json({ error: 'Invalid signature' });

    // Validate message binds to this request (prevents swapping vote/method after signing)
    const expected = `poh-vote-v1:${methodId}:${vote}:${type || 'method'}:${walletAddress}:`;
    if (!message.startsWith(expected))
      return res.status(400).json({ error: 'Message does not match request' });

    // Reject messages older than 5 minutes
    const ts = parseInt(message.split(':').pop(), 10);
    if (!ts || Date.now() - ts > 5 * 60 * 1000)
      return res.status(400).json({ error: 'Message expired' });

    // Prevent signature replay
    if (isTxUsed(signature)) return res.status(409).json({ error: 'Signature already used' });

    const methods = getMethods();
    const method = methods.find(m => m.id === methodId);
    if (!method) return res.status(404).json({ error: 'Method not found' });

    if (hasVoted(walletAddress, methodId))
      return res.status(409).json({ error: 'Already voted on this method' });

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

    recordTx(signature, { action: 'vote', wallet: walletAddress, methodId });
    recordVote(walletAddress, methodId, vote, feedback || null);

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
