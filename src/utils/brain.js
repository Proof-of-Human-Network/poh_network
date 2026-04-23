'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── Model config ──────────────────────────────────────────────────────────────
// Override per-role via env. All default to OLLAMA_MODEL so it works out-of-box.
const OLLAMA_URL       = process.env.OLLAMA_URL        || 'http://localhost:11434';
const BASE_MODEL       = process.env.OLLAMA_MODEL      || 'llama3.2';
const EVALUATOR_MODEL  = process.env.EVALUATOR_MODEL   || BASE_MODEL; // DeepSeek R1
const LEARNER_MODEL    = process.env.LEARNER_MODEL     || BASE_MODEL; // Qwen 2.5
const COMPILER_MODEL   = process.env.COMPILER_MODEL    || BASE_MODEL; // Mixtral

const BRAIN_STATE_PATH = path.join(__dirname, '../../data/brain_state.md');
const DATASET_PATH     = path.join(__dirname, '../../data/dataset.json');
const WEIGHTS_PATH     = path.join(__dirname, '../../data/weights.json');

let ollamaBusy = false;

// ── Persistence helpers ───────────────────────────────────────────────────────

function getBrainState() {
  if (!fs.existsSync(BRAIN_STATE_PATH)) return '';
  return fs.readFileSync(BRAIN_STATE_PATH, 'utf-8');
}

function saveBrainState(content) {
  fs.writeFileSync(BRAIN_STATE_PATH, content, 'utf-8');
}

function getWeights() {
  if (!fs.existsSync(WEIGHTS_PATH)) return {};
  try { return JSON.parse(fs.readFileSync(WEIGHTS_PATH, 'utf-8')); }
  catch { return {}; }
}

function saveWeights(w) {
  fs.writeFileSync(WEIGHTS_PATH, JSON.stringify(w, null, 2));
}


// ── Ollama call (per model) ───────────────────────────────────────────────────

