<script setup>
import { ref } from 'vue'
import { FileUp, Trash2 } from 'lucide-vue-next'

const showEvidencePass = ref(true)
const showEvidenceFail = ref(false)

const props = defineProps({
  scanInput:            { type: String,  default: '' },
  resolvedInputDisplay: { type: String,  default: '' },
  checkerResults:       { type: Array,   default: null },
  showEvidence:         { type: Boolean, default: false },
  brainVerdict:         { type: Object,  default: null },
  brainPolling:         { type: Boolean, default: false },
  batchFile:            { type: Object,  default: null },
  batchRowCount:        { type: Number,  default: 0 },
  detectedChain:        { type: String,  default: null },
  isResolving:          { type: Boolean, default: false },
  loading:              { type: Boolean, default: false },
  faucetLoading:        { type: Boolean, default: false },
  faucetMsg:            { type: Object,  default: null },
})

const emit = defineEmits([
  'update:scanInput',
  'update:showEvidence',
  'update:batchFile',
  'run-check',
  'handle-file-select',
  'claim-faucet',
])
</script>

<template>
  <div class="scan-page">
    <div class="scan-hero">
      <div class="scan-tag">WALLET SCANNER</div>
      <h2 class="scan-title">Verify any wallet</h2>
      <p class="scan-sub">Run all registered detection methods simultaneously and get an AI verdict.</p>
    </div>

    <!-- Devnet faucet -->
    <div class="scan-box">
      <div>Devnet only · not real tokens · for testing purposes</div>
      <br>
      <a href="https://faucet.solana.com/" target="_blank" style="color: #fff;">Claim Devnet SOL here</a>
      <div style="margin-top: 0.5rem;">
        <span style="margin-top: 0.5rem;" v-if="faucetMsg" :class="['faucet-msg', faucetMsg.ok ? 'faucet-msg--ok' : 'faucet-msg--err']">
          {{ faucetMsg.text }}
        </span>
        <button style="margin-top: 0.5rem;" class="submit-listing-btn" :disabled="faucetLoading" @click="emit('claim-faucet')">
          {{ faucetLoading ? 'Sending…' : 'Claim 10 000 POH' }}
        </button>
      </div>
    </div>

    <div class="scan-box">
      <div class="scan-input-row">
        <input
          type="text"
          :value="scanInput"
          @input="emit('update:scanInput', $event.target.value)"
          :disabled="!!batchFile"
          placeholder="0x... or wallet.sol or wallet.eth"
          class="scan-input"
          @keydown.enter="emit('run-check')"
        />
        <label class="scan-upload" title="Upload CSV batch">
          <input type="file" @change="emit('handle-file-select', $event)" accept=".csv" class="hidden-input" />
          <FileUp :size="16" />
        </label>
      </div>
      <div v-if="detectedChain" class="chain-pill-row">
        <span :class="['chain-pill', `chain-pill--${detectedChain}`]">
          {{ detectedChain === 'evm' ? 'EVM — running EVM + REST methods' : 'Solana — running Solana + REST methods' }}
        </span>
      </div>
      <div v-if="resolvedInputDisplay" class="resolved-display">
        ↳ <span class="resolved-address">{{ resolvedInputDisplay }}</span>
      </div>
      <div v-if="batchFile" class="file-info">
        <span class="file-name">{{ batchFile.name }} — {{ batchRowCount }} addresses</span>
        <button @click="emit('update:batchFile', null)" class="mini-btn"><Trash2 :size="12" /></button>
      </div>
      <button @click="emit('run-check')" :disabled="loading || (!scanInput && !batchFile)" class="submit-listing-btn">
        {{ isResolving ? 'Resolving...' : loading ? 'Scanning...' : batchFile ? 'Scan Batch' : 'Scan Wallet' }}
      </button>
    </div>

    <div v-if="checkerResults" class="results-accordion">
      <div class="evidence-header">
        <div class="accordion-dots">
          <span v-for="r in checkerResults.slice(0, 12)" :key="r.methodId"
            :class="['acc-dot', r.result ? 'pass' : 'fail']"></span>
        </div>
        <span class="evidence-title">Evidence</span>
        <span class="accordion-summary">{{ checkerResults.filter(r => r.result).length }}/{{ checkerResults.length }} passed</span>
      </div>

      <!-- Pass accordion -->
      <button class="results-accordion-header sub" @click="showEvidencePass = !showEvidencePass">
        <div class="accordion-left">
          <div class="result-dot pass"></div>
          <span class="accordion-summary">Pass ({{ checkerResults.filter(r => r.result).length }})</span>
        </div>
        <span class="accordion-chevron" :class="{ open: showEvidencePass }">›</span>
      </button>
      <div v-show="showEvidencePass" class="results-list">
        <div v-for="res in checkerResults.filter(r => r.result)" :key="res.methodId" class="result-row">
          <div class="result-dot pass"></div>
          <span class="result-desc">{{ res.description }}</span>
          <span class="status-badge human">PASS</span>
        </div>
        <div v-if="!checkerResults.filter(r => r.result).length" class="result-row result-empty">No signals passed</div>
      </div>

      <!-- Fail accordion -->
      <button class="results-accordion-header sub" @click="showEvidenceFail = !showEvidenceFail">
        <div class="accordion-left">
          <div class="result-dot fail"></div>
          <span class="accordion-summary">Fail ({{ checkerResults.filter(r => !r.result).length }})</span>
        </div>
        <span class="accordion-chevron" :class="{ open: showEvidenceFail }">›</span>
      </button>
      <div v-show="showEvidenceFail" class="results-list">
        <div v-for="res in checkerResults.filter(r => !r.result)" :key="res.methodId" class="result-row">
          <div class="result-dot fail"></div>
          <span class="result-desc">{{ res.description }}</span>
          <span class="status-badge ai">FAIL</span>
        </div>
        <div v-if="!checkerResults.filter(r => !r.result).length" class="result-row result-empty">No signals failed</div>
      </div>
    </div>

    <div v-if="brainPolling && !brainVerdict" class="brain-card brain-pending">
      <span class="brain-label">AI Analysis</span>
      <span class="brain-analyzing">processing evidence...</span>
    </div>

    <div v-if="brainVerdict && brainVerdict.status !== 'not_found'" class="brain-card" :class="brainVerdict.verdict === 'HUMAN' ? 'brain-human' : 'brain-bot'">
      <div class="brain-row">
        <span class="brain-label">AI Verdict</span>
        <span :class="['status-badge', brainVerdict.verdict === 'HUMAN' ? 'human' : 'ai']">
          {{ brainVerdict.verdict === 'HUMAN' ? 'VERIFIED HUMAN' : 'SUSPECTED BOT' }}
        </span>
      </div>
      <p class="brain-reasoning">{{ brainVerdict.reasoning }}</p>
      <div class="brain-conf">Confidence: {{ Math.round((brainVerdict.confidence || 0) * 100) }}%</div>
    </div>
  </div>
</template>
