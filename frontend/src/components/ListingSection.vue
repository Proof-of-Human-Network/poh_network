<script setup>
import { ref } from 'vue'
import axios from 'axios'

const props = defineProps({
  listing:      { type: Object,  required: true },
  headers:      { type: Array,   required: true },
  abiFns:       { type: Array,   default: () => [] },
  abiLoading:   { type: Boolean, default: false },
  abiError:     { type: String,  default: null },
  loading:      { type: Boolean, default: false },
  pohBalance:   { type: Number,  default: 0 },
  LISTING_FEE_POH: { type: Number, default: 1000 },
})

const emit = defineEmits([
  'update:listing',
  'update:headers',
  'fetch-abi',
  'pick-method',
  'add-header',
  'remove-header',
  'submit-listing',
  'auto-expand',
])

function updateListing(key, val) {
  emit('update:listing', { ...props.listing, [key]: val })
}

function updateListingAndReset(key, val) {
  emit('update:listing', { ...props.listing, [key]: val })
  // reset abiFns via parent by re-triggering fetch
}

// ── Preview ───────────────────────────────────────────────────────────────────

const previewAddr    = ref('')
const previewLoading = ref(false)
const previewResult  = ref(null)
const previewError   = ref(null)

async function runPreview() {
  if (!previewAddr.value?.trim()) return
  previewLoading.value = true
  previewResult.value  = null
  previewError.value   = null
  try {
    const m = { ...props.listing }
    if (m.type === 'rest') {
      m.method = m.httpMethod
      const headerObj = (props.headers || []).reduce((a, h) => {
        if (h.key) a[h.key] = h.value
        return a
      }, {})
      m.headers = JSON.stringify(headerObj)
    }
    const { data } = await axios.post('/checker/preview', { address: previewAddr.value.trim(), method: m })
    if (data.error) previewError.value = data.error
    else previewResult.value = data
  } catch (e) {
    previewError.value = e.response?.data?.error || e.message
  } finally {
    previewLoading.value = false
  }
}
</script>

