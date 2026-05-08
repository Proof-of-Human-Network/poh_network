'use strict';

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ── Model config ──────────────────────────────────────────────────────────────
// Override per-role via env. All default to OLLAMA_MODEL so it works out-of-box.
const OLLAMA_URL       = process.env.OLLAMA_URL        || 'http://localhost:11434';
const BASE_MODEL       = process.env.OLLAMA_MODEL      || 'qwen2.5:1.5b';
const EVALUATOR_MODEL  = process.env.EVALUATOR_MODEL   || 'deepseek-r1:1.5b';
const LEARNER_MODEL    = process.env.LEARNER_MODEL     || 'qwen2.5:1.5b';
const COMPILER_MODEL   = process.env.COMPILER_MODEL    || 'mixtral:latest';

// ── Qvac config (OpenAI-compatible evaluator — set QVAC_URL to enable) ────────
// Run: qvac serve openai --port 11435
const QVAC_URL   = process.env.QVAC_URL   || null;
const QVAC_MODEL = process.env.QVAC_MODEL || EVALUATOR_MODEL;

const BRAIN_STATE_PATH = path.join(__dirname, '../../data/brain_state.md');
const DATASET_PATH     = path.join(__dirname, '../../data/dataset.json');
const WEIGHTS_PATH     = path.join(__dirname, '../../data/weights.json');
const FEEDBACK_PATH    = path.join(__dirname, '../../data/feedback.json');

// ── Ollama request queue (serializes all calls — Ollama is single-instance) ───
let _ollamaQueue = Promise.resolve();

function queueOllama(fn) {
  _ollamaQueue = _ollamaQueue.then(fn, fn);
  return _ollamaQueue;
}

// ── Qvac request queue (separate from Ollama — runs on different port) ────────
let _qvacQueue = Promise.resolve();

function queueQvac(fn) {
  _qvacQueue = _qvacQueue.then(fn, fn);
  return _qvacQueue;
}

// Kept for the analyzeHumanness busy-check (prevents stacking verdict requests)
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

function getFeedback() {
  if (!fs.existsSync(FEEDBACK_PATH)) return [];
  try { return JSON.parse(fs.readFileSync(FEEDBACK_PATH, 'utf-8')); }
  catch { return []; }
}

function saveFeedback(list) {
  fs.writeFileSync(FEEDBACK_PATH, JSON.stringify(list, null, 2));
}

// Returns the last N human corrections as a compact string for prompt injection
function recentCorrectionsStr(n = 5) {
  const corrections = getFeedback()
    .filter(f => f.correction)
    .slice(-n);
  if (!corrections.length) return '';
  return corrections
    .map(f => `- ${f.address?.slice(0, 8)}… AI said ${f.aiVerdict}, user says ${f.correction}${f.comment ? ': "' + f.comment.slice(0, 80) + '"' : ''}`)
    .join('\n');
}


// ── Ollama call (per model) ───────────────────────────────────────────────────

async function ollamaChat(prompt, { model = BASE_MODEL, maxTokens = 512, timeLimit = 30000, jsonMode = false } = {}) {
  return queueOllama(async () => {
    ollamaBusy = true;
    try {
      const body = {
        model,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: maxTokens },
      };
      if (jsonMode) body.format = 'json';
      const res = await axios.post(`${OLLAMA_URL}/api/generate`, body, { timeout: timeLimit });
      return res.data.response?.trim() || '';
    } catch (err) {
      console.error('[brain] Ollama call failed:', err.message);
      return null;
    } finally {
      ollamaBusy = false;
    }
  });
}

// ── JSON extraction ───────────────────────────────────────────────────────────
// Handles DeepSeek <think>...</think> blocks, markdown code fences, and bare JSON.

function extractJSON(text) {
  if (!text) return null;
  // Strip DeepSeek chain-of-thought tags
  let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  clean = clean.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  // Find the first complete {...} block
  const match = clean.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); }
  catch {
    // Try to recover truncated JSON by finding the last valid close
    const s = match[0];
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i] === '}') {
        try { return JSON.parse(s.slice(0, i + 1)); } catch { continue; }
      }
    }
    return null;
  }
}

