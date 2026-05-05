<script setup>
const emit = defineEmits(['show-section', 'load-profile', 'load-my-votes'])
</script>

<template>
  <div class="api-page">
    <div class="scan-hero">
      <div class="scan-tag">API REFERENCE</div>
      <h2 class="scan-title">Integrate POH</h2>
      <p class="scan-sub">Simple HTTP API. First 100 scans free per wallet. Authenticate with an API key from your profile.</p>
    </div>

    <!-- Pricing table -->
    <div class="api-section">
      <div class="api-section-title">Pricing</div>
      <div class="pricing-table">
        <div class="pt-row pt-head"><span>Batch size</span><span>Rate</span><span>Example</span></div>
        <div class="pt-row"><span>1 – 9 addresses</span><span>1.00 POH / addr</span><span>5 addrs = 5 POH</span></div>
        <div class="pt-row"><span>10 – 49 addresses</span><span>0.85 POH / addr</span><span>20 addrs = 17 POH</span></div>
        <div class="pt-row"><span>50 – 99 addresses</span><span>0.70 POH / addr</span><span>70 addrs = 49 POH</span></div>
        <div class="pt-row"><span>100 – 499 addresses</span><span>0.55 POH / addr</span><span>200 addrs = 110 POH</span></div>
        <div class="pt-row"><span>500+ addresses</span><span>0.40 POH / addr</span><span>1000 addrs = 400 POH</span></div>
        <div class="pt-row pt-free"><span>Free tier</span><span>0 POH</span><span>First 100 scans per wallet</span></div>
      </div>
    </div>

    <!-- POST /checker -->
    <div class="api-section">
      <div class="api-section-title">
        <span class="api-method api-method--post">POST</span> /checker
      </div>
      <div class="api-card">
        <div class="api-desc">Scan one or more wallet addresses against all registered detection methods. Single address → synchronous result with <code>brainKey</code>. Multiple addresses or CSV upload → async job with <code>jobId</code> to poll.</div>
        <div class="api-params">
          <div class="param-row"><code>input</code><span>string or array — wallet address(es) to scan</span></div>
          <div class="param-row"><code>walletAddress</code><span>your Solana wallet (for free tier tracking)</span></div>
          <div class="param-row"><code>apiKey</code><span>API key from your profile (alternative to walletAddress)</span></div>
          <div class="param-row"><code>txHash</code><span>POH burn transaction hash (required for paid scans)</span></div>
          <div class="param-row"><code>chainIds</code><span>comma-separated chain IDs to filter EVM methods (optional)</span></div>
          <div class="param-row"><code>csv</code><span>multipart file upload — CSV with address column (bulk mode)</span></div>
        </div>

        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--sh">bash</span></div>
          <pre class="code-pre"><span class="sh-cmd">curl</span> <span class="sh-flag">-X</span> POST https://proofofhuman.ge/checker \
  <span class="sh-flag">-H</span> <span class="sh-str">"Content-Type: application/json"</span> \
  <span class="sh-flag">-d</span> <span class="sh-str">'{
    "input": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "apiKey": "your-api-key-here"
  }'</span></pre>
        </div>

        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--sh">bash — bulk CSV</span></div>
          <pre class="code-pre"><span class="sh-cmd">curl</span> <span class="sh-flag">-X</span> POST https://proofofhuman.ge/checker \
  <span class="sh-flag">-F</span> <span class="sh-str">"csv=@wallets.csv"</span> \
  <span class="sh-flag">-F</span> <span class="sh-str">"apiKey=your-api-key-here"</span> \
  <span class="sh-flag">-F</span> <span class="sh-str">"txHash=your-payment-tx"</span>