<template>
  <div class="content-section">
    <div class="listing-header">
      <div class="scan-tag">METHOD LISTING</div>
      <h2 class="scan-title">Submit a detection method</h2>
      <p class="scan-sub">Define a signal and pay 1000 POH to register it. 500 POH goes to stakers immediately, 500 to the protocol. Earn rewards when your method is used in scans.</p>
    </div>

    <div class="form-section">
      <div class="form-label-row">
        <span class="form-section-label">Method Type</span>
      </div>
      <div class="type-tabs">
        <button :class="['type-tab', { active: listing.type === 'evm' }]" @click="updateListing('type', 'evm'); emit('fetch-abi')">EVM Contract</button>
        <button :class="['type-tab', { active: listing.type === 'solana' }]" @click="updateListing('type', 'solana'); emit('fetch-abi')">Solana Program</button>
        <button :class="['type-tab', { active: listing.type === 'rest' }]" @click="updateListing('type', 'rest')">REST API</button>
      </div>
    </div>

    <!-- EVM fields -->
    <div v-if="listing.type === 'evm'" class="form-section">
      <div class="form-label-row"><span class="form-section-label">Contract</span></div>
      <div class="input-group">
        <div class="form-row">
          <div class="form-col-sm">
            <label class="field-label">Chain ID</label>
            <input type="number" :value="listing.chainId" @input="updateListing('chainId', $event.target.value)" placeholder="1" class="premium-input" />
          </div>
          <div class="form-col-lg">
            <label class="field-label">Contract Address</label>
            <div class="flex-input">
              <input type="text" :value="listing.address" @input="updateListing('address', $event.target.value)" placeholder="0x..." class="premium-input flex-grow" @blur="emit('fetch-abi')" />
              <button @click="emit('fetch-abi')" :disabled="abiLoading || !listing.address" class="mini-btn">{{ abiLoading ? '...' : 'Fetch ABI' }}</button>
            </div>
          </div>
        </div>
        <div v-if="abiError" class="field-hint field-hint--warn">{{ abiError }}</div>
        <div v-if="abiFns.length" class="abi-picker">
          <div class="abi-picker-header">
            <span class="abi-picker-label">ABI Methods</span>
            <span class="abi-picker-count">{{ abiFns.length }} found</span>
          </div>
          <div class="abi-picker-list">
            <button v-for="fn in abiFns" :key="fn.name" @click="emit('pick-method', fn)" :class="['abi-fn-btn', { selected: listing.method === fn.name }]">{{ fn.name }}</button>
          </div>
        </div>
        <div class="form-row">
          <div class="form-col">
            <label class="field-label">Method Name <span class="field-hint-inline">e.g. balanceOf</span></label>
            <input type="text" :value="listing.method" @input="updateListing('method', $event.target.value)" placeholder="balanceOf" class="premium-input font-mono" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-col">
            <label class="field-label">Input Types <span class="field-hint-inline">JSON array e.g. ["address"]</span></label>
            <input type="text" :value="listing.abiTypes" @input="updateListing('abiTypes', $event.target.value)" placeholder='["address"]' class="premium-input font-mono" />
          </div>
          <div class="form-col">
            <label class="field-label">Return Types <span class="field-hint-inline">JSON array e.g. ["uint256"]</span></label>
            <input type="text" :value="listing.returnTypes" @input="updateListing('returnTypes', $event.target.value)" placeholder='["uint256"]' class="premium-input font-mono" />
          </div>
        </div>
        <div class="form-row">
          <div class="form-col-sm">
            <label class="field-label">Decimals <span class="field-hint-inline">for token values</span></label>
            <input type="number" :value="listing.decimals" @input="updateListing('decimals', $event.target.value)" placeholder="18" class="premium-input" />
          </div>
        </div>
      </div>
    </div>

    <!-- Solana fields -->
    <div v-if="listing.type === 'solana'" class="form-section">
      <div class="form-label-row"><span class="form-section-label">Program</span></div>
      <div class="input-group">
        <div>
          <label class="field-label">Program Address (Mint for token balance)</label>
          <div class="flex-input">
            <input type="text" :value="listing.address" @input="updateListing('address', $event.target.value)" placeholder="Program or mint address" class="premium-input flex-grow" @blur="emit('fetch-abi')" />
            <button @click="emit('fetch-abi')" :disabled="abiLoading || !listing.address" class="mini-btn">{{ abiLoading ? '...' : 'Fetch IDL' }}</button>
          </div>
        </div>
        <div v-if="abiError" class="field-hint field-hint--warn">{{ abiError }}</div>
        <div v-if="abiFns.length" class="abi-picker">
          <div class="abi-picker-header">
            <span class="abi-picker-label">IDL Instructions</span>
            <span class="abi-picker-count">{{ abiFns.length }} found</span>
          </div>
          <div class="abi-picker-list">
            <button v-for="fn in abiFns" :key="fn.name" @click="emit('pick-method', fn)" :class="['abi-fn-btn', { selected: listing.method === fn.name }]">{{ fn.name }}</button>
          </div>
        </div>
        <div>
          <label class="field-label">Method</label>
          <select :value="listing.method" @change="updateListing('method', $event.target.value)" class="premium-select">
            <option value="getBalance">getBalance — native SOL balance</option>
            <option value="getTransactionCount">getTransactionCount — tx history count</option>
            <option value="getTokenBalance">getTokenBalance — SPL token balance (requires mint address above)</option>
          </select>
        </div>
        <div class="form-row">
          <div class="form-col-sm">
            <label class="field-label">Decimals</label>
            <input type="number" :value="listing.decimals" @input="updateListing('decimals', $event.target.value)" placeholder="9" class="premium-input" />
          </div>
        </div>
      </div>
    </div>

    <!-- REST fields -->
    <div v-if="listing.type === 'rest'" class="form-section">
      <div class="form-label-row"><span class="form-section-label">Endpoint</span></div>
      <div class="input-group">
        <div>
          <label class="field-label">URL <span class="field-hint-inline">use {address} as placeholder</span></label>
          <input type="text" :value="listing.address" @input="updateListing('address', $event.target.value)" placeholder="https://api.example.com/check?address={address}" class="premium-input font-mono" />
        </div>
        <div class="form-row">
          <div class="form-col-sm">
            <label class="field-label">HTTP Method</label>
            <select :value="listing.httpMethod" @change="updateListing('httpMethod', $event.target.value)" class="premium-select">
              <option value="GET">GET</option>
              <option value="POST">POST</option>
            </select>
          </div>
          <div class="form-col-sm">
            <label class="field-label">Decimals <span class="field-hint-inline">optional</span></label>
            <input type="number" :value="listing.decimals" @input="updateListing('decimals', $event.target.value)" placeholder="18" class="premium-input" />
          </div>
        </div>
        <div v-if="listing.httpMethod === 'POST'">
          <label class="field-label">Request Body <span class="field-hint-inline">JSON template, use {address}</span></label>
          <textarea :value="listing.body" @input="updateListing('body', $event.target.value)" placeholder='{"address": "{address}"}' class="premium-textarea font-mono" rows="3"></textarea>
        </div>
        <div>
          <div class="form-label-row">
            <span class="field-label">Headers</span>
            <button class="utility-link" @click="emit('add-header')">+ Add</button>
          </div>
          <div class="input-group" style="gap:0.4rem">
            <div v-for="(h, i) in headers" :key="i" class="flex-input">
              <input type="text" v-model="h.key" placeholder="Header name" class="premium-input flex-grow" />
              <input type="text" v-model="h.value" placeholder="Value" class="premium-input flex-grow" />
              <button @click="emit('remove-header', i)" class="mini-btn" :disabled="headers.length === 1">×</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Expression — shared -->
    <div class="form-section">
      <div class="form-label-row"><span class="form-section-label">Expression</span></div>
      <div class="input-group">
        <div class="form-row">
          <div class="form-col">
            <label class="field-label">
              Logic
              <span v-if="listing.type === 'rest'" class="field-hint-inline">variables: data, status, decimals</span>
              <span v-else class="field-hint-inline">variables: result (array), decimals</span>
            </label>
            <textarea :value="listing.expression" @input="updateListing('expression', $event.target.value)" placeholder="result[0] > 0n" class="premium-textarea font-mono" rows="3"></textarea>
          </div>
          <div class="form-col-sm">
            <label class="field-label">Language</label>
            <select :value="listing.lang" @change="updateListing('lang', $event.target.value)" class="premium-select">
              <option value="js">JavaScript</option>
              <option value="python">Python</option>
              <option value="rust">Rust</option>
              <option value="go">Go</option>
              <option value="php">PHP</option>
              <option value="java">Java</option>
            </select>
          </div>
        </div>
      </div>
    </div>

    <!-- Preview — shared -->
    <div class="form-section">
      <div class="form-label-row">
        <span class="form-section-label">Preview</span>
        <span class="field-hint-inline">Test this method before submitting</span>
      </div>
      <div class="input-group">
        <div class="flex-input">
          <input
            type="text"
            v-model="previewAddr"
            placeholder="Enter an address to test against"
            class="premium-input flex-grow"
            @keydown.enter="runPreview"
          />
          <button
            @click="runPreview"
            :disabled="previewLoading || !previewAddr || !listing.expression"
            class="mini-btn preview-run-btn"
          >{{ previewLoading ? '...' : 'Run' }}</button>
        </div>
        <div v-if="!listing.expression" class="field-hint">Fill in the expression above first</div>
        <div v-if="previewError" class="preview-error">{{ previewError }}</div>
        <div v-if="previewResult" class="preview-result">
          <div class="preview-verdict" :class="previewResult.expressionResult ? 'verdict-pass' : 'verdict-fail'">
            <span class="verdict-icon">{{ previewResult.expressionResult ? '✓' : '✗' }}</span>
            Expression returned <code class="verdict-value">{{ String(previewResult.expressionResult) }}</code>
          </div>
          <div class="preview-raw">
            <span class="preview-raw-label">Raw response</span>
            <pre class="preview-raw-data">{{ JSON.stringify(previewResult.rawResult, null, 2) }}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- Description + submit — shared -->
    <div class="form-section">
      <div class="form-label-row"><span class="form-section-label">Description</span></div>
      <div class="input-group">
        <textarea :value="listing.description" @input="updateListing('description', $event.target.value)" placeholder="What does this method detect? What constitutes human evidence?" class="premium-textarea" rows="2" @input.native="emit('auto-expand', $event)"></textarea>
        <div class="listing-fee-row">
          <span class="listing-fee-label">Listing fee: <strong>1000 POH</strong></span>
          <span class="listing-fee-balance" :class="{ insufficient: pohBalance < 1000 }">
            Balance: {{ pohBalance.toFixed(2) }} POH
          </span>
        </div>
        <button @click="emit('submit-listing')" :disabled="loading || !listing.description || pohBalance < 1000" class="submit-listing-btn">
          {{ loading ? 'Confirming on-chain...' : 'Submit Method — 1000 POH' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.preview-run-btn {
  white-space: nowrap;
  min-width: 52px;
}

.preview-error {
  font-size: 0.82rem;
  color: #e05c5c;
  padding: 0.4rem 0;
}

.preview-result {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-top: 0.25rem;
}

.preview-verdict {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  padding: 0.5rem 0.75rem;
  border-radius: 6px;
  border: 1px solid;
}

.verdict-pass {
  color: #4ade80;
  border-color: #1a3a22;
  background: #0a1f11;
}

.verdict-fail {
  color: #e05c5c;
  border-color: #3a1a1a;
  background: #1f0a0a;
}

.verdict-icon {
  font-size: 1rem;
  font-weight: 700;
}

.verdict-value {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.82rem;
  background: rgba(255,255,255,0.06);
  padding: 0.1rem 0.3rem;
  border-radius: 3px;
}

.preview-raw {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.preview-raw-label {
  font-size: 0.75rem;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.preview-raw-data {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.78rem;
  color: #888;
  background: #080808;
  border: 1px solid #1a1a1a;
  border-radius: 6px;
  padding: 0.75rem 1rem;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}
</style>