async function ollamaChatJSON(prompt, requiredKeys, opts = {}) {
  const raw = await ollamaChat(prompt, { ...opts, jsonMode: true });
  let parsed = extractJSON(raw);

  if (!parsed || requiredKeys.some(k => !(k in parsed))) {
    console.warn('[brain] Invalid JSON output, retrying...');
    const retry = await ollamaChat(
      `${prompt}\n\nIMPORTANT: Respond with ONLY a valid JSON object. Required fields: ${requiredKeys.join(', ')}. No other text.`,
      { ...opts, jsonMode: true }
    );
    parsed = extractJSON(retry);
  }

  return parsed;
}

// ── Qvac chat (OpenAI-compatible, for Evaluator role) ────────────────────────

let _qvacFailures = 0;
const QVAC_CIRCUIT_OPEN_AFTER = 3;  // disable after this many consecutive failures
let _qvacCircuitOpenAt = 0;         // timestamp when circuit opened (0 = closed)
const QVAC_RETRY_AFTER_MS = 5 * 60 * 1000; // re-probe after 5 minutes

async function qvacChat(prompt, { model = QVAC_MODEL, maxTokens = 256, timeLimit = 120000, jsonMode = false } = {}) {
  // Circuit breaker: skip if too many recent failures; re-probe after cooldown
  if (_qvacCircuitOpenAt) {
    if (Date.now() - _qvacCircuitOpenAt < QVAC_RETRY_AFTER_MS) return null;
    _qvacCircuitOpenAt = 0; // probe again
  }

  return queueQvac(async () => {
    try {
      const body = {
        model,
        messages: [
          { role: 'system', content: 'You are a JSON-only responder. Output only valid JSON. No explanations, no markdown, no preamble.' },
          { role: 'user', content: prompt + '\n/no_think' }, // suppresses Qwen3 chain-of-thought
        ],
        max_tokens: maxTokens,
        temperature: 0.1,
        stream: false,
      };
      const res = await axios.post(`${QVAC_URL}/v1/chat/completions`, body, { timeout: timeLimit });
      _qvacFailures = 0; // reset on success
      return res.data.choices?.[0]?.message?.content?.trim() || '';
    } catch (err) {
      _qvacFailures++;
      if (_qvacFailures >= QVAC_CIRCUIT_OPEN_AFTER) {
        _qvacCircuitOpenAt = Date.now();
        console.warn(`[brain] Qvac circuit open after ${_qvacFailures} failures — will retry in 5 min`);
      } else {
        console.error('[brain] Qvac call failed:', err.message);
      }
      return null;
    }
  });
}

// ── Role routers — Qvac if configured, Ollama otherwise ──────────────────────

async function evaluatorChat(prompt, opts = {}) {
  if (QVAC_URL) {
    const result = await qvacChat(prompt, opts);
    if (result !== null) return result;
    if (!_qvacCircuitOpenAt) console.warn('[brain] Qvac unavailable — falling back to Ollama for evaluation');
  }
  return ollamaChat(prompt, { ...opts, model: EVALUATOR_MODEL });
}

async function evaluatorChatJSON(prompt, requiredKeys, opts = {}) {
  const raw = await evaluatorChat(prompt, { ...opts, jsonMode: true });
  let parsed = extractJSON(raw);

  if (!parsed || requiredKeys.some(k => !(k in parsed))) {
    console.warn('[brain] Evaluator invalid JSON, retrying... raw:', (raw || '').slice(0, 200));
    const retry = await evaluatorChat(
      `Output ONLY a JSON object with fields ${requiredKeys.join(', ')}. Example: {"verdict":"HUMAN","confidence":0.8,"reasoning":"x"}\n\nNow output JSON for this task:\n${prompt}`,
      { ...opts, jsonMode: false }
    );
    console.warn('[brain] Retry raw:', (retry || '').slice(0, 200));
    parsed = extractJSON(retry);
  }

  return parsed;
}

async function learnerChat(prompt, opts = {}) {
  if (QVAC_URL) {
    const result = await qvacChat(prompt, opts);
    if (result !== null) return result;
  }
  return ollamaChat(prompt, { ...opts, model: LEARNER_MODEL });
}

