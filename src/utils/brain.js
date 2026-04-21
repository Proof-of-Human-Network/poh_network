'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const BRAIN_STATE_PATH = path.join(__dirname, '../../data/brain_state.md');
const DATASET_PATH = path.join(__dirname, '../../data/dataset.json');

let ollamaBusy = false;

// ── Helpers ───────────────────────────────────────────────────────────────────

function getBrainState() {
  if (!fs.existsSync(BRAIN_STATE_PATH)) return '';
  return fs.readFileSync(BRAIN_STATE_PATH, 'utf-8');
}

function saveBrainState(content) {
  fs.writeFileSync(BRAIN_STATE_PATH, content, 'utf-8');
}

function getRecentExamples(n = 20) {
  if (!fs.existsSync(DATASET_PATH)) return [];
  const dataset = JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'));
  // Return last N entries that are scan or vote records (skip generic placeholder entries)
  return dataset
    .filter(d => d.instruction.startsWith('Verification') || d.instruction.startsWith('Voter'))
    .slice(-n);
}

async function ollamaChat(prompt, { maxTokens = 512, timeLimit = 120000 } = {}) {
  ollamaBusy = true;
  try {
    const res = await axios.post(`${OLLAMA_URL}/api/generate`, {
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { temperature: 0.1, num_predict: maxTokens }
    }, { timeout: timeLimit });
    return res.data.response?.trim() || '';
  } catch (err) {
    console.error('[brain] Ollama call failed:', err.message);
    return null;
  } finally {
    ollamaBusy = false;
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Called after every scan.
 * Analyzes method results and returns { verdict: 'HUMAN'|'AI', confidence: 0-1, reasoning: string }
 */
async function analyzeHumanness(address, methodResults, methods) {
  if (ollamaBusy) {
    console.log('[brain] Ollama busy — skipping verdict for', address);
    return { verdict: 'PENDING', confidence: 0, reasoning: 'Brain is busy, try again shortly' };
  }
  const brainState = getBrainState();
  const examples = getRecentExamples(15);

  const methodSummary = methodResults.map(r => {
    const m = methods.find(m => m.id === r.methodId);
    const score = m?.score ?? 0;
    return `- ${r.description} (community score: ${score.toFixed(1)}): ${r.result ? 'PASSED' : 'FAILED'}`;
  }).join('\n');

  const exampleSummary = examples.length > 0
    ? examples.slice(-5).map(e => `  [${e.output}] ${e.input}`).join('\n')
    : '  (no prior examples yet)';

  const prompt = `Classify this blockchain wallet as HUMAN or BOT based on on-chain evidence. Be decisive.

Prior knowledge: ${brainState ? brainState.slice(0, 300) : 'none'}

Recent scans: ${exampleSummary}

Wallet ${address} evidence:
${methodSummary}

Reply ONLY in this exact format:
VERDICT: HUMAN or BOT
CONFIDENCE: 0.0-1.0
REASONING: one sentence about the evidence`;

  const response = await ollamaChat(prompt, { maxTokens: 80, timeLimit: 25000 });
  if (!response) return { verdict: 'UNKNOWN', confidence: 0, reasoning: 'Brain offline' };

  const verdictMatch = response.match(/VERDICT:\s*(HUMAN|BOT|AI)/i);
  const confidenceMatch = response.match(/CONFIDENCE:\s*([\d.]+)/i);
  const reasoningMatch = response.match(/REASONING:\s*(.+)/is);

  return {
    verdict: verdictMatch?.[1]?.toUpperCase() || 'UNKNOWN',
    confidence: parseFloat(confidenceMatch?.[1] || '0.5'),
    reasoning: reasoningMatch?.[1]?.trim() || response
  };
}

/**
 * Called when a new method is added to the listing.
 * Ollama evaluates if it's a useful human signal and records its understanding.
 */
async function onNewMethod(method) {
  const brainState = getBrainState();

  const prompt = `You are the AI brain of a Proof of Human network. A new detection method has been submitted.

## Your current knowledge:
${brainState || '(no prior knowledge yet)'}

## New method submitted:
Type: ${method.type}
Description: ${method.description}
Address/URL: ${method.address || 'N/A'}
Method: ${method.method || 'N/A'}
Expression: ${method.expression || 'N/A'}

## Task:
In 2-3 sentences, assess: Is this method likely to be a useful signal for detecting human vs bot behavior? What should the network watch for when using it?
Keep it concise.`;

  const assessment = await ollamaChat(prompt);
  if (assessment) {
    console.log(`[brain] New method assessment for "${method.description}": ${assessment}`);
    // Append to brain state
    const current = getBrainState();
    const updated = current + `\n\n### Method Added: ${method.description} (${new Date().toISOString()})\n${assessment}`;
    saveBrainState(updated.trim());
  }
  return assessment;
}

/**
 * Called when a vote is cast.
 * Updates brain state with community feedback on a method.
 */
async function onVote(method, voteType, vote, stakeWeight) {
  const voteLabel = vote ? 'TRUE / YES' : 'FALSE / NO';
  const voteContext = {
    description: `Is the description accurate?`,
    method: `Can this detect human behavior?`,
    risk: `Can an AI fake this?`
  }[voteType] || voteType;

  const brainState = getBrainState();

  const prompt = `You are the AI brain of a Proof of Human network. A community member just voted on a method.

## Your current knowledge:
${brainState || '(no prior knowledge)'}

## Vote event:
Method: ${method.description}
Question: ${voteContext}
Vote: ${voteLabel}
Voter stake weight: ${stakeWeight.toFixed(4)} (higher = more trusted)
Method current score: ${method.score?.toFixed(1)}

## Task:
In 1-2 sentences, update your understanding of this method based on this vote. What does this tell you about its reliability as a human signal?`;

  const insight = await ollamaChat(prompt);
  if (insight) {
    console.log(`[brain] Vote insight for "${method.description}": ${insight}`);
    const current = getBrainState();
    const updated = current + `\n\n### Vote on: ${method.description} (${voteLabel}, weight: ${stakeWeight.toFixed(3)}) — ${new Date().toISOString()}\n${insight}`;
    saveBrainState(updated.trim());
  }
  return insight;
}

/**
 * Called by the scheduler periodically.
 * Consolidates all accumulated data into a compact brain state.
 * This is where "learning" compounds — the brain gets smarter over time.
 */
async function consolidate() {
  const dataset = fs.existsSync(DATASET_PATH)
    ? JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'))
    : [];

  const scanRecords = dataset.filter(d => d.instruction.startsWith('Verification'));
  const voteRecords = dataset.filter(d => d.instruction.startsWith('Voter'));
  const currentBrain = getBrainState();

  if (scanRecords.length === 0 && voteRecords.length === 0) {
    console.log('[brain] Consolidation skipped — no data yet');
    return;
  }

  // Only use last 8 of each to keep prompt short
  const recentScans = scanRecords.slice(-8).map(r =>
    `${r.instruction.replace('Verification response for ', '').slice(0, 60)} → ${r.output}`
  ).join('\n');

  const recentVotes = voteRecords.slice(-8).map(r =>
    `${r.instruction.slice(0, 50)} | ${r.input.slice(0, 40)} → ${r.output}`
  ).join('\n');

  const prompt = `Update this Proof of Human brain state based on new evidence. Be concise (max 120 words).

Current state: ${currentBrain ? currentBrain.slice(0, 200) : 'none'}

Recent scans:
${recentScans || 'none'}

Recent votes:
${recentVotes || 'none'}

Write updated bullet-point summary of: which wallets are human vs bot, which methods work best.`;

  console.log('[brain] Consolidating knowledge...');
  const newBrainState = await ollamaChat(prompt, { maxTokens: 200, timeLimit: 60000 });
  if (newBrainState) {
    saveBrainState(`# Brain State — Last updated: ${new Date().toISOString()}\n\n${newBrainState}`);
    console.log('[brain] Consolidation complete. Brain state updated.');
  }
}

module.exports = { analyzeHumanness, onNewMethod, onVote, consolidate };