<span class="sh-comment"># → { jobId, status: "queued", total, pollUrl }</span></pre>
        </div>

        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--js">JavaScript</span></div>
          <pre class="code-pre"><span class="js-kw">const</span> res <span class="js-op">=</span> <span class="js-kw">await</span> <span class="js-fn">fetch</span>(<span class="js-str">'/checker'</span>, {
  method: <span class="js-str">'POST'</span>,
  headers: { <span class="js-str">'Content-Type'</span>: <span class="js-str">'application/json'</span> },
  body: <span class="js-obj">JSON</span>.<span class="js-fn">stringify</span>({
    input: <span class="js-str">'0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'</span>,
    apiKey: <span class="js-str">'your-api-key-here'</span>
  })
})
<span class="js-kw">const</span> { result, brainKey, freeScansLeft } <span class="js-op">=</span> <span class="js-kw">await</span> res.<span class="js-fn">json</span>()</pre>
        </div>

        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--json">response</span></div>
          <pre class="code-pre">{
  <span class="json-key">"result"</span>: [...],
  <span class="json-key">"brainKey"</span>: <span class="json-str">"abc123"</span>,
  <span class="json-key">"freeScansLeft"</span>: <span class="json-num">99</span>
}</pre>
        </div>
      </div>
    </div>

    <!-- GET /checker/job/:jobId -->
    <div class="api-section">
      <div class="api-section-title">
        <span class="api-method api-method--get">GET</span> /checker/job/:jobId
      </div>
      <div class="api-card">
        <div class="api-desc">Poll the status of a bulk scan job. <code>jobId</code> is returned by POST /checker when more than one address is submitted. Jobs are retained for 2 hours after completion.</div>
        <div class="api-params">
          <div class="param-row"><code>status</code><span>queued | running | done</span></div>
          <div class="param-row"><code>total</code><span>total addresses in the job</span></div>
          <div class="param-row"><code>done</code><span>addresses processed so far</span></div>
          <div class="param-row"><code>percent</code><span>completion percentage (0–100)</span></div>
          <div class="param-row"><code>results</code><span>array of per-method scan results (grows incrementally)</span></div>
        </div>

        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--js">JavaScript — poll until done</span></div>
          <pre class="code-pre"><span class="js-kw">const</span> { jobId } <span class="js-op">=</span> <span class="js-kw">await</span> <span class="js-fn">fetch</span>(<span class="js-str">'/checker'</span>, { method: <span class="js-str">'POST'</span>, <span class="sh-comment">...</span> }).<span class="js-fn">then</span>(r <span class="js-op">=></span> r.<span class="js-fn">json</span>())

<span class="js-kw">async function</span> <span class="js-fn">pollJob</span>(jobId) {
  <span class="js-kw">while</span> (<span class="js-bool">true</span>) {
    <span class="js-kw">const</span> job <span class="js-op">=</span> <span class="js-kw">await</span> <span class="js-fn">fetch</span>(<span class="js-str">`/checker/job/${jobId}`</span>).<span class="js-fn">then</span>(r <span class="js-op">=></span> r.<span class="js-fn">json</span>())
    <span class="js-obj">console</span>.<span class="js-fn">log</span>(<span class="js-str">`${job.percent}% — ${job.done}/${job.total}`</span>)
    <span class="js-kw">if</span> (job.status <span class="js-op">===</span> <span class="js-str">'done'</span>) <span class="js-kw">return</span> job.results
    <span class="js-kw">await</span> <span class="js-kw">new</span> <span class="js-obj">Promise</span>(r <span class="js-op">=></span> <span class="js-fn">setTimeout</span>(r, <span class="js-num">3000</span>))
  }
}