async function learnerChatJSON(prompt, requiredKeys, opts = {}) {
  const raw = await learnerChat(prompt, { ...opts, jsonMode: true });
  let parsed = extractJSON(raw);
  if (!parsed || requiredKeys.some(k => !(k in parsed))) {
    const retry = await learnerChat(
      `${prompt}\n\nIMPORTANT: Respond with ONLY a valid JSON object. Required fields: ${requiredKeys.join(', ')}. No other text.`,
      { ...opts, jsonMode: true }
    );
    parsed = extractJSON(retry);
  }
  return parsed;
}

async function compilerChat(prompt, opts = {}) {
  if (QVAC_URL) {
    const result = await qvacChat(prompt, opts);
    if (result !== null) return result;
  }
  return ollamaChat(prompt, { ...opts, model: COMPILER_MODEL });
}

// ── 1. EVALUATOR — analyzeHumanness ──────────────────────────────────────────

async function analyzeHumanness(address, methodResults, methods) {
  if (!QVAC_URL && ollamaBusy) {
    console.log('[brain] Ollama busy — skipping verdict for', address);
    return { verdict: 'PENDING', confidence: 0, reasoning: 'Brain is busy, try again shortly' };
  }

  const weights = getWeights();
  const usingQvac = QVAC_URL && !_qvacCircuitOpenAt;

  // Qvac 600M has ~2k token context — keep prompt tiny
  // Ollama: all passed + top-10 failed; Qvac: top-4 passed + top-4 failed
  const passed = methodResults
    .filter(r => r.result === true)
    .sort((a, b) => (weights[b.methodId] ?? 1) - (weights[a.methodId] ?? 1))
    .slice(0, usingQvac ? 4 : Infinity);
  const failed = methodResults
    .filter(r => r.result === false)
    .sort((a, b) => (weights[b.methodId] ?? 1) - (weights[a.methodId] ?? 1))
    .slice(0, usingQvac ? 4 : 10);

  const signals = [...passed, ...failed].map(r => ({
    name: r.description,
    pass: r.result,
    w: +(weights[r.methodId] ?? 1.0).toFixed(2),
  }));

  const signalsStr = signals
    .map(s => `[${s.pass ? 'PASS' : 'FAIL'}] ${s.name} (w:${s.w})`)
    .join('\n');

  const corrections = recentCorrectionsStr(5);
  const correctionBlock = corrections
    ? `\nRecent human corrections (learn from these mistakes):\n${corrections}\n`
    : '';

  const prompt = `Proof of Human evaluator. Is wallet ${address} HUMAN, AI, or UNCERTAIN?

Signals (${passed.length} passed, ${failed.length} failed shown):
${signalsStr}
${correctionBlock}
Return ONLY valid JSON with verdict HUMAN|AI|UNCERTAIN, confidence 0.0-1.0, and reasoning:
{"verdict":"...","confidence":0.0,"reasoning":"..."}`;

  const backend = usingQvac ? 'Qvac' : 'Ollama';
  console.log(`[brain] Evaluating ${address} via ${backend}`);

  const result = await evaluatorChatJSON(
    prompt,
    ['verdict', 'confidence', 'reasoning'],
    { maxTokens: 256, timeLimit: usingQvac ? 120000 : 40000 }
  );

  if (!result) {
    // Heuristic fallback: score by pass ratio weighted by method weights
    const totalW = signals.reduce((s, x) => s + x.w, 0) || 1;
    const passW  = signals.filter(x => x.pass).reduce((s, x) => s + x.w, 0);
    const ratio  = passW / totalW;
    return {
      verdict:    ratio >= 0.55 ? 'HUMAN' : ratio <= 0.35 ? 'AI' : 'UNCERTAIN',
      confidence: Math.round(Math.abs(ratio - 0.5) * 2 * 100) / 100,
      reasoning:  `Heuristic fallback: ${signals.filter(x => x.pass).length}/${signals.length} signals passed`,
    };
  }

  // Double-pass verification — skip for Qvac (small model, no concurrent jobs)
  let final = result;
  if (!usingQvac) {
    const verifyPrompt = `Review and correct this verdict if wrong.

Wallet: ${address}
Signals:
${signalsStr}
Previous: ${JSON.stringify(result)}

Return corrected JSON only:
{"verdict":"HUMAN or AI or UNCERTAIN","confidence":0.0_to_1.0,"reasoning":"explanation"}`;

    const verified = await evaluatorChatJSON(
      verifyPrompt,
      ['verdict', 'confidence', 'reasoning'],
      { maxTokens: 400, timeLimit: 30000 }
    );
    final = verified || result;
  }

  return {
    verdict: (final.verdict || 'UNKNOWN').toUpperCase(),
    confidence: Math.min(1, Math.max(0, parseFloat(final.confidence) || 0.5)),
    reasoning: final.reasoning || '',
    signal_contributions: final.signal_contributions || {},
    conflicts: final.conflicts || []
  };
}

