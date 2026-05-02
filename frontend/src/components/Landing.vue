<template>
  <div class="app-wrap">

    <!-- NAV -->
    <header class="top-nav">
      <div class="nav-brand">
        <span class="brand-dot"></span>
        <span class="brand-name">POH</span>
        <span class="brand-sub">Proof of Human</span>
      </div>
      <nav class="nav-links">
        <a href="#scan" class="nav-link">Scanner</a>
        <a href="#signals" class="nav-link">Signals</a>
        <a href="#community" class="nav-link">Community</a>
        <a href="https://t.me/poh_network_group" target="_blank" class="nav-link">Telegram</a>
      </nav>
      <a href="https://proofofhuman.ge" class="nav-cta">Launch App →</a>
    </header>

    <!-- PROBLEM SCREEN -->
    <section class="problem-screen">
      <div class="problem-inner">
        <div class="problem-tag">THE PROBLEM</div>
        <h2 class="problem-title">Soon, there will be more AI-agents, than <span class="problem-accent">people</span></h2>
        <blockquote class="problem-quote">
          "The company already has a lot more cybersecurity AI agents than people working on cybersecurity."
          <cite>— Jensen Huang, CEO of NVIDIA</cite>
        </blockquote>
        <p class="problem-desc">Wallets, votes, and on-chain identities can no longer be trusted at face value.<br>POH verifies humanity through evidence — not promises.</p>
        <a href="https://proofofhuman.ge" class="neon-btn">Scan a Wallet →</a>
      </div>
    </section>

    <!-- FEAT: SCAN -->
    <section id="scan" class="feat-screen">
      <div class="feat-left">
        <div class="feat-tag">SCAN</div>
        <h2 class="feat-title">Verify any wallet<br>in seconds</h2>
        <p class="feat-body">Paste an EVM address, Solana address, or ENS name. POH runs all registered detection methods in parallel and returns an AI verdict.</p>
        <a href="https://proofofhuman.ge" class="feat-cta">Try the Scanner →</a>
      </div>
      <div class="feat-right">
        <svg class="feat-svg" viewBox="0 0 420 320" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="10" y="10" width="400" height="300" rx="14" fill="#090909" stroke="#1a1a1a"/>
          <rect x="28" y="30" width="310" height="36" rx="7" fill="#111" stroke="#222"/>
          <text x="42" y="53" fill="#555" font-size="11" font-family="monospace">0xd8dA6BF26964aF9D7eEd9e03E534...</text>
          <rect x="346" y="30" width="52" height="36" rx="7" fill="#161616" stroke="#222"/>
          <text x="355" y="53" fill="#666" font-size="11" font-family="monospace">Scan</text>
          <line x1="28" y1="80" x2="392" y2="80" stroke="#161616"/>
          <g><rect x="28" y="90" width="364" height="28" rx="5" fill="#0d0d0d"/>
            <circle cx="42" cy="104" r="4" fill="#22c55e"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.4s" fill="freeze"/></circle>
            <text x="54" y="108" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.4s" fill="freeze"/>SOL balance &gt; 0.01</text>
            <text x="346" y="108" fill="#22c55e" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.4s" fill="freeze"/>✓</text>
          </g>
          <g><rect x="28" y="122" width="364" height="28" rx="5" fill="#0d0d0d"/>
            <circle cx="42" cy="136" r="4" fill="#22c55e"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.75s" fill="freeze"/></circle>
            <text x="54" y="140" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.75s" fill="freeze"/>ENS name registered</text>
            <text x="346" y="140" fill="#22c55e" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.75s" fill="freeze"/>✓</text>
          </g>
          <g><rect x="28" y="154" width="364" height="28" rx="5" fill="#0d0d0d"/>
            <circle cx="42" cy="168" r="4" fill="#ef4444"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.05s" fill="freeze"/></circle>
            <text x="54" y="172" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.05s" fill="freeze"/>Farcaster profile</text>
            <text x="340" y="172" fill="#ef4444" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.05s" fill="freeze"/>✗</text>
          </g>
          <g><rect x="28" y="186" width="364" height="28" rx="5" fill="#0d0d0d"/>
            <circle cx="42" cy="200" r="4" fill="#22c55e"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.35s" fill="freeze"/></circle>
            <text x="54" y="204" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.35s" fill="freeze"/>Galxe identity</text>
            <text x="346" y="204" fill="#22c55e" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.35s" fill="freeze"/>✓</text>
          </g>
          <g><rect x="28" y="218" width="364" height="28" rx="5" fill="#0d0d0d"/>
            <circle cx="42" cy="232" r="4" fill="#22c55e"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.6s" fill="freeze"/></circle>
            <text x="54" y="236" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.6s" fill="freeze"/>PAXG holder</text>
            <text x="346" y="236" fill="#22c55e" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.6s" fill="freeze"/>✓</text>
          </g>
          <!-- Verdict badge -->
          <rect x="28" y="260" width="364" height="36" rx="7" fill="#0a1a0a" stroke="#22c55e44" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.4s" begin="2s" fill="freeze"/>
          </rect>
          <text x="50" y="282" fill="#22c55e" font-size="13" font-family="monospace" font-weight="bold" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.4s" begin="2s" fill="freeze"/>HUMAN · 87% confidence
          </text>
        </svg>
      </div>
    </section>

    <!-- FEAT: SIGNALS -->
    <section id="signals" class="feat-screen feat-screen--alt">
      <div class="feat-right">
        <BrainGraph :methods="methods" />
      </div>
      <div class="feat-left">
        <div class="feat-tag">SIGNALS</div>
        <h2 class="feat-title">Evidence from<br>every layer</h2>
        <p class="feat-body">EVM balances, Solana programs, REST identity APIs, real-world asset holdings, Galxe profiles, web3.bio social links, Web3 domains. Every signal runs in parallel.</p>
        <a href="https://proofofhuman.ge" class="feat-cta">Browse Methods →</a>
      </div>
    </section>

    <!-- FEAT: AI BRAIN -->
    <section class="feat-screen">
      <div class="feat-left">
        <div class="feat-tag">AI BRAIN</div>
        <h2 class="feat-title">On-device AI,<br>zero cloud calls</h2>
        <p class="feat-body">A local LLM reads every signal, weighs community-trained scores, and outputs a structured verdict with confidence and reasoning. Runs on Qvac. Private by default.</p>
        <a href="https://proofofhuman.ge" class="feat-cta">See a Verdict →</a>
      </div>
      <div class="feat-right">
        <svg class="feat-svg" viewBox="0 0 420 320" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="10" y="10" width="400" height="300" rx="14" fill="#090909" stroke="#1a1a1a"/>
          <text x="28" y="42" fill="#333" font-size="9" font-family="monospace">SIGNALS</text>
          <rect x="28" y="52" width="140" height="22" rx="4" fill="#0d1a0d" stroke="#1a3a1a"/>
          <text x="36" y="67" fill="#22c55e" font-size="9" font-family="monospace">✓ ETH balance</text>
          <rect x="28" y="78" width="140" height="22" rx="4" fill="#0d1a0d" stroke="#1a3a1a"/>
          <text x="36" y="93" fill="#22c55e" font-size="9" font-family="monospace">✓ ENS registered</text>
          <rect x="28" y="104" width="140" height="22" rx="4" fill="#1a0d0d" stroke="#3a1a1a"/>
          <text x="36" y="119" fill="#ef4444" font-size="9" font-family="monospace">✗ Galxe profile</text>
          <rect x="28" y="130" width="140" height="22" rx="4" fill="#0d1a0d" stroke="#1a3a1a"/>
          <text x="36" y="145" fill="#22c55e" font-size="9" font-family="monospace">✓ PAXG holder</text>
          <rect x="28" y="156" width="140" height="22" rx="4" fill="#0d1a0d" stroke="#1a3a1a"/>
          <text x="36" y="171" fill="#22c55e" font-size="9" font-family="monospace">✓ Farcaster</text>
          <path d="M168 130 Q210 130 210 130" stroke="#222" stroke-width="1.5"/>
          <circle cx="210" cy="130" r="0" fill="#111" stroke="#222">
            <animate attributeName="r" values="0;22" dur="0.4s" begin="0.5s" fill="freeze"/>
          </circle>
          <text x="204" y="126" fill="#fff" font-size="8" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.8s" fill="freeze"/>AI
          </text>
          <text x="200" y="138" fill="#fff" font-size="8" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.8s" fill="freeze"/>BRAIN
          </text>
          <rect x="250" y="72" width="148" height="120" rx="8" fill="#0f1f0f" stroke="#1a4a1a" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.3s" fill="freeze"/>
          </rect>
          <text x="264" y="98" fill="#22c55e" font-size="11" font-family="monospace" font-weight="bold" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.5s" fill="freeze"/>HUMAN
          </text>
          <text x="264" y="115" fill="#555" font-size="8" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.7s" fill="freeze"/>confidence</text>
          <rect x="264" y="122" width="0" height="8" rx="2" fill="#22c55e" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.1s" begin="1.9s" fill="freeze"/>
            <animate attributeName="width" values="0;116" dur="0.5s" begin="2s" fill="freeze"/>
          </rect>
          <text x="264" y="148" fill="#555" font-size="8" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.3s" begin="2.7s" fill="freeze"/>87% · 4/5 signals pass</text>
        </svg>
      </div>
    </section>

    <!-- FEAT: COMMUNITY -->
    <section id="community" class="feat-screen feat-screen--alt">
      <div class="feat-right">
        <svg class="feat-svg" viewBox="0 0 420 320" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="10" y="10" width="400" height="300" rx="14" fill="#090909" stroke="#1a1a1a"/>
          <rect x="28" y="28" width="364" height="90" rx="8" fill="#0d0d0d" stroke="#1a1a1a"/>
          <text x="44" y="52" fill="#888" font-size="10" font-family="monospace">Does ENS name → indicate a real person?</text>
          <text x="44" y="72" fill="#555" font-size="9" font-family="monospace">A named wallet shows long-term commitment to</text>
          <text x="44" y="86" fill="#555" font-size="9" font-family="monospace">on-chain identity — bots rarely register names.</text>
          <rect x="44" y="100" width="80" height="14" rx="3" fill="#0a1a0a" stroke="#22c55e44"/>
          <text x="52" y="111" fill="#22c55e" font-size="8" font-family="monospace">score: +12</text>
          <rect x="28" y="132" width="364" height="30" rx="5" fill="#0f0f0f" stroke="#1e1e1e"/>
          <text x="44" y="151" fill="#444" font-size="9" font-family="monospace">Your reasoning (optional)...</text>
          <rect x="28" y="174" width="172" height="32" rx="6" fill="#0a1a0a" stroke="#22c55e55">
            <animate attributeName="stroke" values="#22c55e33;#22c55eaa;#22c55e33" dur="2s" repeatCount="indefinite"/>
          </rect>
          <text x="56" y="195" fill="#22c55e" font-size="11" font-family="monospace">✓ Human</text>
          <rect x="212" y="174" width="180" height="32" rx="6" fill="#0f0d0d" stroke="#3a1a1a"/>
          <text x="240" y="195" fill="#555" font-size="11" font-family="monospace">✗ Bot / AI</text>
          <text x="44" y="234" fill="#333" font-size="9" font-family="monospace">342 votes cast  ·  stake weight: 1.4×</text>
          <rect x="28" y="248" width="364" height="6" rx="3" fill="#1a1a1a"/>
          <rect x="28" y="248" width="0" height="6" rx="3" fill="#22c55e">
            <animate attributeName="width" values="0;280" dur="1s" begin="0.5s" fill="freeze"/>
          </rect>
          <text x="28" y="272" fill="#333" font-size="8" font-family="monospace">76% human</text>
        </svg>
      </div>
      <div class="feat-left">
        <div class="feat-tag">COMMUNITY</div>
        <h2 class="feat-title">You decide what<br>counts as human</h2>
        <p class="feat-body">Vote on detection methods. Stake POH to amplify your signal. The community continuously trains the AI — no central authority decides what's human.</p>
        <a href="https://proofofhuman.ge" class="feat-cta">Open Vote Queue →</a>
      </div>
    </section>

    <!-- FEAT: API -->
    <section class="feat-screen">
      <div class="feat-left">
        <div class="feat-tag">API</div>
        <h2 class="feat-title">One call.<br>Instant answer.</h2>
        <p class="feat-body">Integrate POH into any dApp, bot filter, or airdrop tool. REST API with API key auth, bulk CSV scanning, async job queue, and 100 free scans per wallet.</p>
        <a href="https://proofofhuman.ge" class="feat-cta">View API Docs →</a>
      </div>
      <div class="feat-right">
        <svg class="feat-svg" viewBox="0 0 420 320" fill="none" xmlns="http://www.w3.org/2000/svg">
          <rect x="10" y="10" width="400" height="300" rx="14" fill="#080808" stroke="#1a1a1a"/>
          <rect x="10" y="10" width="400" height="28" rx="14" fill="#111" stroke="#1a1a1a"/>
          <rect x="10" y="24" width="400" height="14" fill="#111"/>
          <circle cx="32" cy="24" r="5" fill="#333"/>
          <circle cx="50" cy="24" r="5" fill="#333"/>
          <circle cx="68" cy="24" r="5" fill="#333"/>
          <text x="28" y="60" fill="#555" font-size="9" font-family="monospace">POST /checker</text>
          <text x="28" y="76" fill="#1e3a1e" font-size="9" font-family="monospace">&#123;</text>
          <text x="28" y="90" fill="#2a2a2a" font-size="9" font-family="monospace">  "input": "0xd8dA6BF26964..."</text>
          <text x="28" y="104" fill="#2a2a2a" font-size="9" font-family="monospace">  "apiKey": "pk_live_xxx"</text>
          <text x="28" y="118" fill="#1e3a1e" font-size="9" font-family="monospace">&#125;</text>
          <line x1="28" y1="134" x2="392" y2="134" stroke="#161616"/>
          <text x="28" y="152" fill="#555" font-size="9" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.3s" begin="1s" fill="freeze"/>200 OK  · 340ms</text>
          <text x="28" y="168" fill="#1a3a1a" font-size="9" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.2s" begin="1.2s" fill="freeze"/>&#123;</text>
          <text x="28" y="182" fill="#2a3a2a" font-size="9" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.2s" begin="1.35s" fill="freeze"/>  "verdict": "HUMAN",</text>
          <text x="28" y="196" fill="#2a3a2a" font-size="9" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.2s" begin="1.5s" fill="freeze"/>  "confidence": 0.87,</text>
          <text x="28" y="210" fill="#2a3a2a" font-size="9" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.2s" begin="1.65s" fill="freeze"/>  "passed": 4,</text>
          <text x="28" y="224" fill="#2a3a2a" font-size="9" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.2s" begin="1.8s" fill="freeze"/>  "total": 5,</text>
          <text x="28" y="238" fill="#2a3a2a" font-size="9" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.2s" begin="1.95s" fill="freeze"/>  "freeScansLeft": 96</text>
          <text x="28" y="252" fill="#1a3a1a" font-size="9" font-family="monospace" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.2s" begin="2.1s" fill="freeze"/>&#125;</text>
          <rect x="100" y="174" width="52" height="14" rx="3" fill="#0f2a0f" opacity="0">
            <animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.4s" fill="freeze"/>
          </rect>
        </svg>
      </div>
    </section>

  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import axios from 'axios'