<span class="js-kw">const</span> results <span class="js-op">=</span> <span class="js-kw">await</span> <span class="js-fn">pollJob</span>(jobId)</pre>
        </div>
      </div>
    </div>

    <!-- GET /checker/brain/:key -->
    <div class="api-section">
      <div class="api-section-title">
        <span class="api-method api-method--get">GET</span> /checker/brain/:key
      </div>
      <div class="api-card">
        <div class="api-desc">Poll for the async AI verdict after a scan. <code>brainKey</code> is returned by POST /checker. Returns <code>status: "pending" | "done" | "error"</code>.</div>
        <div class="api-params">
          <div class="param-row"><code>verdict</code><span>HUMAN | AI | UNCERTAIN | UNKNOWN</span></div>
          <div class="param-row"><code>confidence</code><span>0.0 – 1.0</span></div>
          <div class="param-row"><code>reasoning</code><span>short technical explanation</span></div>
        </div>

        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--sh">bash</span></div>
          <pre class="code-pre"><span class="sh-cmd">curl</span> https://proofofhuman.ge/checker/brain/<span class="sh-str">abc123</span></pre>
        </div>

        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--json">response</span></div>
          <pre class="code-pre">{
  <span class="json-key">"status"</span>: <span class="json-str">"done"</span>,
  <span class="json-key">"verdict"</span>: <span class="json-str">"HUMAN"</span>,
  <span class="json-key">"confidence"</span>: <span class="json-num">0.87</span>,
  <span class="json-key">"reasoning"</span>: <span class="json-str">"Active ETH history, ENS registered, PAXG holder..."</span>
}</pre>
        </div>
      </div>
    </div>

    <!-- GET /checker/pricing -->
    <div class="api-section">
      <div class="api-section-title">
        <span class="api-method api-method--get">GET</span> /checker/pricing?count=N
      </div>
      <div class="api-card">
        <div class="api-desc">Returns cost breakdown for a given batch size before committing.</div>
        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--sh">bash</span></div>
          <pre class="code-pre"><span class="sh-cmd">curl</span> <span class="sh-str">"https://proofofhuman.ge/checker/pricing?count=100"</span></pre>
        </div>
        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--json">response</span></div>
          <pre class="code-pre">{
  <span class="json-key">"count"</span>: <span class="json-num">100</span>,
  <span class="json-key">"perAddress"</span>: <span class="json-num">0.55</span>,
  <span class="json-key">"total"</span>: <span class="json-num">55000000</span>,
  <span class="json-key">"tiers"</span>: [...]
}</pre>
        </div>
      </div>
    </div>

    <!-- GET /profile/:address -->
    <div class="api-section">
      <div class="api-section-title">
        <span class="api-method api-method--get">GET</span> /profile/:address
      </div>
      <div class="api-card">
        <div class="api-desc">Returns profile stats, submitted methods, and reward totals for a wallet address.</div>
        <div class="code-block">
          <div class="code-lang-bar"><span class="code-lang-badge code-lang-badge--sh">bash</span></div>
          <pre class="code-pre"><span class="sh-cmd">curl</span> https://proofofhuman.ge/profile/<span class="sh-str">YourSolanaWalletAddressHere</span></pre>
        </div>
      </div>
    </div>

    <div class="api-cta">
      <p>Get your API key from your <button class="utility-link" @click="emit('show-section', 'profile'); emit('load-profile'); emit('load-my-votes')">profile →</button></p>
    </div>
  </div>
</template>

<style scoped>
/* ── Code blocks ─────────────────────────────────────────────────────────── */
.code-block {
  margin-top: 1rem;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #1e1e1e;
}

.code-lang-bar {
  background: #111;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid #1e1e1e;
}

.code-lang-badge {
  font-size: 0.72rem;
  font-family: 'JetBrains Mono', monospace;
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  font-weight: 500;
}
.code-lang-badge--sh   { background: #1a1a0d; color: #a3a300; border: 1px solid #2a2a00; }
.code-lang-badge--js   { background: #0d1a0a; color: #4ec994; border: 1px solid #1a3a1a; }
.code-lang-badge--json { background: #0d0d1a; color: #7c9dcc; border: 1px solid #1a1a3a; }

.code-pre {
  margin: 0;
  padding: 1rem 1.1rem;
  background: #0a0a0a;
  font-family: 'JetBrains Mono', 'Fira Code', monospace;
  font-size: 0.82rem;
  line-height: 1.7;
  overflow-x: auto;
  white-space: pre;
}

/* Bash / shell */
.sh-cmd     { color: #7ec8e3; }
.sh-flag    { color: #9d7ec8; }
.sh-str     { color: #a8d8a8; }
.sh-comment { color: #555; font-style: italic; }

/* JavaScript */
.js-kw   { color: #c792ea; }
.js-fn   { color: #82aaff; }
.js-str  { color: #a8d8a8; }
.js-num  { color: #f78c6c; }
.js-op   { color: #89ddff; }
.js-obj  { color: #ffcb6b; }
.js-bool { color: #ff9d00; }

/* JSON */
.json-key { color: #7c9dcc; }
.json-str { color: #a8d8a8; }
.json-num { color: #f78c6c; }

/* ── HTTP method badges ───────────────────────────────────────────────────── */
.api-method {
  display: inline-block;
  font-size: 0.72rem;
  font-family: 'JetBrains Mono', monospace;
  font-weight: 700;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  margin-right: 0.4rem;
  vertical-align: middle;
}
.api-method--post { background: #1a1400; color: #f59e0b; border: 1px solid #f59e0b40; }
.api-method--get  { background: #0d1a0d; color: #22c55e; border: 1px solid #22c55e40; }
</style>