// ── 2. LEARNER — onVote (weight update) ──────────────────────────────────────

async function onVote(method, voteType, vote, stakeWeight, feedback = null) {
  const voteContext = {
    description: 'Is the description accurate?',
    method:      'Can this detect human behavior?',
    risk:        'Can an AI fake this?'
  }[voteType] || voteType;

  const currentWeights = getWeights();
  const currentWeight  = currentWeights[method.id] ?? 1.0;

  const feedbackLine = feedback
    ? `Voter reasoning: "${feedback.slice(0, 200)}"`
    : 'Voter reasoning: (none provided)';

  const prompt = `A detection method was voted on. Should its weight go up or down?

Method: ${method.description}
Current weight: ${currentWeight}
Vote question: ${voteContext}
Vote: ${vote ? 'YES (good signal)' : 'NO (bad signal)'}
Voter stake: ${stakeWeight.toFixed(3)}
${feedbackLine}

Reply with ONLY this JSON (new_weight must be within 0.05 of current weight ${currentWeight}):
{"new_weight": ${currentWeight}}`;

  const result = await learnerChatJSON(
    prompt,
    ['new_weight'],
    { maxTokens: 60, timeLimit: 20000 }
  );

  const updated = { ...currentWeights };
  if (result?.new_weight != null) {
    const proposed = parseFloat(result.new_weight) || currentWeight;
    // Hard-enforce ±0.05 drift cap regardless of what the LLM returned
    const clamped = Math.min(3.0, Math.max(0.1,
      Math.min(currentWeight + 0.05, Math.max(currentWeight - 0.05, proposed))
    ));
    updated[method.id] = clamped;
  } else {
    // LLM failed — apply a simple heuristic directly
    const delta = (vote ? 1 : -1) * 0.02 * Math.min(stakeWeight * 10, 1);
    updated[method.id] = Math.min(3.0, Math.max(0.1, currentWeight + delta));
  }
  saveWeights(updated);
  console.log(`[brain] Weight updated for "${method.description}": ${currentWeight} → ${updated[method.id].toFixed(3)}`);

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

  const result = await evaluatorChatJSON(
    prompt,
    ['useful', 'assessment'],
    { maxTokens: 250, timeLimit: 30000 }
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
  const newBrainState = await compilerChat(prompt, {
    maxTokens: 300,
    timeLimit: 60000
  });

  if (newBrainState) {
    saveBrainState(`# Brain State — Last updated: ${new Date().toISOString()}\n\n${newBrainState}`);
    console.log('[brain] Consolidation complete.');
  }
}

// ── 5. validateDescription ────────────────────────────────────────────────────
async function validateDescription(description) {
  const prompt = `You are validating a method description submitted to a Proof of Human detection network.
The description must clearly explain what on-chain or API signal is being checked and why it indicates human activity.

Description to evaluate: "${description.slice(0, 300)}"

Reject if: random characters, placeholder text (test, asdf, foo, hello world), too vague (< 5 meaningful words), no clear signal described, or clearly not about human detection.
Accept if: it describes a specific on-chain or off-chain signal, API endpoint, or behavior pattern relevant to distinguishing humans from bots.

Reply with ONLY this JSON:
{"valid": true, "reason": "one sentence"}
or
{"valid": false, "reason": "one sentence explaining what's wrong"}`;

  const result = await evaluatorChatJSON(
    prompt,
    ['valid', 'reason'],
    { maxTokens: 80, timeLimit: 20000 }
  );
  return result || { valid: false, reason: 'Validation unavailable — try again shortly' };
}

// ── 6. validateFeedback ───────────────────────────────────────────────────────
async function validateFeedback(feedback) {
  const prompt = `You are moderating a vote comment submitted to a Proof of Human detection network.
The comment explains why a voter thinks a detection method is or isn't valid for identifying humans.

Comment to evaluate: "${feedback.slice(0, 400)}"

Reject if: random characters, gibberish, profanity, spam (aaa, test, asdf), placeholder text, completely off-topic, or adds zero information about the method's validity.
Accept if: it gives any reasoning about why the method does or doesn't indicate human activity — even a short but genuine opinion counts.

Reply with ONLY this JSON:
{"valid": true, "reason": "one sentence"}
or
{"valid": false, "reason": "one sentence explaining what's wrong"}`;

  const result = await evaluatorChatJSON(
    prompt,
    ['valid', 'reason'],
    { maxTokens: 80, timeLimit: 20000 }
  );
  return result || { valid: true, reason: 'Validation unavailable — skipped' };
}

// ── 7. onVerdictFeedback — user corrects AI verdict ──────────────────────────

async function onVerdictFeedback(address, aiVerdict, correction, comment, signals = []) {
  // Persist the correction
  const list = getFeedback();
  list.push({
    address,
    aiVerdict,
    correction,   // 'HUMAN' | 'AI'
    comment: comment || null,
    signals: signals.map(s => ({ id: s.methodId, pass: s.result, desc: (s.description || '').slice(0, 60) })),
    ts: new Date().toISOString(),
  });
  saveFeedback(list);

  // Only adjust weights if there's a clear disagreement
  if (!correction || correction === aiVerdict) return;

  const weights = getWeights();
  // Signals that should have been weighted differently:
  // AI said HUMAN but user says AI → passed signals were misleading → reduce their weight
  // AI said AI but user says HUMAN → failed signals might be misleading → reduce failed, boost passed
  const misleading = correction === 'AI'
    ? signals.filter(s => s.result === true)   // passed but shouldn't count
    : signals.filter(s => s.result === false);  // failed but shouldn't disqualify

  const supportive = correction === 'HUMAN'
    ? signals.filter(s => s.result === true)
    : [];

  const updated = { ...weights };
  for (const s of misleading) {
    const cur = updated[s.methodId] ?? 1.0;
    updated[s.methodId] = Math.min(3.0, Math.max(0.1, +(cur - 0.03).toFixed(3)));
  }
  for (const s of supportive) {
    const cur = updated[s.methodId] ?? 1.0;
    updated[s.methodId] = Math.min(3.0, Math.max(0.1, +(cur + 0.02).toFixed(3)));
  }
  saveWeights(updated);

  // Ask the learner what it thinks about this mistake
  const signalsSummary = signals
    .slice(0, 8)
    .map(s => `[${s.result ? 'PASS' : 'FAIL'}] ${(s.description || s.methodId || '').slice(0, 50)}`)
    .join('\n');

  const prompt = `A verdict was wrong. Learn from this.

Wallet: ${address}
AI verdict: ${aiVerdict}
Correct verdict (user): ${correction}
${comment ? `User comment: "${comment.slice(0, 200)}"` : ''}

Signals:
${signalsSummary}

Which signal type was most misleading? One sentence max.
{"insight":"..."}`;

  const insight = await learnerChatJSON(prompt, ['insight'], {
    maxTokens: 80, timeLimit: 20000,
  });

  const note = `\n\n### Verdict Correction — ${new Date().toISOString()}\nAddress: ${address}\nAI said: ${aiVerdict} → User says: ${correction}\n${comment ? `Comment: "${comment}"\n` : ''}${insight?.insight ? `Insight: ${insight.insight}` : ''}`;
  saveBrainState((getBrainState() + note).trim());

  console.log(`[brain] Feedback recorded: ${aiVerdict}→${correction} for ${address}`);
}

module.exports = { analyzeHumanness, onNewMethod, onVote, onVerdictFeedback, consolidate, getWeights, validateDescription, validateFeedback };