import BrainGraph from './BrainGraph.vue'

const methods = ref([])
onMounted(async () => {
  try {
    const res = await axios.get('/methods/verifyer')
    methods.value = res.data
  } catch {}
})
</script>

<style scoped>
* { box-sizing: border-box; }

.app-wrap {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0 2rem;
}

/* ── Nav ─────────────────────────────────────────────────────────────────── */
.top-nav {
  display: flex;
  align-items: center;
  gap: 2rem;
  padding: 1.5rem 0;
  border-bottom: 1px solid #111;
  margin-bottom: 0;
}
.nav-brand { display: flex; align-items: center; gap: 0.6rem; margin-right: auto; }
.brand-dot { width: 8px; height: 8px; border-radius: 50%; background: #22c55e; box-shadow: 0 0 8px #22c55e; }
.brand-name { font-size: 1rem; font-weight: 700; color: #fff; letter-spacing: 0.05em; }
.brand-sub { font-size: 0.72rem; color: #444; letter-spacing: 0.08em; }
.nav-links { display: flex; gap: 1.5rem; }
.nav-link { color: #555; font-size: 0.85rem; text-decoration: none; transition: color 0.15s; }
.nav-link:hover { color: #fff; }
.nav-cta {
  background: #111; border: 1px solid #222; border-radius: 7px;
  color: #888; font-size: 0.82rem; padding: 0.45rem 1rem;
  text-decoration: none; transition: color 0.15s, border-color 0.15s;
  white-space: nowrap;
}
.nav-cta:hover { color: #fff; border-color: #555; }

/* ── Problem screen ──────────────────────────────────────────────────────── */
.problem-screen {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.problem-inner {
  max-width: 680px;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}
.problem-tag { font-size: 0.7rem; font-weight: 700; letter-spacing: 0.2em; color: #333; }
.problem-title { font-size: clamp(2.2rem, 5vw, 3.8rem); font-weight: 700; color: #fff; line-height: 1.08; letter-spacing: -0.03em; margin: 0; }
.problem-accent { color: #22c55e; }
.problem-quote { border-left: 2px solid #1e1e1e; margin: 0; padding: 0.75rem 1.25rem; color: #444; font-style: italic; font-size: 0.95rem; line-height: 1.6; }
.problem-quote cite { display: block; margin-top: 0.5rem; font-size: 0.82rem; color: #333; font-style: normal; }
.problem-desc { color: #555; font-size: 1.05rem; line-height: 1.7; margin: 0; }

/* ── Buttons ─────────────────────────────────────────────────────────────── */
.neon-btn {
  display: inline-block;
  background: #fff;
  color: #000;
  border: none;
  border-radius: 8px;
  padding: 0.75rem 1.5rem;
  font-size: 0.95rem;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  transition: opacity 0.15s;
  align-self: flex-start;
}
.neon-btn:hover { opacity: 0.88; }

/* ── Feature screens ─────────────────────────────────────────────────────── */
.feat-screen {
  min-height: 100vh;
  display: flex;
  align-items: center;
  gap: 4rem;
  padding: 6rem 0;
  border-bottom: 1px solid #0f0f0f;
}
.feat-screen--alt { flex-direction: row-reverse; }
.feat-left { flex: 1; display: flex; flex-direction: column; gap: 1.5rem; max-width: 460px; }
.feat-right { flex: 1; display: flex; align-items: center; justify-content: center; }
.feat-tag { font-size: 0.7rem; letter-spacing: 0.18em; color: #333; font-weight: 600; }
.feat-title { font-size: clamp(2rem, 4vw, 3rem); font-weight: 700; color: #fff; line-height: 1.1; letter-spacing: -0.03em; margin: 0; }
.feat-body { font-size: 1.05rem; color: #555; line-height: 1.7; margin: 0; }
.feat-cta { align-self: flex-start; background: none; border: none; color: #666; font-size: 0.95rem; cursor: pointer; padding: 0; transition: color 0.15s; text-decoration: none; }
.feat-cta:hover { color: #fff; }
.feat-svg { width: 100%; max-width: 420px; height: auto; overflow: visible; }

@media (max-width: 768px) {
  .feat-screen { flex-direction: column !important; min-height: auto; padding: 4rem 0; gap: 2.5rem; }
  .feat-left { max-width: 100%; }
  .feat-svg { max-width: 100%; }
  .nav-links { display: none; }
}
</style>