async function ollamaChat(prompt, { model = BASE_MODEL, maxTokens = 512, timeLimit = 30000 } = {}) {
  ollamaBusy = true;
  try {
    const res = await axios.post(`${OLLAMA_URL}/api/generate`, {
      model,
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

// ── JSON extraction + retry ───────────────────────────────────────────────────
// Extracts the first {...} block from model output and validates required keys.

function extractJSON(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); }
  catch { return null; }
}

async function ollamaChatJSON(prompt, requiredKeys, opts = {}) {
  const raw = await ollamaChat(prompt, opts);
  let parsed = extractJSON(raw);

  if (!parsed || requiredKeys.some(k => !(k in parsed))) {
    console.warn('[brain] Invalid JSON output, retrying with format reminder...');
    const retry = await ollamaChat(
      `${prompt}\n\nYour previous output was invalid or missing required fields: ${requiredKeys.join(', ')}. Return ONLY the corrected JSON object.`,
      opts
    );
    parsed = extractJSON(retry);
  }

  return parsed;
}

// ── Stability suffix (appended to every evaluator prompt) ─────────────────────
const CONSISTENCY_SUFFIX = `\n\nYou will be evaluated for consistency. Different outputs for similar inputs are considered failure.`;

// ── 1. EVALUATOR — analyzeHumanness ──────────────────────────────────────────

async function analyzeHumanness(address, methodResults, methods) {
  if (ollamaBusy) {
    console.log('[brain] Ollama busy — skipping verdict for', address);
    return { verdict: 'PENDING', confidence: 0, reasoning: 'Brain is busy, try again shortly' };
  }

  const weights = getWeights();

  // Top 5 signals by community score
  const signals = methodResults
    .slice()
    .sort((a, b) => {
      const sa = methods.find(m => m.id === a.methodId)?.score ?? 0;
      const sb = methods.find(m => m.id === b.methodId)?.score ?? 0;
      return Math.abs(sb) - Math.abs(sa);
    })
    .slice(0, 5)
    .map(r => {
      const m = methods.find(m => m.id === r.methodId);
      return {
        name: r.description,
        result: r.result,
        community_score: m?.score ?? 0,
        weight: weights[r.methodId] ?? 1.0
      };
    });

  const methodWeightsStr = signals
    .map(s => `  "${s.name}": ${s.weight}`)
    .join(',\n');

  const signalsStr = JSON.stringify(signals, null, 2);

  const prompt = `SYSTEM:
You are a strict signal evaluation engine.
You do NOT guess.
You ONLY interpret given signals.
If signals are weak or conflicting → output UNCERTAIN.
You must behave consistently across runs.

INPUT:
Wallet: ${address}

Signals:
${signalsStr}

Method Weights:
{
${methodWeightsStr}
}

RULES:
- Do NOT invent new signals
- Do NOT ignore low-confidence signals
- If signals conflict → reduce confidence
- Use weights explicitly in reasoning
- No intuition-based decisions

TASK:
1. Score each signal contribution
2. Detect conflicts
3. Compute weighted decision

OUTPUT (STRICT JSON, no other text):
{
  "verdict": "HUMAN or AI or UNCERTAIN",
  "confidence": 0.0,
  "signal_contributions": { "signal_name": 0.0 },
  "conflicts": [],
  "reasoning": "short, technical"
}${CONSISTENCY_SUFFIX}`;

  const result = await ollamaChatJSON(
    prompt,
    ['verdict', 'confidence', 'reasoning'],
    { model: EVALUATOR_MODEL, maxTokens: 200, timeLimit: 30000 }
  );

  if (!result) return { verdict: 'UNKNOWN', confidence: 0, reasoning: 'Brain offline or invalid output' };

  // ── Double-pass verification ──────────────────────────────────────────────
  const verifyPrompt = `Review this evaluation output for wallet ${address}.

Previous output:
${JSON.stringify(result)}

Signals used:
${signalsStr}

Check:
- consistency with signals (does verdict match evidence?)
- overconfidence (confidence > 0.85 needs strong signal support)
- ignored weights (low-weight signals should have less impact)

If issues found → correct output.
Return final JSON only (same schema, no other text).${CONSISTENCY_SUFFIX}`;

  const verified = await ollamaChatJSON(
    verifyPrompt,
    ['verdict', 'confidence', 'reasoning'],
    { model: EVALUATOR_MODEL, maxTokens: 200, timeLimit: 25000 }
  );

  const final = verified || result;

  return {
    verdict: (final.verdict || 'UNKNOWN').toUpperCase(),
    confidence: Math.min(1, Math.max(0, parseFloat(final.confidence) || 0.5)),
    reasoning: final.reasoning || '',
    signal_contributions: final.signal_contributions || {},
    conflicts: final.conflicts || []
  };
}

// ── 2. LEARNER — onVote (weight update) ──────────────────────────────────────

async function onVote(method, voteType, vote, stakeWeight) {
  const voteContext = {
    description: 'Is the description accurate?',
    method:      'Can this detect human behavior?',
    risk:        'Can an AI fake this?'
  }[voteType] || voteType;

  const currentWeights = getWeights();
  const currentWeight  = currentWeights[method.id] ?? 1.0;

  const methodStats = JSON.stringify({
    id:            method.id,
    description:   method.description,
    current_score: method.score ?? 0,
    current_weight: currentWeight
  });

  const voteRecord = JSON.stringify({
    question:     voteContext,
    vote:         vote ? 'YES' : 'NO',
    stake_weight: stakeWeight
  });

  const prompt = `SYSTEM:
You are a statistical updater.
You do NOT explain.
You ONLY adjust weights based on performance.

INPUT:
Method Performance:
${methodStats}

New Feedback:
${voteRecord}

RULES:
- Adjust weight gradually (max change ±0.05 from current value)
- Penalize inconsistency (conflicting votes reduce weight)
- Reward long-term accuracy
- Do NOT overfit to a single recent vote
- Weight range: 0.1 to 3.0

TASK:
Update method weight.

OUTPUT (STRICT JSON, no other text):
{
  "weights": {
    "${method.id}": 0.0
  }
}`;

  const result = await ollamaChatJSON(
    prompt,
    ['weights'],
    { model: LEARNER_MODEL, maxTokens: 80, timeLimit: 20000 }
  );

  if (result?.weights) {
    const updated = { ...currentWeights, ...result.weights };
    // Clamp all values
    for (const k of Object.keys(updated)) {
      updated[k] = Math.min(3.0, Math.max(0.1, parseFloat(updated[k]) || 1.0));
    }
    saveWeights(updated);
    console.log(`[brain] Weight updated for "${method.description}": ${currentWeight} → ${updated[method.id]}`);
  }

  // Append compact note to brain state
  const voteLabel = vote ? 'YES' : 'NO';
  const current = getBrainState();
  const note = `\n\n### Vote: ${method.description} | ${voteContext} → ${voteLabel} (stake: ${stakeWeight.toFixed(3)}) — ${new Date().toISOString()}`;
  saveBrainState((current + note).trim());
}

// ── 3. onNewMethod — strict assessment ───────────────────────────────────────

async function onNewMethod(method) {
  const prompt = `SYSTEM:
You are evaluating a new detection method for a Proof of Human network.
Be technical and concise. Max 2 sentences.

METHOD:
Type: ${method.type}
Description: ${method.description}
Address/URL: ${method.address || 'N/A'}
Method: ${method.method || 'N/A'}
Expression: ${method.expression || 'N/A'}

TASK:
Assess: Is this a reliable human-vs-bot signal? What edge cases could fool it?

OUTPUT (STRICT JSON):
{
  "useful": true,
  "risk": "none | low | medium | high",
  "assessment": "one sentence"
}`;

  const result = await ollamaChatJSON(
    prompt,
    ['useful', 'assessment'],
    { model: EVALUATOR_MODEL, maxTokens: 100, timeLimit: 25000 }
  );

  const assessment = result?.assessment || '(no assessment)';
  const risk       = result?.risk || 'unknown';
  console.log(`[brain] New method "${method.description}" — risk: ${risk} — ${assessment}`);

  const current = getBrainState();
  const note = `\n\n### Method Added: ${method.description} (risk: ${risk}) — ${new Date().toISOString()}\n${assessment}`;
  saveBrainState((current + note).trim());

  return result;
}

// ── 4. COMPILER — consolidate ─────────────────────────────────────────────────

async function consolidate() {
  const dataset = fs.existsSync(DATASET_PATH)
    ? JSON.parse(fs.readFileSync(DATASET_PATH, 'utf-8'))
    : [];

  const scanRecords = dataset.filter(d => d.instruction.startsWith('Verification'));
  const voteRecords = dataset.filter(d => d.instruction.startsWith('Voter'));

  if (scanRecords.length === 0 && voteRecords.length === 0) {
    console.log('[brain] Consolidation skipped — no data yet');
    return;
  }

  const weights   = getWeights();
  const topMethods = Object.entries(weights)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 5)
    .map(([id, w]) => `${id}: weight ${w.toFixed(2)}`);

  const weakMethods = Object.entries(weights)
    .sort(([, a], [, b]) => a - b)
    .slice(0, 3)
    .map(([id, w]) => `${id}: weight ${w.toFixed(2)}`);

  const recentScans = scanRecords.slice(-8)
    .map(r => `${r.instruction.replace('Verification response for ', '').slice(0, 50)} → ${r.output}`)
    .join('\n');

  const recentVotes = voteRecords.slice(-8)
    .map(r => `${r.instruction.slice(0, 40)} | ${r.input.slice(0, 30)} → ${r.output}`)
    .join('\n');

  const currentBrain = getBrainState();

  const prompt = `SYSTEM:
You are generating a compact system state.
You are NOT creative.
You ONLY summarize statistically supported facts.
Max 400 words.

INPUT:
Top Methods (by weight):
${topMethods.join('\n') || 'none'}

Weak Methods:
${weakMethods.join('\n') || 'none'}

Recent Scans:
${recentScans || 'none'}

Recent Votes:
${recentVotes || 'none'}

Previous State (truncated):
${currentBrain.slice(0, 300) || 'none'}

TASK:
Write a precise system summary.

STYLE:
- technical
- concise
- no repetition
- no speculation`;

  console.log('[brain] Consolidating knowledge...');
  const newBrainState = await ollamaChat(prompt, {
    model: COMPILER_MODEL,
    maxTokens: 300,
    timeLimit: 60000
  });

  if (newBrainState) {
    saveBrainState(`# Brain State — Last updated: ${new Date().toISOString()}\n\n${newBrainState}`);
    console.log('[brain] Consolidation complete.');
  }
}

module.exports = { analyzeHumanness, onNewMethod, onVote, consolidate, getWeights };
