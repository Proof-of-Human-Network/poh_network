<script setup>
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import axios from 'axios'
import BrainGraph from './BrainGraph.vue'
import ScannerSection from './ScannerSection.vue'
import ListingSection from './ListingSection.vue'
import VoteQueueSection from './VoteQueueSection.vue'
import ProfileSection from './ProfileSection.vue'
import ApiDocsSection from './ApiDocsSection.vue'
import {
  Search, PlusSquare, Vote,
  Activity, SquareArrowDown, PersonStanding, FolderCode, CreditCard, Bitcoin
} from 'lucide-vue-next'
import {
  Transaction,
} from '@solana/web3.js'
import { useWalletConnect } from '../composables/useWalletConnect.js'
import { useConfig } from '../composables/useConfig.js'
import { useChecker } from '../composables/useChecker.js'
import { useVoting } from '../composables/useVoting.js'
import { useListing } from '../composables/useListing.js'
import { useProfile } from '../composables/useProfile.js'
import {
  getPohBalance, getStakeInfo, getGlobalState,
  stakeTokens, unstakeTokens,
  castVote as castVoteOnChain, claimStakerRewards,
} from '../pohProgram.js'

// ── UI State ──────────────────────────────────────────────────────────────────
const currentSection = ref('landing')
const mobileMenuOpen = ref(false)
const loading = ref(false)
const error = ref(null)
const showSection = (id) => { currentSection.value = id; mobileMenuOpen.value = false }

// ── Config ────────────────────────────────────────────────────────────────────
const { POH_MINT, FEE_RECIPIENT, SOLANA_RPC, STAKING_CONTRACT, fetchConfig } = useConfig()

// ── Wallet ────────────────────────────────────────────────────────────────────
const {
  publicKey,
  connected,
  connecting,
  wallets,
  adapterSignMessage,
  walletAddress,
  walletProvider,
  showWalletModal,
  shortAddress,
  connectWallet,
  disconnectWallet,
  signAndSendTransaction,
} = useWalletConnect({
  SOLANA_RPC,
  onConnect: () => {
    loadProfile()
    if (POH_MINT.value) loadPohBalance()
    if (currentSection.value === 'votes') loadVoting()
  },
})

// ── Checker ───────────────────────────────────────────────────────────────────
const checker = useChecker({ walletAddress, connected, POH_MINT, FEE_RECIPIENT, SOLANA_RPC, signAndSendTransaction })
const {
  scanInput, resolvedInputDisplay, checkerResults, showEvidence,
  brainVerdict, brainPolling, batchFile, batchRowCount, batchRows,
  isResolving, detectedChain, faucetLoading, faucetMsg,
  runCheck, handleFileSelect, claimFaucet,
} = checker

const showEvidencePass = ref(true)
const showEvidenceFail = ref(false)

// Proxy error from checker to top-level error ref
watch(checker.error, val => { if (val) error.value = val })

// ── Voting ────────────────────────────────────────────────────────────────────
const voting = useVoting({ walletAddress, connected, adapterSignMessage })
const {
  votingList, voteIndex, voteSubmitting, voteFeedback,
  voteConfirmPending, feedbackValidating, currentVoteItem, myVotesData,
  loadVoting, castVote, confirmVote, loadMyVotes, fetchMethodsForGraph,
} = voting

watch(voting.error, val => { if (val) error.value = val })

// ── Network visualization ─────────────────────────────────────────────────────
const NET_CX = 400, NET_CY = 210

function netShortLabel(desc = '') {
  const segment = desc.split(' — ')[0].split(' – ')[0].split(' (')[0].trim()
  const words = segment.split(' ').slice(0, 2).join(' ')
  return words.length > 13 ? words.slice(0, 12) + '…' : words
}

function netDuration(id) {
  const h = String(id).split('').reduce((a, c) => a + c.charCodeAt(0), 0)
  return (1.4 + (h % 8) * 0.2).toFixed(1) + 's'
}

const netNodes = computed(() => {
  const all  = votingList.value
  const evm  = all.filter(m => m.type === 'evm').slice(0, 6)
  const rest = all.filter(m => m.type === 'rest').slice(0, 5)
  const sol  = all.filter(m => m.type === 'solana').slice(0, 4)

  if (!all.length) return [
    { id:'s0', type:'evm',    label:'ETH Balance',  x:192, y:100 },
    { id:'s1', type:'evm',    label:'TX Count',     x:148, y:210 },
    { id:'s2', type:'evm',    label:'USDC Hold',    x:192, y:320 },
    { id:'s3', type:'rest',   label:'ENS',          x:295, y: 48 },
    { id:'s4', type:'rest',   label:'Farcaster',    x:400, y: 34 },
    { id:'s5', type:'rest',   label:'Gitcoin',      x:505, y: 48 },
    { id:'s6', type:'solana', label:'SOL Balance',  x:608, y:100 },
    { id:'s7', type:'solana', label:'SPL Token',    x:652, y:210 },
    { id:'s8', type:'solana', label:'TX Count',     x:608, y:320 },
  ]

  const R = 188
  const nodes = []
  const place = (arr, aStart, aSpan) => arr.forEach((m, i) => {
    const a = (aStart + (arr.length > 1 ? i * aSpan / (arr.length - 1) : aSpan / 2)) * Math.PI / 180
    nodes.push({ id: m.id, type: m.type, label: netShortLabel(m.description),
      x: Math.round(NET_CX + R * Math.cos(a)),
      y: Math.round(NET_CY + R * Math.sin(a)) })
  })
  place(evm,  140, 80)
  place(rest, 245, 50)
  place(sol,  320, 80)
  return nodes
})

const netActiveId   = ref(null)
const netBrainPulse = ref(false)
let _netTimer = null

function startNetAnim() {
  _netTimer = setInterval(() => {
    const nodes = netNodes.value
    if (!nodes.length) return
    netActiveId.value = nodes[Math.floor(Math.random() * nodes.length)].id
    setTimeout(() => { netBrainPulse.value = true  }, 680)
    setTimeout(() => { netBrainPulse.value = false; netActiveId.value = null }, 1100)
  }, 1700)
}

// ── Staking ───────────────────────────────────────────────────────────────────
const stakeAmount    = ref('')
const unstakeAmount  = ref('')
const stakeLoading   = ref(false)
const unstakeLoading = ref(false)
const stakeMessage   = ref(null)
const pohBalance     = ref(0)
const stakedBalance  = ref(0)
const claimable      = ref(0)
const totalStaked    = ref(0)
const claimLoading   = ref(false)

async function loadPohBalance() {
  if (!walletAddress.value || !POH_MINT.value) return
  pohBalance.value = await getPohBalance(walletAddress.value, POH_MINT.value, SOLANA_RPC.value)
  const info = await getStakeInfo(walletAddress.value, SOLANA_RPC.value)
  stakedBalance.value = info.staked
  claimable.value     = info.pendingRewards
  const global = await getGlobalState(SOLANA_RPC.value)
  if (global) totalStaked.value = global.totalStaked
}

async function submitStake() {
  if (!connected.value) { error.value = 'Connect wallet to stake'; return }
  const amount = parseFloat(stakeAmount.value)
  if (!amount || amount <= 0) { stakeMessage.value = 'Enter a valid POH amount'; return }
  if (amount > pohBalance.value) { stakeMessage.value = 'Insufficient POH balance'; return }
  stakeLoading.value = true
  stakeMessage.value = null
  try {
    const txHash = await stakeTokens(
      walletProvider.value, walletAddress.value, POH_MINT.value, SOLANA_RPC.value, amount
    )
    stakeMessage.value = `Staked ${amount} POH ✓`
    stakeAmount.value = ''
    await loadPohBalance()
  } catch (err) {
    stakeMessage.value = err.message || 'Stake failed'
  } finally {
    stakeLoading.value = false
  }
}

async function submitUnstake() {
  if (!connected.value) { error.value = 'Connect wallet to unstake'; return }
  const amount = parseFloat(unstakeAmount.value)
  if (!amount || amount <= 0) { stakeMessage.value = 'Enter a valid POH amount'; return }
  if (amount > stakedBalance.value) { stakeMessage.value = 'Insufficient staked balance'; return }
  unstakeLoading.value = true
  stakeMessage.value = null
  try {
    const txHash = await unstakeTokens(
      walletProvider.value, walletAddress.value, POH_MINT.value, SOLANA_RPC.value, amount
    )
    stakeMessage.value = `Unstaked ${amount} POH ✓`
    unstakeAmount.value = ''
    await loadPohBalance()
  } catch (err) {
    stakeMessage.value = err.message || 'Unstake failed'
  } finally {
    unstakeLoading.value = false
  }
}

async function claimRewards() {
  if (!connected.value) { error.value = 'Connect wallet to claim'; return }
  claimLoading.value = true
  stakeMessage.value = null
  try {
    await claimStakerRewards(
      walletProvider.value, walletAddress.value, POH_MINT.value, SOLANA_RPC.value
    )
    stakeMessage.value = `Claimed ${claimable.value.toFixed(4)} POH ✓`
    await loadPohBalance()
  } catch (err) {
    stakeMessage.value = err.message || 'Claim failed'
  } finally {
    claimLoading.value = false
  }
}

// ── Profile ───────────────────────────────────────────────────────────────────
const profile = useProfile({
  walletAddress, connected, adapterSignMessage,
  POH_MINT, FEE_RECIPIENT, SOLANA_RPC, signAndSendTransaction,
  loadPohBalance,
})
const {
  profileData, profileLoading, profileError, signupLoading,
  showDepositModal, depositAmount, depositLoading, depositMsg,
  offchainClaimLoading,
  loadProfile, signupProfile, rotateApiKey, submitDeposit, claimOffchainBalance,
} = profile

// stakeMessage from profile composable merged with local stakeMessage
watch(profile.stakeMessage, val => { if (val) stakeMessage.value = val })

// ── Listing ───────────────────────────────────────────────────────────────────
const listingComposable = useListing({
  walletAddress, walletProvider, connected, POH_MINT, SOLANA_RPC,
  pohBalance, loadPohBalance,
})
const {
  listing, headers, abiFns, abiLoading, abiError,
  LISTING_FEE_POH,
  addHeader, removeHeader, fetchAbi, pickMethod, submitListing,
} = listingComposable

watch(listingComposable.error, val => { if (val) error.value = val })

// ── Helpers ───────────────────────────────────────────────────────────────────
function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {})
}

function goTo(url) {
  window.open(url, '_blank')
}

function autoExpand(e) {
  const el = e.target
  el.style.height = 'auto'
  el.style.height = el.scrollHeight + 'px'
}

// ── Watchers ──────────────────────────────────────────────────────────────────
watch(walletAddress, (addr) => {
  if (addr && POH_MINT.value) loadPohBalance()
  if (addr) loadProfile()
})

onMounted(async () => {
  await fetchConfig()
  if (currentSection.value === 'votes') loadVoting()
  if (connected.value) loadPohBalance()
  fetchMethodsForGraph()
  startNetAnim()
})

onUnmounted(() => {
  if (_netTimer) clearInterval(_netTimer)
})
</script>

<template>
  <div class="app-container">
    <!-- Devnet banner -->
    <div class="devnet-bar">
      <span class="devnet-label">DEVNET</span>
      <span class="devnet-sep">·</span>
      <span class="devnet-hint">Test environment — tokens have no real value</span>
      <div class="devnet-bar-right">
        <span v-if="faucetMsg" :class="['devnet-faucet-msg', faucetMsg.ok ? 'devnet-faucet-msg--ok' : 'devnet-faucet-msg--err']">
          {{ faucetMsg.text }}
        </span>
        <button
          class="devnet-faucet-btn"
          :disabled="faucetLoading || !connected"
          @click="claimFaucet"
          :title="connected ? 'Claim 10 000 test POH tokens' : 'Connect wallet first'"
        >{{ faucetLoading ? 'Sending…' : 'Claim 10K POH' }}</button>
      </div>
    </div>

    <header class="header">
      <div @click="showSection('landing')" class="logo">
        <img src="/poh-icon.png" alt="POH Logo">
      </div>

      <!-- Desktop nav -->
      <nav class="nav desktop-nav">
        <button :class="['nav-btn', { active: currentSection === 'checker' }]" @click="showSection('checker')">
          <Search class="icon" :size="14" /> Scan
        </button>
        <button :class="['nav-btn', { active: currentSection === 'listing' }]" @click="showSection('listing')">
          <PlusSquare class="icon" :size="14" /> Train
        </button>
        <button :class="['nav-btn', { active: currentSection === 'votes' }]" @click="showSection('votes'); loadVoting()">
          <Vote class="icon" :size="14" /> Vote
        </button>
        <button :class="['nav-btn', { active: currentSection === 'staking' }]" @click="showSection('staking')">
          <SquareArrowDown class="icon" :size="14" /> Stake
        </button>
        <button :class="['nav-btn', { active: currentSection === 'profile' }]" @click="showSection('profile'); loadProfile(); loadMyVotes()">
          <PersonStanding class="icon" :size="14" /> Profile
        </button>
        <button :class="['nav-btn', { active: currentSection === 'api' }]" @click="showSection('api')">
          <FolderCode class="icon" :size="14" /> API
        </button>
      </nav>

      <div class="header-right">
        <!-- Desktop wallet -->
        <div class="wallet-wrapper desktop-wallet">
          <button v-if="!connected" @click="showWalletModal = true" class="select-wallet-btn">
            Connect Wallet
          </button>
          <div v-else class="connected-status">
            <div class="status-indicator"></div>
            <span class="address-text">{{ shortAddress }}</span>
            <button @click="disconnectWallet" class="disconnect-link">Disconnect</button>
          </div>
        </div>

        <!-- Hamburger -->
        <button class="hamburger" @click="mobileMenuOpen = !mobileMenuOpen" :class="{ open: mobileMenuOpen }">
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>

    <!-- Mobile menu -->
    <div class="mobile-menu" :class="{ open: mobileMenuOpen }" @click.self="mobileMenuOpen = false">
      <div class="mobile-menu-inner">
        <button :class="['mobile-nav-btn', { active: currentSection === 'landing' }]" @click="showSection('landing')">POH</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'checker' }]" @click="showSection('checker')">Scan</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'listing' }]" @click="showSection('listing')">Train</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'votes' }]" @click="showSection('votes'); loadVoting()">Vote</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'api' }]" @click="showSection('api')">API</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'staking' }]" @click="showSection('staking')">Stake</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'profile' }]" @click="showSection('profile'); loadProfile(); loadMyVotes()">Profile</button>
        <div class="mobile-menu-divider"></div>
        <button v-if="!connected" @click="showWalletModal = true; mobileMenuOpen = false" class="mobile-nav-btn mobile-connect">
          Connect Wallet
        </button>
        <div v-else class="mobile-wallet-status">
          <div class="status-indicator"></div>
          <span class="address-text">{{ shortAddress }}</span>
          <button @click="disconnectWallet; mobileMenuOpen = false" class="disconnect-link">Disconnect</button>
        </div>
      </div>
    </div>

    <!-- Vote Confirmation Modal -->
    <div v-if="voteConfirmPending !== null" class="modal-overlay" @click.self="voteConfirmPending = null">
      <div class="glass-panel modal vote-confirm-modal">
        <h3 class="modal-title">Confirm your vote</h3>
        <p class="modal-desc">
          You're voting
          <strong :class="voteConfirmPending === true ? 'vote-confirm-human' : 'vote-confirm-bot'">
            {{ voteConfirmPending === true ? '✓ Human' : '✗ Bot / AI' }}
          </strong>
          on <em>{{ currentVoteItem?.description }}</em>.
        </p>
        <p class="modal-desc vote-confirm-warn">This cannot be changed after submission.</p>
        <div v-if="voteFeedback.trim()" class="vote-confirm-comment">
          <span class="vote-confirm-comment-label">Your comment</span>
          <span class="vote-confirm-comment-text">{{ voteFeedback.trim() }}</span>
        </div>
        <div class="modal-actions">
          <button class="vcs-btn vcs-btn-yes" :disabled="voteSubmitting" @click="confirmVote">
            {{ voteSubmitting ? 'Signing…' : 'Confirm & Sign' }}
          </button>
          <button class="modal-close" @click="voteConfirmPending = null">Cancel</button>
        </div>
      </div>
    </div>

    <!-- Wallet Selection Modal -->
    <div v-if="showWalletModal" class="modal-overlay" @click.self="showWalletModal = false">
      <div class="glass-panel modal wallet-select-modal">
        <h3 class="modal-title">Connect Wallet</h3>
        <div class="wallet-list">
          <button
            v-for="w in wallets"
            :key="w.name"
            class="wallet-option"
            :class="{ 'wallet-option--detected': w.readyState === 'Installed' }"
            @click="connectWallet(w.name, w.url)"
          >
            <img :src="w.icon" :alt="w.name" class="wallet-icon" />
            <span class="wallet-name">{{ w.name }}</span>
            <span v-if="w.readyState === 'Installed'" class="wallet-badge wallet-badge--detected">Detected</span>
            <span v-else class="wallet-badge wallet-badge--install">Install</span>
          </button>
        </div>
        <button class="modal-close" @click="showWalletModal = false">Cancel</button>
      </div>
    </div>

    <!-- Deposit POH Modal -->
    <div v-if="showDepositModal" class="modal-overlay" @click.self="showDepositModal = false">
      <div class="glass-panel modal">
        <h3 class="modal-title">Deposit POH</h3>
        <p class="modal-desc">Send POH to your off-chain API balance. Useful for API calls without wallet interaction.</p>
        <div class="flex-input" style="margin:1rem 0">
          <input type="number" v-model="depositAmount" placeholder="Amount in POH" class="premium-input flex-grow" min="1" step="1" />
        </div>
        <div v-if="depositMsg" :class="['deposit-msg', depositMsg.includes('✓') ? 'deposit-ok' : 'deposit-err']">{{ depositMsg }}</div>
        <button class="submit-listing-btn" :disabled="depositLoading || !depositAmount" @click="submitDeposit()">
          {{ depositLoading ? 'Sending...' : 'Send POH' }}
        </button>
        <button class="modal-close" @click="showDepositModal = false; depositMsg = null">Cancel</button>
      </div>
    </div>

    <main class="main">
      <div v-if="error" class="error-msg" @click="error = null">{{ error }}</div>

      <!-- Landing -->
      <div v-if="currentSection === 'landing'" class="landing">

        <!-- Problem screen -->
        <section class="problem-screen">
          <div class="problem-inner">
            <div class="problem-tag">THE PROBLEM</div>
            <h2 class="problem-title">Soon, there will be more AI-agents, than <span class="problem-accent">people</span></h2>
            <blockquote class="problem-quote">
              "The company already has a lot more cybersecurity AI agents than people working on cybersecurity."
              <cite>— Jensen Huang, CEO of NVIDIA</cite>
            </blockquote>
            <p class="problem-desc">Wallets, votes, and on-chain identities can no longer be trusted at face value. <br>POH verifies humanity through evidence — not promises.</p>
            <button class="neon-btn" @click="showSection('checker')">Scan a Wallet →</button>
          </div>
        </section>

        <!-- <section class="landing-hero">
          <div class="landing-tag">PROOF OF HUMAN</div>
          <h1 class="landing-title">Decentralized<br>Human Verification</h1>
          <div class="landing-cta-row">
            <button class="neon-btn landing-cta" @click="showSection('checker')">Start Scanning →</button>
            <button class="outline-btn landing-cta" @click="showSection('api')">View API Docs</button>
          </div>
        </section> -->

        <!-- How it works -->
        <!-- <section class="how-section">
          <div class="network-label">HOW IT WORKS</div>
          <div class="how-grid">
            <div class="how-col">
              <div class="how-step-title">Detection</div>
              <ul class="how-list">
                <li>Community submits methods — EVM contract calls, Solana programs, or REST APIs</li>
                <li>Each method runs a sandboxed expression against live on-chain data</li>
                <li>Methods are independently scored and weighted by community consensus</li>
                <li>All methods execute in parallel per scan</li>
              </ul>
            </div>
            <div class="how-col">
              <div class="how-step-title">AI Brain</div>
              <ul class="how-list">
                <li>Multi-role Ollama pipeline — Evaluator, Learner, Compiler on separate models</li>
                <li>Evaluator scores signals weighted by community stake, runs a second verification pass, learns from voter natural-language feedback</li>
                <li>Learner updates weights after every community vote (±0.05 max drift)</li>
                <li>Compiler rewrites a compact brain state hourly — no hallucination, stats only</li>
              </ul>
            </div>
          </div>
        </section> -->

        <!-- POH TOKEN -->
        <!-- <div class="network-label">$POH TOKEN</div>

        <section class="landing-token">
          <p class="token-desc">Fair launch via bonding curve. No VC rounds. No pre-mine. Every scan flows 50% back to method contributors. Stake to govern signal quality.</p>

          <div class="token-split">
            <div class="split-row">
              <span class="split-label">Community Reward Pool</span>
              <span class="split-pct">80%</span>
            </div>
            <div class="split-bar"><div class="split-fill" style="width:80%"></div></div>
            <div class="split-note">Method owner rewards, staking APY, bonding curve</div>

            <div class="split-row" style="margin-top:1.25rem">
              <span class="split-label">Team &amp; Contributors</span>
              <span class="split-pct">20%</span>
            </div>
            <div class="split-bar"><div class="split-fill" style="width:20%; background:#555"></div></div>
            <div class="split-note">1 month cliff · 6 month linear vesting</div>
          </div>

          <div class="token-economics">
            <div class="econ-row">
              <span class="econ-label">Per scan cost</span>
              <span class="econ-val">1 POH (bulk discounts up to 60%)</span>
            </div>
            <div class="econ-row">
              <span class="econ-label">Method owner share</span>
              <span class="econ-val">50% of each paid scan, weighted by stake</span>
            </div>
            <div class="econ-row">
              <span class="econ-label">Free tier</span>
              <span class="econ-val">100 scans per wallet, no token required</span>
            </div>
            <div class="econ-row">
              <span class="econ-label">Stake utility</span>
              <span class="econ-val">Amplifies vote weight in method scoring consensus</span>
            </div>
          </div>

          <div class="token-features">
            <div class="token-feat">Bonding Curve Fair Launch</div>
            <div class="token-feat">Scan Fee → Method Rewards</div>
            <div class="token-feat">Stake-Weighted Voting</div>
            <div class="token-feat">100 Free Scans / Wallet</div>
          </div>

          <div class="landing-cta-row">
            <button class="outline-btn landing-cta" @click="goTo('https://cyreneai.com/projects/poh')">
              <Bitcoin class="icon" :size="24" /> Trade $POH
            </button>
            <button
             class="neon-btn landing-cta"
             style="font-size: 1.0625rem;" 
             @click="goTo('https://exchange.assetux.com/?fromChain=SOL&toChain=SOL&fromToken=SOL&toToken=POH&amount=1')"
             >
              <CreditCard class="icon" :size="24" /> Buy $POH
            </button>
          </div>
        </section> -->

        <!-- ── Features (full-screen panels) ──────────────────────────────────────── -->
        <section class="feat-screen">
          <div class="feat-left">
            <div class="feat-tag">SCAN</div>
            <h2 class="feat-title">Verify any wallet<br>in seconds</h2>
            <p class="feat-body">Paste an EVM address, Solana address, or ENS name. AI returns verdict instantly.</p>
            <button class="feat-cta" @click="showSection('checker')">Try the Scanner →</button>
          </div>
          <div class="feat-right">
            <svg class="feat-svg" viewBox="0 0 420 320" fill="none" xmlns="http://www.w3.org/2000/svg">
              <!-- Card background -->
              <rect x="10" y="10" width="400" height="300" rx="14" fill="#090909" stroke="#1a1a1a"/>
              <!-- Input bar -->
              <rect x="28" y="30" width="310" height="36" rx="7" fill="#111" stroke="#222"/>
              <text x="42" y="53" fill="#555" font-size="11" font-family="monospace">0xd8dA6BF26964aF9D7eEd9e03E534...</text>
              <rect x="346" y="30" width="52" height="36" rx="7" fill="#161616" stroke="#222"/>
              <text x="355" y="53" fill="#666" font-size="11" font-family="monospace">Scan</text>
              <!-- Divider -->
              <line x1="28" y1="80" x2="392" y2="80" stroke="#161616"/>
              <!-- Method rows — animated in sequence -->
              <g class="scan-row-1">
                <rect x="28" y="90" width="364" height="28" rx="5" fill="#0d0d0d"/>
                <circle cx="42" cy="104" r="4" fill="#22c55e"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.4s" fill="freeze"/></circle>
                <text x="54" y="108" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.4s" fill="freeze"/>SOL balance &gt; 0.01</text>
                <text x="346" y="108" fill="#22c55e" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.4s" fill="freeze"/>✓</text>
              </g>
              <g class="scan-row-2">
                <rect x="28" y="122" width="364" height="28" rx="5" fill="#0d0d0d"/>
                <circle cx="42" cy="136" r="4" fill="#22c55e"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.75s" fill="freeze"/></circle>
                <text x="54" y="140" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.75s" fill="freeze"/>ENS name registered</text>
                <text x="346" y="140" fill="#22c55e" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.75s" fill="freeze"/>✓</text>
              </g>
              <g>
                <rect x="28" y="154" width="364" height="28" rx="5" fill="#0d0d0d"/>
                <circle cx="42" cy="168" r="4" fill="#ef4444"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.05s" fill="freeze"/></circle>
                <text x="54" y="172" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.05s" fill="freeze"/>Farcaster profile</text>
                <text x="340" y="172" fill="#ef4444" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.05s" fill="freeze"/>✗</text>
              </g>
              <g>
                <rect x="28" y="186" width="364" height="28" rx="5" fill="#0d0d0d"/>
                <circle cx="42" cy="200" r="4" fill="#22c55e"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.35s" fill="freeze"/></circle>
                <text x="54" y="204" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.35s" fill="freeze"/>Galxe identity</text>
                <text x="346" y="204" fill="#22c55e" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.35s" fill="freeze"/>✓</text>
              </g>
              <g>
                <rect x="28" y="218" width="364" height="28" rx="5" fill="#0d0d0d"/>
                <circle cx="42" cy="232" r="4" fill="#22c55e"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.6s" fill="freeze"/></circle>
                <text x="54" y="236" fill="#555" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.6s" fill="freeze"/>Artrade tokenised real-world art marketplace...</text>
                <text x="346" y="236" fill="#22c55e" font-size="10" font-family="monospace"><animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.6s" fill="freeze"/>✓</text>
              </g>
              <!-- Verdict badge -->
              <rect x="28" y="260" width="364" height="38" rx="8" fill="#0f1f0f" stroke="#1a4a1a">
                <animate attributeName="opacity" values="0;1" dur="0.4s" begin="2s" fill="freeze"/>
                <animate attributeName="stroke" values="#111;#22c55e;#1a4a1a" dur="0.6s" begin="2s" fill="freeze"/>
              </rect>
              <text x="115" y="284" fill="#22c55e" font-size="13" font-weight="600" font-family="monospace">
                <animate attributeName="opacity" values="0;1" dur="0.3s" begin="2.1s" fill="freeze"/>
                HUMAN · 87% confidence
              </text>
            </svg>
          </div>
        </section>

        <section class="feat-screen feat-screen--alt">
          <div class="feat-right display-block">
            
            <div>
              <p class="net-subtitle">
                {{ votingList.length || '—' }} active methods · signals flow to AI brain in real time
              </p>

            </div>

            <BrainGraph :methods="votingList" />

            <div class="net-legend">
              <!-- <div class="net-legend-group">
                <div class="nl-item"><span class="nl-dot nl-dot--evm"></span>EVM</div>
                <div class="nl-item"><span class="nl-dot nl-dot--solana"></span>Solana</div>
                <div class="nl-item"><span class="nl-dot nl-dot--rest"></span>REST</div>
              </div> -->
              <div class="nl-sep"></div>
              <div class="net-legend-group">
                <div class="nl-item"><span class="nl-dot nl-dot--eval"></span>Evaluator · Qvac</div>
                <div class="nl-item"><span class="nl-dot nl-dot--learn"></span>Learner · Qwen 2.5</div>
                <div class="nl-item"><span class="nl-dot nl-dot--comp"></span>Compiler · Llama 3.2</div>
              </div>
            </div>
          </div>
          <div class="feat-left">
            <div class="feat-tag">SIGNALS</div>
            <h2 class="feat-title">Evidence from<br>every layer</h2>
            <p class="feat-body">EVM balances, Solana programs, web3.bio social links, REST identity APIs, real-world asset holdings, social links, Web3 domains, Decentralised IDentities. Every signal runs in parallel. No single point of failure.</p>
            <button class="feat-cta" @click="showSection('votes'); loadVoting()">Browse Methods →</button>
          </div>
        </section>

        <section class="feat-screen feat-screen--alt">
          <div class="feat-right">
            <svg class="feat-svg" viewBox="0 0 420 320" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="10" y="10" width="400" height="300" rx="14" fill="#090909" stroke="#1a1a1a"/>
              <!-- Method card -->
              <rect x="28" y="28" width="364" height="160" rx="9" fill="#0d0d0d" stroke="#1e1e1e"/>
              <text x="44" y="52" fill="#666" font-size="9" font-family="monospace">METHOD #47</text>
              <text x="44" y="70" fill="#ddd" font-size="12" font-family="sans-serif">Artrade tokenised real-world art marketplace on Solana</text>
              <text x="44" y="88" fill="#555" font-size="9" font-family="monospace">balanceOf(address) &gt; 0  ·  Ethereum</text>
              <!-- Score bar -->
              <text x="44" y="112" fill="#555" font-size="8" font-family="monospace">community score</text>
              <rect x="44" y="118" width="220" height="5" rx="2" fill="#111"/>
              <rect x="44" y="118" width="148" height="5" rx="2" fill="#22c55e" id="score-bar"/>
              <text x="274" y="122" fill="#22c55e" font-size="8" font-family="monospace">+6.7</text>
              <!-- Vote buttons -->
              <rect x="44" y="148" width="82" height="30" rx="6" fill="#0a1f0a" stroke="#1a3a1a"/>
              <text x="66" y="168" fill="#22c55e" font-size="11" font-family="monospace">✓ Human</text>
              <rect x="134" y="148" width="74" height="30" rx="6" fill="#111" stroke="#222"/>
              <text x="149" y="168" fill="#ef4444" font-size="11" font-family="monospace">✗ Skip</text>
              <!-- Animated vote + score update -->
              <rect x="44" y="148" width="82" height="30" rx="6" fill="#22c55e" opacity="0">
                <animate attributeName="opacity" values="0;0.18;0" dur="0.6s" begin="1.8s" repeatCount="indefinite" repeatDur="6s"/>
              </rect>
              <rect x="44" y="118" width="0" height="5" rx="2" fill="#22c55e" opacity="0">
                <animate attributeName="opacity" values="0;1;1;0" dur="3s" begin="2.2s" repeatCount="indefinite" repeatDur="6s"/>
                <animate attributeName="width" values="148;164;164;148" dur="3s" begin="2.2s" repeatCount="indefinite" repeatDur="6s"/>
              </rect>
              <!-- Feedback textarea -->
              <rect x="28" y="202" width="364" height="50" rx="7" fill="#080808" stroke="#161616"/>
              <text x="44" y="224" fill="#555" font-size="9" font-family="monospace">Interest in the real world art marketplace...</text>
              <!-- Submit row -->
              <text x="44" y="272" fill="#555" font-size="9" font-family="monospace">342 votes cast  ·  stake weight: 1.4×</text>
              <rect x="330" y="256" width="62" height="26" rx="6" fill="#161616" stroke="#222"/>
              <text x="341" y="273" fill="#888" font-size="9" font-family="monospace">Next →</text>
            </svg>
          </div>
          <div class="feat-left">
            <div class="feat-tag">COMMUNITY</div>
            <h2 class="feat-title">You decide what<br>counts as human</h2>
            <p class="feat-body">Every detection method goes through community consensus. Sign a message with your wallet to vote. Your staked POH amplifies your influence. Leave feedback — the AI Learner reads it and adjusts signal weights.</p>
            <button class="feat-cta" @click="showSection('votes'); loadVoting()">Open Vote Queue →</button>
          </div>
        </section>

        <section class="feat-screen">
          <div class="feat-left">
            <div class="feat-tag">AI BRAIN</div>
            <h2 class="feat-title">On-device AI,<br>zero cloud calls</h2>
            <p class="feat-body">A local LLM reads every signal, weighs community-trained scores, and outputs a structured verdict with confidence and reasoning. <br>Runs on Qvac by Tether.</p>
            <button class="feat-cta" @click="showSection('checker')">See a Verdict →</button>
          </div>
          <div class="feat-right">
            <svg class="feat-svg" viewBox="0 0 420 320" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="10" y="10" width="400" height="230" rx="14" fill="#090909" stroke="#1a1a1a"/>
              <!-- Signals in -->
              <text x="28" y="42" fill="#555" font-size="9" font-family="monospace">SIGNALS</text>
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
              <!-- Arrow to AI -->
              <path d="M168 130 Q210 130 210 130" stroke="#222" stroke-width="1.5" marker-end="url(#arr)"/>
              <defs>
                <marker id="arr" markerWidth="6" markerHeight="6" refX="3" refY="3" orient="auto">
                  <path d="M0,0 L6,3 L0,6 Z" fill="#555"/>
                </marker>
              </defs>
              <!-- AI node -->
              <circle cx="215" cy="130" r="0" fill="#111" stroke="#222">
                <animate attributeName="r" values="0;22" dur="0.4s" begin="0.5s" fill="freeze"/>
              </circle>
              <text x="210" y="126" fill="#fff" font-size="8" font-family="monospace" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.8s" fill="freeze"/>AI
              </text>
              <text x="199" y="138" fill="#555" font-size="7" font-family="monospace" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.3s" begin="0.8s" fill="freeze"/>thinking</text>
              <!-- Thinking dots -->
              <!-- <circle cx="202" cy="148" r="2" fill="#555" opacity="0">
                <animate attributeName="opacity" values="0;0;1;0" dur="1.2s" begin="0.9s" repeatCount="indefinite"/>
              </circle>
              <circle cx="210" cy="148" r="2" fill="#555" opacity="0">
                <animate attributeName="opacity" values="0;0;0;1;0" dur="1.2s" begin="0.9s" repeatCount="indefinite"/>
              </circle>
              <circle cx="218" cy="148" r="2" fill="#555" opacity="0">
                <animate attributeName="opacity" values="0;0;0;0;1;0" dur="1.2s" begin="0.9s" repeatCount="indefinite"/>
              </circle> -->
              <!-- Verdict card -->
              <rect x="250" y="72" width="148" height="120" rx="8" fill="#0f1f0f" stroke="#1a4a1a" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.4s" begin="2.2s" fill="freeze"/>
              </rect>
              <text x="264" y="96" fill="#22c55e" font-size="11" font-weight="600" font-family="monospace" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.3s" begin="2.4s" fill="freeze"/>HUMAN
              </text>
              <text x="264" y="114" fill="#555" font-size="8" font-family="monospace" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.3s" begin="2.5s" fill="freeze"/>confidence</text>
              <!-- Confidence bar -->
              <rect x="264" y="120" width="112" height="6" rx="3" fill="#111" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.1s" begin="2.6s" fill="freeze"/>
              </rect>
              <rect x="264" y="120" width="0" height="6" rx="3" fill="#22c55e" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.1s" begin="2.6s" fill="freeze"/>
                <animate attributeName="width" values="0;87" dur="0.8s" begin="2.6s" fill="freeze"/>
              </rect>
              <text x="264" y="146" fill="#fff" font-size="7.5" font-family="monospace" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.3s" begin="2.7s" fill="freeze"/>87% · 4/5 signals pass</text>
              <text x="264" y="162" fill="#555" font-size="7" font-family="monospace" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.3s" begin="2.8s" fill="freeze"/>PAXG holder is</text>
              <text x="264" y="174" fill="#555" font-size="7" font-family="monospace" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.3s" begin="2.8s" fill="freeze"/>strongest signal.</text>
            </svg>
          </div>
        </section>

        <section class="feat-screen">
          <div class="feat-left">
            <div class="feat-tag">API</div>
            <h2 class="feat-title">One call.<br>Instant answer.</h2>
            <p class="feat-body">Drop-in HTTP API for any app. First 100 scans free.</p>
            <button class="feat-cta" @click="showSection('api')">API Reference →</button>
          </div>
          <div class="feat-right">
            <svg class="feat-svg" viewBox="0 0 420 320" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect x="10" y="10" width="400" height="300" rx="14" fill="#080808" stroke="#1a1a1a"/>
              <!-- Terminal bar -->
              <rect x="10" y="10" width="400" height="28" rx="14" fill="#111" stroke="#1a1a1a"/>
              <rect x="10" y="24" width="400" height="14" fill="#111"/>
              <circle cx="32" cy="24" r="5" fill="#555"/>
              <circle cx="50" cy="24" r="5" fill="#555"/>
              <circle cx="68" cy="24" r="5" fill="#555"/>
              <!-- Request lines -->
              <text x="28" y="60" fill="#555" font-size="9" font-family="monospace">POST /checker</text>
              <text x="28" y="76" fill="#1e3a1e" font-size="9" font-family="monospace">&#123;</text>
              <text x="28" y="90" fill="#555" font-size="9" font-family="monospace">  "input": "0xd8dA6BF26964..."</text>
              <text x="28" y="104" fill="#555" font-size="9" font-family="monospace">  "apiKey": "pk_live_xxx"</text>
              <text x="28" y="118" fill="#1e3a1e" font-size="9" font-family="monospace">&#125;</text>
              <!-- Blinking cursor -->
              <rect x="46" y="108" width="6" height="10" fill="#555">
                <animate attributeName="opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/>
              </rect>
              <!-- Divider -->
              <line x1="28" y1="134" x2="392" y2="134" stroke="#161616"/>
              <!-- Response -->
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
              <!-- Highlight verdict value -->
              <rect x="100" y="174" width="52" height="14" rx="3" fill="#0f2a0f" opacity="0">
                <animate attributeName="opacity" values="0;1" dur="0.3s" begin="1.4s" fill="freeze"/>
              </rect>
            </svg>
          </div>
        </section>

        <!-- Network visualization -->
        <!-- <section class="net-section">
          <div style="margin-top: 10rem;" class="network-label">DETECTION NETWORK</div>
          <p class="net-subtitle">
            {{ votingList.length || '—' }} active methods · signals flow to AI brain in real time
          </p>

          <BrainGraph :methods="votingList" />

          <div class="net-legend">
            <div class="net-legend-group">
              <div class="nl-item"><span class="nl-dot nl-dot--evm"></span>EVM</div>
              <div class="nl-item"><span class="nl-dot nl-dot--solana"></span>Solana</div>
              <div class="nl-item"><span class="nl-dot nl-dot--rest"></span>REST</div>
            </div>
            <div class="nl-sep"></div>
            <div class="net-legend-group">
              <div class="nl-item"><span class="nl-dot nl-dot--eval"></span>Evaluator · Qvac / DeepSeek</div>
              <div class="nl-item"><span class="nl-dot nl-dot--learn"></span>Learner · Qwen 2.5</div>
              <div class="nl-item"><span class="nl-dot nl-dot--comp"></span>Compiler · Mixtral</div>
            </div>
          </div>
        </section> -->

        <!-- Roadmap -->
        <section class="roadmap-section">
          <div class="network-label">ROADMAP</div>
          <div class="roadmap-list">
            <div class="roadmap-item roadmap-active">
              <div class="roadmap-dot"></div>
              <div class="roadmap-content">
                <div class="roadmap-date" style="color: #fff">Apr-May 2026</div>
                <div class="roadmap-desc" style="color: #fff">Devnet public launch</div>
                <div class="roadmap-desc" style="color: #fff">Colosseum Hackathon submission</div>
                <div class="roadmap-desc" style="color: #fff">Data providers onboarding</div>
              </div>
            </div>
            <div class="roadmap-item">
              <div class="roadmap-dot"></div>
              <div class="roadmap-content">
                <div class="roadmap-date">May-Jun 2026</div>
                <div class="roadmap-desc">Human-verified proof with fully private evidence and quantum-resistant encryption</div>
                <div class="roadmap-desc">POH token launch (date TBA)</div>
              </div>
            </div>
            <div class="roadmap-item">
              <div class="roadmap-dot"></div>
              <div class="roadmap-content">
                <div class="roadmap-date">Jun-Jul 2026</div>
                <div class="roadmap-desc">Multi-chain support across Bitcoin, Litecoin, and Tron</div>
              </div>
            </div>

            <div class="roadmap-item">
              <div class="roadmap-dot"></div>
              <div class="roadmap-content">
                <div class="roadmap-date">Jul-Aug 2026</div>
                <div class="roadmap-desc">Trading pair analysis to identify fake liquidity and real market activity</div>
              </div>
            </div>
            
            <div class="roadmap-item">
              <div class="roadmap-dot"></div>
              <div class="roadmap-content">
                <div class="roadmap-date">Aug-Sep 2026</div>
                <div class="roadmap-desc">Visual analytics powered by charts & behavioral data mapping</div>
              </div>
            </div>

            <div class="roadmap-item">
              <div class="roadmap-dot"></div>
              <div class="roadmap-content">
                <div class="roadmap-date">Q4 2026</div>
                <div class="roadmap-desc">TBA</div>
              </div>
            </div>
          </div>
        </section>

      </div>

      <!-- Checker -->
      <div v-if="currentSection === 'checker'" class="scan-page">
        <div class="scan-hero">
          <div class="scan-tag">WALLET SCANNER</div>
          <h2 class="scan-title">Verify any wallet</h2>
          <p class="scan-sub">Run all registered detection methods simultaneously and get an AI verdict.</p>
        </div>

        <!-- Devnet faucet -->
        <div class="scan-box">
          <div >Devnet only · not real tokens · for testing purposes</div>
          <br>
          <a href="https://faucet.solana.com/" target="_blank" style="color: #fff;">Claim Devnet SOL here</a>
          <div style="margin-top: 0.5rem;">
            <span style="margin-top: 0.5rem;" v-if="faucetMsg" :class="['faucet-msg', faucetMsg.ok ? 'faucet-msg--ok' : 'faucet-msg--err']">
              {{ faucetMsg.text }}
            </span>
            <button style="margin-top: 0.5rem;" class="submit-listing-btn" :disabled="faucetLoading" @click="claimFaucet">
              {{ faucetLoading ? 'Sending…' : 'Claim 10 000 POH' }}
            </button>
          </div>
        </div>

        <div class="scan-box">
          <div class="scan-input-row">
            <input
              type="text"
              v-model="scanInput"
              :disabled="!!batchFile"
              placeholder="0x... or wallet.sol or wallet.eth"
              class="scan-input"
              @keydown.enter="runCheck"
            />
            <label class="scan-upload" title="Upload CSV batch">
              <input type="file" @change="handleFileSelect" accept=".csv" class="hidden-input" />
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
            <button @click="batchFile = null; batchRowCount = 0; batchRows = []" class="mini-btn"><Trash2 :size="12" /></button>
          </div>
          <button @click="runCheck" :disabled="loading || (!scanInput && !batchFile)" class="submit-listing-btn">
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

      <!-- Listing -->
      <div v-if="currentSection === 'listing'" class="content-section">
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
            <button :class="['type-tab', { active: listing.type === 'evm' }]" @click="listing.type = 'evm'; abiFns = []">EVM Contract</button>
            <button :class="['type-tab', { active: listing.type === 'solana' }]" @click="listing.type = 'solana'; abiFns = []">Solana Program</button>
            <button :class="['type-tab', { active: listing.type === 'rest' }]" @click="listing.type = 'rest'; abiFns = []">REST API</button>
          </div>
        </div>

        <!-- EVM fields -->
        <div v-if="listing.type === 'evm'" class="form-section">
          <div class="form-label-row"><span class="form-section-label">Contract</span></div>
          <div class="input-group">
            <div class="form-row">
              <div class="form-col-sm">
                <label class="field-label">Chain ID</label>
                <input type="number" v-model="listing.chainId" placeholder="1" class="premium-input" />
              </div>
              <div class="form-col-lg">
                <label class="field-label">Contract Address</label>
                <div class="flex-input">
                  <input type="text" v-model="listing.address" placeholder="0x..." class="premium-input flex-grow" @blur="fetchAbi" />
                  <button @click="fetchAbi" :disabled="abiLoading || !listing.address" class="mini-btn">{{ abiLoading ? '...' : 'Fetch ABI' }}</button>
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
                <button v-for="fn in abiFns" :key="fn.name" @click="pickMethod(fn)" :class="['abi-fn-btn', { selected: listing.method === fn.name }]">{{ fn.name }}</button>
              </div>
            </div>
            <div class="form-row">
              <div class="form-col">
                <label class="field-label">Method Name <span class="field-hint-inline">e.g. balanceOf</span></label>
                <input type="text" v-model="listing.method" placeholder="balanceOf" class="premium-input font-mono" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-col">
                <label class="field-label">Input Types <span class="field-hint-inline">JSON array e.g. ["address"]</span></label>
                <input type="text" v-model="listing.abiTypes" placeholder='["address"]' class="premium-input font-mono" />
              </div>
              <div class="form-col">
                <label class="field-label">Return Types <span class="field-hint-inline">JSON array e.g. ["uint256"]</span></label>
                <input type="text" v-model="listing.returnTypes" placeholder='["uint256"]' class="premium-input font-mono" />
              </div>
            </div>
            <div class="form-row">
              <div class="form-col-sm">
                <label class="field-label">Decimals <span class="field-hint-inline">for token values</span></label>
                <input type="number" v-model="listing.decimals" placeholder="18" class="premium-input" />
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
                <input type="text" v-model="listing.address" placeholder="Program or mint address" class="premium-input flex-grow" @blur="fetchAbi" />
                <button @click="fetchAbi" :disabled="abiLoading || !listing.address" class="mini-btn">{{ abiLoading ? '...' : 'Fetch IDL' }}</button>
              </div>
            </div>
            <div v-if="abiError" class="field-hint field-hint--warn">{{ abiError }}</div>
            <div v-if="abiFns.length" class="abi-picker">
              <div class="abi-picker-header">
                <span class="abi-picker-label">IDL Instructions</span>
                <span class="abi-picker-count">{{ abiFns.length }} found</span>
              </div>
              <div class="abi-picker-list">
                <button v-for="fn in abiFns" :key="fn.name" @click="pickMethod(fn)" :class="['abi-fn-btn', { selected: listing.method === fn.name }]">{{ fn.name }}</button>
              </div>
            </div>
            <div>
              <label class="field-label">Method</label>
              <select v-model="listing.method" class="premium-select">
                <option value="getBalance">getBalance — native SOL balance</option>
                <option value="getTransactionCount">getTransactionCount — tx history count</option>
                <option value="getTokenBalance">getTokenBalance — SPL token balance (requires mint address above)</option>
              </select>
            </div>
            <div class="form-row">
              <div class="form-col-sm">
                <label class="field-label">Decimals</label>
                <input type="number" v-model="listing.decimals" placeholder="9" class="premium-input" />
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
              <input type="text" v-model="listing.address" placeholder="https://api.example.com/check?address={address}" class="premium-input font-mono" />
            </div>
            <div class="form-row">
              <div class="form-col-sm">
                <label class="field-label">HTTP Method</label>
                <select v-model="listing.httpMethod" class="premium-select">
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                </select>
              </div>
              <div class="form-col-sm">
                <label class="field-label">Decimals <span class="field-hint-inline">optional</span></label>
                <input type="number" v-model="listing.decimals" placeholder="18" class="premium-input" />
              </div>
            </div>
            <div v-if="listing.httpMethod === 'POST'">
              <label class="field-label">Request Body <span class="field-hint-inline">JSON template, use {address}</span></label>
              <textarea v-model="listing.body" placeholder='{"address": "{address}"}' class="premium-textarea font-mono" rows="3"></textarea>
            </div>
            <div>
              <div class="form-label-row">
                <span class="field-label">Headers</span>
                <button class="utility-link" @click="addHeader">+ Add</button>
              </div>
              <div class="input-group" style="gap:0.4rem">
                <div v-for="(h, i) in headers" :key="i" class="flex-input">
                  <input type="text" v-model="h.key" placeholder="Header name" class="premium-input flex-grow" />
                  <input type="text" v-model="h.value" placeholder="Value" class="premium-input flex-grow" />
                  <button @click="removeHeader(i)" class="mini-btn" :disabled="headers.length === 1">×</button>
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
                <textarea v-model="listing.expression" placeholder="result[0] > 0n" class="premium-textarea font-mono" rows="3"></textarea>
              </div>
              <div class="form-col-sm">
                <label class="field-label">Language</label>
                <select v-model="listing.lang" class="premium-select">
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

        <!-- Description + submit — shared -->
        <div class="form-section">
          <div class="form-label-row"><span class="form-section-label">Description</span></div>
          <div class="input-group">
            <textarea v-model="listing.description" placeholder="What does this method detect? What constitutes human evidence?" class="premium-textarea" rows="2" @input="autoExpand"></textarea>
            <div class="listing-fee-row">
              <span class="listing-fee-label">Listing fee: <strong>1000 POH</strong></span>
              <span class="listing-fee-balance" :class="{ insufficient: pohBalance < 1000 }">
                Balance: {{ pohBalance.toFixed(2) }} POH
              </span>
            </div>
            <button @click="submitListing" :disabled="loading || !listing.description || pohBalance < 1000" class="submit-listing-btn">
              {{ loading ? 'Confirming on-chain...' : 'Submit Method — 1000 POH' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Votes -->
      <div v-if="currentSection === 'votes'" class="votes-page">
        <div class="votes-header">
          <div class="scan-tag">CONSENSUS QUEUE</div>
          <h2 class="scan-title">Review detection methods</h2>
          <p class="scan-sub">Vote on whether each method reliably distinguishes humans from bots. Your POH stake weight determines your influence.</p>
        </div>

        <div v-if="loading" class="empty-state"><p>Loading...</p></div>

        <div v-else-if="!currentVoteItem" class="empty-state">
          <Code :size="28" />
          <p>{{ votingList.length ? 'All methods reviewed.' : 'Queue is empty.' }}</p>
          <button v-if="votingList.length" class="utility-link" @click="voteIndex = 0">Start over</button>
        </div>

        <div v-else class="vote-single">
          <div class="vote-progress">
            <div class="vote-progress-bar">
              <div class="vote-progress-fill" :style="{ width: (voteIndex / votingList.length * 100) + '%' }"></div>
            </div>
            <span class="vote-progress-label">{{ voteIndex + 1 }} / {{ votingList.length }}</span>
          </div>

          <div class="vote-card-single">
            <div class="vcs-meta">
              <span class="vmc-type">{{ currentVoteItem.type?.toUpperCase() }}</span>
              <span v-if="currentVoteItem.chainId" class="vcs-chain">chain {{ currentVoteItem.chainId }}</span>
              <span class="vmc-score">score {{ currentVoteItem.score?.toFixed(1) ?? '0.0' }}</span>
            </div>

            <p class="vcs-desc">{{ currentVoteItem.description }}</p>

            <div class="vcs-detail" v-if="currentVoteItem.address">
              <span class="vcs-detail-label">{{ currentVoteItem.type === 'rest' ? 'Endpoint' : 'Address' }}</span>
              <span class="vcs-detail-val">{{ currentVoteItem.address }}</span>
            </div>
            <div class="vcs-detail" v-if="currentVoteItem.method">
              <span class="vcs-detail-label">Method</span>
              <span class="vcs-detail-val">{{ currentVoteItem.method }}</span>
            </div>
            <div class="vcs-detail" v-if="currentVoteItem.expression">
              <span class="vcs-detail-label">Expression</span>
              <code class="vcs-code">{{ currentVoteItem.expression }}</code>
            </div>

            <div class="vcs-score-bar">
              <div class="vcs-score-fill" :style="{ width: Math.min(100, Math.max(0, (currentVoteItem.score || 0) * 10)) + '%' }"></div>
            </div>

            <textarea
              v-model="voteFeedback"
              class="vcs-feedback"
              placeholder="Optional: explain your reasoning to help the AI learn…"
              rows="2"
              maxlength="200"
              @input="autoExpand"
            ></textarea>

            <div class="vcs-actions">
              <button class="vcs-btn vcs-btn-yes" :disabled="voteSubmitting || feedbackValidating" @click="castVote(true)">
                {{ feedbackValidating ? 'Checking…' : voteSubmitting ? '…' : '✓ Human' }}
              </button>
              <button class="vcs-btn vcs-btn-no" :disabled="voteSubmitting || feedbackValidating" @click="castVote(false)">
                {{ feedbackValidating ? 'Checking…' : '✗ Robot' }}
              </button>
              <button class="vcs-btn vcs-btn-skip" :disabled="feedbackValidating" @click="castVote('skip')">
                Skip →
              </button>
            </div>
          </div>
        </div>
      </div>

      <!-- Profile -->
      <div v-if="currentSection === 'profile'" class="profile-page">
        <div class="scan-hero">
          <div class="scan-tag">PROFILE</div>
          <h2 class="scan-title">Your POH Account</h2>
          <p class="scan-sub">Sign in with your Solana wallet to access your API key, track rewards, and manage your submitted methods.</p>
        </div>

        <div v-if="!connected" class="profile-connect-prompt">
          <p class="prompt-text">Connect your Solana wallet to view your profile.</p>
          <button class="submit-listing-btn" @click="showWalletModal = true">Connect Wallet</button>
        </div>

        <template v-else>
          <div v-if="profileError" class="profile-error">{{ profileError }}</div>

          <div v-if="profileLoading" class="empty-state"><p>Loading profile...</p></div>

          <div v-else-if="!profileData" class="profile-signup-card">
            <p class="signup-desc">No profile found for this wallet. Create one to get your API key and start earning rewards from submitted methods.</p>
            <button class="submit-listing-btn" :disabled="signupLoading" @click="signupProfile()">
              {{ signupLoading ? 'Signing...' : 'Create Profile' }}
            </button>
          </div>

          <template v-else>
            <!-- Stats row -->
            <div class="profile-stats">
              <div class="pstat-card">
                <div class="pstat-val">{{ profileData.profile?.freeScansLeft ?? 100 }}</div>
                <div class="pstat-label">Free Scans Left</div>
              </div>
              <div class="pstat-card">
                <div class="pstat-val">{{ profileData.profile?.totalScans ?? 0 }}</div>
                <div class="pstat-label">Total Scans</div>
              </div>
              <div class="pstat-card deposit-stat" @click="showDepositModal = true" title="Click to deposit POH">
                <div class="pstat-val">{{ ((profileData.profile?.balance ?? 0) / 1e6).toFixed(2) }}</div>
                <div class="pstat-label">Account Balance (POH) <br><span class="pstat-deposit-hint">Tap to Deposit</span></div>
              </div>
              <div class="pstat-card">
                <div class="pstat-val">{{ profileData.earned ? (profileData.earned / 1e6).toFixed(2) : '0.00' }}</div>
                <div class="pstat-label">Total Earned</div>
              </div>
            </div>

            <!-- Claimable scan earnings -->
            <div v-if="(profileData.pending ?? 0) > 0" class="profile-card profile-claim-card">
              <div class="profile-card-header">
                <span class="profile-card-title">Scan Earnings</span>
                <span class="claim-amount">{{ (profileData.pending / 1e6).toFixed(4) }} POH</span>
              </div>
              <p class="profile-hint">Your methods earned this from paid scans. Claim to receive tokens on-chain.</p>
              <button class="submit-listing-btn claim-btn" :disabled="offchainClaimLoading" @click="claimOffchainBalance()">
                {{ offchainClaimLoading ? 'Claiming...' : 'Claim Earnings' }}
              </button>
            </div>

            <!-- API Key -->
            <div class="profile-card">
              <div class="profile-card-header">
                <span class="profile-card-title">API Key</span>
                <button class="mini-btn" @click="rotateApiKey()">Rotate</button>
              </div>
              <div class="apikey-row">
                <code class="apikey-display">{{ profileData.profile?.apiKey }}</code>
                <button class="mini-btn" @click="copyText(profileData.profile?.apiKey)">Copy</button>
              </div>
              <p class="profile-hint">Pass as <code>apiKey</code> in POST /checker body. Identify scans without wallet interaction.</p>
            </div>

            <!-- Submitted methods -->
            <div class="profile-card">
              <div class="profile-card-header">
                <span class="profile-card-title">Submitted Methods</span>
                <span class="profile-card-count">{{ profileData.methods?.length ?? 0 }}</span>
              </div>
              <div v-if="!profileData.methods?.length" class="profile-empty">
                No methods submitted yet.
                <button class="utility-link no-margin" @click="showSection('listing')">Submit one →</button>
              </div>
              <div v-else class="method-list-profile">
                <div v-for="m in profileData.methods" :key="m.id" class="mlist-row">
                  <div class="mlist-main">
                    <span class="mlist-type">{{ m.type?.toUpperCase() }}</span>
                    <span class="mlist-desc">{{ m.description }}</span>
                  </div>
                  <div class="mlist-meta">
                    <span class="mlist-score">score {{ m.score?.toFixed(1) ?? '0.0' }}</span>
                    <span class="mlist-earned">{{ ((profileData.pending || 0) / 1e6).toFixed(4) }} POH pending</span>
                  </div>
                </div>
              </div>
            </div>

            <!-- My Votes -->
            <div class="profile-card">
              <div class="profile-card-header">
                <span class="profile-card-title">My Votes</span>
                <span class="profile-card-count">{{ myVotesData.length }}</span>
              </div>
              <div v-if="!myVotesData.length" class="profile-empty">
                No votes cast yet.
                <button class="utility-link no-margin" @click="showSection('votes'); loadVoting()">Go vote →</button>
              </div>
              <div v-else class="method-list-profile">
                <div v-for="v in myVotesData" :key="v.methodId" class="mlist-row">
                  <div class="mlist-main">
                    <span class="mlist-type">{{ v.type?.toUpperCase() }}</span>
                    <span class="mlist-desc">{{ v.description }}</span>
                  </div>
                  <div v-if="v.feedback" class="mlist-feedback">"{{ v.feedback }}"</div>
                  <div class="mlist-meta">
                    <span :class="['vote-badge', v.vote ? 'vote-human' : 'vote-bot']">
                      {{ v.vote ? '✓ Human' : '✗ Bot' }}
                    </span>
                    <span class="mlist-score">{{ new Date(v.at).toLocaleDateString() }}</span>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </template>
      </div>

      <!-- API -->
      <div v-if="currentSection === 'api'" class="api-page">
        <div class="scan-hero">
          <div class="scan-tag">API REFERENCE</div>
          <h2 class="scan-title">Integrate POH</h2>
          <p class="scan-sub">Simple HTTP API. First 100 scans free per wallet. Authenticate with an API key from your profile.</p>
        </div>

        <!-- Pricing table -->
        <div class="api-section">
          <div class="api-section-title">Pricing</div>
          <div class="pricing-table">
            <div class="pt-row pt-head">
              <span>Batch size</span><span>Rate</span><span>Example</span>
            </div>
            <div class="pt-row">
              <span>1 – 9 addresses</span><span>1.00 POH / addr</span><span>5 addrs = 5 POH</span>
            </div>
            <div class="pt-row">
              <span>10 – 49 addresses</span><span>0.85 POH / addr</span><span>20 addrs = 17 POH</span>
            </div>
            <div class="pt-row">
              <span>50 – 99 addresses</span><span>0.70 POH / addr</span><span>70 addrs = 49 POH</span>
            </div>
            <div class="pt-row">
              <span>100 – 499 addresses</span><span>0.55 POH / addr</span><span>200 addrs = 110 POH</span>
            </div>
            <div class="pt-row">
              <span>500+ addresses</span><span>0.40 POH / addr</span><span>1000 addrs = 400 POH</span>
            </div>
            <div class="pt-row pt-free">
              <span>Free tier</span><span>0 POH</span><span>First 100 scans per wallet</span>
            </div>
          </div>
        </div>

        <!-- Endpoint docs -->
        <div class="api-section">
          <div class="api-section-title">POST /checker</div>
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
              <div class="code-lang">curl — single</div>
              <pre class="code-pre">curl -X POST https://proofofhuman.ge/checker \
  -H "Content-Type: application/json" \
  -d '{
    "input": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "apiKey": "your-api-key-here"
  }'
# → { result: [...], brainKey, freeScansLeft }</pre>
            </div>
            <div class="code-block">
              <div class="code-lang">curl — bulk (CSV)</div>
              <pre class="code-pre">curl -X POST https://proofofhuman.ge/checker \
  -F "csv=@wallets.csv" \
  -F "apiKey=your-api-key-here" \
  -F "txHash=your-payment-tx"
# → { jobId, status: "queued", total, pollUrl }</pre>
            </div>
            <div class="code-block">
              <div class="code-lang">JavaScript</div>
              <pre class="code-pre">const res = await fetch('/checker', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    input: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
    apiKey: 'your-api-key-here'
  })
})
const { result, brainKey, freeScansLeft } = await res.json()</pre>
            </div>
          </div>
        </div>

        <div class="api-section">
          <div class="api-section-title">GET /checker/job/:jobId</div>
          <div class="api-card">
            <div class="api-desc">Poll the status of a bulk scan job. <code>jobId</code> is returned by POST /checker when more than one address is submitted. Jobs are retained for 2 hours after completion.</div>
            <div class="api-params">
              <div class="param-row"><code>status</code><span>queued | running | done</span></div>
              <div class="param-row"><code>total</code><span>total addresses in the job</span></div>
              <div class="param-row"><code>done</code><span>addresses processed so far</span></div>
              <div class="param-row"><code>percent</code><span>completion percentage (0–100)</span></div>
              <div class="param-row"><code>results</code><span>array of per-method scan results (grows incrementally)</span></div>
              <div class="param-row"><code>errors</code><span>array of error messages for failed addresses</span></div>
            </div>
            <div class="code-block">
              <div class="code-lang">JavaScript — poll until done</div>
              <pre class="code-pre">const { jobId } = await fetch('/checker', { method: 'POST', ... }).then(r => r.json())

async function pollJob(jobId) {
  while (true) {
    const job = await fetch(`/checker/job/${jobId}`).then(r => r.json())
    console.log(`${job.percent}% — ${job.done}/${job.total}`)
    if (job.status === 'done') return job.results
    await new Promise(r => setTimeout(r, 3000))
  }
}

const results = await pollJob(jobId)</pre>
            </div>
          </div>
        </div>

        <div class="api-section">
          <div class="api-section-title">GET /checker/brain/:key</div>
          <div class="api-card">
            <div class="api-desc">Poll for the async AI verdict after a scan. <code>brainKey</code> is returned by POST /checker. Returns <code>status: "pending" | "done" | "error"</code>.</div>
            <div class="code-block">
              <div class="code-lang">curl</div>
              <pre class="code-pre">curl https://proofofhuman.ge/checker/brain/0xabc123...</pre>
            </div>
            <div class="api-params">
              <div class="param-row"><code>verdict</code><span>HUMAN | AI | UNCERTAIN | UNKNOWN</span></div>
              <div class="param-row"><code>confidence</code><span>0.0 – 1.0</span></div>
              <div class="param-row"><code>reasoning</code><span>short technical explanation</span></div>
            </div>
          </div>
        </div>

        <div class="api-section">
          <div class="api-section-title">GET /checker/pricing?count=N</div>
          <div class="api-card">
            <div class="api-desc">Returns cost breakdown for a given batch size before committing.</div>
            <div class="code-block">
              <div class="code-lang">curl</div>
              <pre class="code-pre">curl "https://proofofhuman.ge/checker/pricing?count=100"
# → { count: 100, perAddress: 0.55, total: 55000000, tiers: [...] }</pre>
            </div>
          </div>
        </div>

        <div class="api-section">
          <div class="api-section-title">GET /profile/:address</div>
          <div class="api-card">
            <div class="api-desc">Returns profile stats, submitted methods, and reward totals for a wallet address.</div>
            <div class="code-block">
              <div class="code-lang">curl</div>
              <pre class="code-pre">curl https://proofofhuman.ge/profile/YourSolanaWalletAddressHere</pre>
            </div>
          </div>
        </div>

        <div class="api-cta">
          <p>Get your API key from your <button class="utility-link" @click="showSection('profile'); loadProfile(); loadMyVotes()">profile →</button></p>
        </div>
      </div>

      <!-- Staking -->
      <div v-if="currentSection === 'staking'" class="staking-page">
        <div class="scan-hero">
          <div class="scan-tag">STAKING</div>
          <h2 class="scan-title">Stake POH</h2>
          <p class="scan-sub">Your staked POH balance determines your vote weight when scoring detection methods. Higher stake = more signal in the consensus.</p>
        </div>

        <div class="staking-grid">
          <div class="staking-info-card">
            <div class="si-title">How staking works</div>
            <ul class="si-list">
              <li>Stake POH tokens to increase your voting power in the method scoring queue</li>
              <li>Vote weight = base 1 + stake-weighted multiplier</li>
              <li>AI Learner uses community vote weights when updating per-method signal weights</li>
              <li>Top stakers gain outsized influence over which detection methods rank highest</li>
              <li>Unstake at any time — no lockup period in v1</li>
            </ul>
          </div>

          <div class="staking-info-card">
            <div class="si-title">Reward flow</div>
            <ul class="si-list">
              <li>Every paid scan distributes 50% of POH cost to method owners</li>
              <li>Distribution is weighted by method score × AI weight</li>
              <li>Your stake improves method scores → more rewards to method owners you back</li>
            </ul>
          </div>
        </div>

        <div class="stake-form-card">
          <div class="stake-form-title">Manage Stake</div>
          <div v-if="!connected" class="prompt-text">
            <button class="utility-link" @click="showWalletModal = true">Connect wallet →</button>
          </div>
          <template v-else>
            <!-- Balances -->
            <div class="stake-balance-row">
              <div class="sbal-item">
                <div class="sbal-val">{{ pohBalance.toFixed(2) }}</div>
                <div class="sbal-label">Wallet POH</div>
              </div>
              <div class="sbal-item">
                <div class="sbal-val">{{ stakedBalance.toFixed(2) }}</div>
                <div class="sbal-label">Staked</div>
              </div>
              <div class="sbal-item">
                <div class="sbal-val">{{ totalStaked.toFixed(0) }}</div>
                <div class="sbal-label">Total Staked</div>
              </div>
              <div class="sbal-item sbal-claimable">
                <div class="sbal-val">{{ claimable.toFixed(4) }}</div>
                <div class="sbal-label">Claimable</div>
              </div>
            </div>

            <!-- Stake -->
            <div class="stake-action-row">
              <div class="flex-input">
                <input type="number" v-model="stakeAmount" placeholder="POH to stake" class="premium-input flex-grow" min="0" step="1" />
                <button class="outline-btn" :disabled="stakeLoading || !stakeAmount" @click="submitStake()">
                  {{ stakeLoading ? '...' : 'Stake' }}
                </button>
              </div>
              <button class="max-btn" @click="stakeAmount = pohBalance.toFixed(2)">MAX</button>
            </div>

            <!-- Unstake -->
            <div class="stake-action-row">
              <div class="flex-input">
                <input type="number" v-model="unstakeAmount" placeholder="POH to unstake" class="premium-input flex-grow" min="0" step="1" />
                <button class="outline-btn" :disabled="unstakeLoading || !unstakeAmount" @click="submitUnstake()">
                  {{ unstakeLoading ? '...' : 'Unstake' }}
                </button>
              </div>
              <button class="max-btn" @click="unstakeAmount = stakedBalance.toFixed(2)">MAX</button>
            </div>

            <!-- Claim on-chain staking rewards -->
            <div v-if="claimable > 0" class="stake-claim-row">
              <span class="claim-desc">{{ claimable.toFixed(4) }} POH from on-chain staking</span>
              <button class="outline-btn" :disabled="claimLoading" @click="claimRewards()">
                {{ claimLoading ? 'Claiming...' : 'Claim Rewards' }}
              </button>
            </div>

            <!-- Claim off-chain rewards (listing fees + scan revenue distributed by backend) -->
            <div v-if="(profileData?.profile?.balance ?? 0) > 0" class="stake-claim-row">
              <span class="claim-desc">{{ ((profileData.profile.balance) / 1e6).toFixed(4) }} POH off-chain rewards</span>
              <button class="outline-btn" :disabled="offchainClaimLoading" @click="claimOffchainBalance()">
                {{ offchainClaimLoading ? 'Claiming...' : 'Claim POH' }}
              </button>
            </div>

            <div v-if="stakeMessage" class="stake-message">{{ stakeMessage }}</div>
            <p class="profile-hint" style="margin-top:0.75rem">
              Contract: <code>{{ STAKING_CONTRACT }}</code>
            </p>
          </template>
        </div>
      </div>

    </main>

    <footer class="footer">
      <div class="network-label">CONNECT</div>
    </footer>
  </div>
</template>

<style scoped>

.neon-btn {
  background: #000;
  color: #fff;
  border: none;
  padding: 0.7rem 1.4rem;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s;
  font-size: 1rem;
}


/* ── Landing ─────────────────────────────────────────────────────────────── */
.network-label {
  font-size: 3rem;
  margin: auto;
  color: #888;
  display: block;
  text-align: center;
  margin: 3.5rem 0;
}

.landing {
  max-width: 1280px;
  margin: 0 auto 0;
  padding: 0 0 2rem;
}

/* ── Problem screen ───────────────────────────────────────────────────────── */
.problem-screen {
  min-height: 60vh;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6rem 2rem;
  /* border-bottom: 1px solid #111; */
}
.problem-inner { max-width: 680px; text-align: center; }
.problem-tag {
  font-size: 0.7rem; letter-spacing: 0.18em; color: #555;
  font-family: 'JetBrains Mono', monospace; margin-bottom: 2rem;
}
.problem-title {
  font-size: clamp(1.8rem, 4vw, 3rem);
  font-weight: 700; color: #ccc; line-height: 1.25; margin-bottom: 2.5rem;
}
.problem-accent { color: #fff; }
.problem-quote {
  border-left: 2px solid #222; margin: 0 0 2rem; padding: 1rem 1.5rem;
  text-align: left; color: #555; font-style: italic; font-size: 1.25rem; line-height: 1.6;
}
.problem-quote cite { display: block; margin-top: 0.5rem; font-style: normal; color: #555; font-size: 0.82rem; }
.problem-desc { color: #555; font-size: 1.25rem; line-height: 1.7; margin-bottom: 2.5rem; }

/* ── Roadmap ──────────────────────────────────────────────────────────────── */
.roadmap-section { padding: 5rem 0 6rem; border-top: 1px solid #111; }
.roadmap-list { max-width: 520px; margin: 2.5rem auto 0; display: flex; flex-direction: column; gap: 0; }
.roadmap-item {
  display: flex; gap: 1.25rem; align-items: flex-start;
  padding: 1.1rem 0; position: relative;
}
.roadmap-item:not(:last-child)::after {
  content: ''; position: absolute; left: 5px; top: 2.2rem; bottom: -1rem;
  width: 1px; background: #1a1a1a;
}
.roadmap-dot {
  width: 11px; height: 11px; border-radius: 50%; border: 1px solid #555;
  background: #0d0d0d; flex-shrink: 0; margin-top: 3px;
}
.roadmap-active .roadmap-dot { border-color: #555; background: #1a1a1a; box-shadow: 0 0 6px #555; }
.roadmap-date { font-size: 2rem; color: #555; font-family: 'JetBrains Mono', monospace; margin-bottom: 0.2rem; }
.roadmap-active .roadmap-date { color: #888; }
.roadmap-desc { font-size: 1.25rem; color: #555; padding: 5px 0px; }
.roadmap-active .roadmap-desc { color: #666; }

.landing-hero {
  padding: 10rem 0 10rem;
  text-align: center;
}

.landing-tag {
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: #555;
  text-transform: uppercase;
  margin-bottom: 1.5rem;
}

.landing-title {
  font-size: clamp(2.75rem, 7.5vw, 4.38rem);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.05;
  color: #fff;
  margin: 3rem 0;
}

.landing-sub {
  font-size: 1.25rem;
  color: #555;
  line-height: 1.7;
  margin-bottom: 2rem;
}

.landing-cta {
  font-size: 1.56rem;
  padding: 1rem 1.75rem;
  display: flex;
  align-items: center;   /* vertical center */
  justify-content: center; /* horizontal center (optional) */
  gap: 8px; /* space between icon and text */
}

.landing-divider {
  height: 1px;
  background: #111;
  margin: 0.5rem 0 3rem;
}

/* Utilities grid */
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

.feat-left {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
  max-width: 460px;
}
.feat-right {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.display-block { display: block; }

.feat-tag {
  font-size: 0.7rem;
  letter-spacing: 0.18em;
  color: #555;
  font-weight: 600;
}
.feat-title {
  font-size: clamp(2rem, 4vw, 3rem);
  font-weight: 700;
  color: #fff;
  line-height: 1.1;
  letter-spacing: -0.03em;
  margin: 0;
}
.feat-body {
  font-size: 1.25rem;
  color: #555;
  line-height: 1.7;
  margin: 0;
}
.feat-cta {
  align-self: flex-start;
  background: none;
  border: none;
  color: #666;
  font-size: 0.95rem;
  cursor: pointer;
  padding: 0;
  transition: color 0.15s;
}
.feat-cta:hover { color: #fff; }

.feat-svg {
  width: 100%;
  max-width: 768px;
  height: auto;
  overflow: visible;
}

@media (max-width: 768px) {
  .feat-screen {
    flex-direction: column !important;
    min-height: auto;
    padding: 4rem 0;
    gap: 2.5rem;
  }
  .feat-left {
    max-width: 100%;
  }
  .feat-svg {
    max-width: 100%;
  }
}

.utility-link {
  background: none;
  border: none;
  color: #888;
  font-size: 1rem;
  cursor: pointer;
  padding: 0;
  text-align: left;
  transition: color 0.15s;
}
.utility-link:hover { color: #fff; }

/* Token section */
.landing-token {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 2rem;
}

.token-header {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 1rem;
}

.token-ticker {
  font-size: 1.62rem;
  font-weight: 700;
  color: #fff;
  letter-spacing: -0.02em;
}

.token-label {
  font-size: 1.25rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #555;
}

.token-desc {
  font-size: 1.44rem;
  color: #555;
  line-height: 1.6;
  margin-bottom: 3.75rem;
}

.token-split { margin-bottom: 3.75rem; }

.split-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.4rem;
}

.split-label { font-size: 1.25rem; color: #888; }
.split-pct { font-size: 1.12rem; font-weight: 600; color: #fff; font-variant-numeric: tabular-nums; }

.split-bar {
  height: 2px;
  background: #1a1a1a;
  border-radius: 1px;
  margin-bottom: 0.4rem;
}

.split-fill {
  height: 100%;
  background: #fff;
  border-radius: 1px;
}

.split-note {
  font-size: 1.25rem;
  color: #3a3a3a;
}

.token-features {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 3.75rem;
}

.token-feat {
  font-size: 1.25rem;
  color: #555;
  border: 1px solid #1a1a1a;
  border-radius: 4px;
  padding: 0.3rem 1rem;
}

/* ── How it works ────────────────────────────────────────────────────────── */
.how-section { margin: 0 0 10rem; }

.how-label {
  font-size: 0.81rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: #555;
  text-transform: uppercase;
  margin-bottom: 2rem;
  text-align: center;
}

.how-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 1px;
  background: #111;
  border: 1px solid #111;
  border-radius: 8px;
  overflow: hidden;
}

.how-col {
  background: #000;
  padding: 1.75rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.how-step-title {
  font-size: 0.94rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #fff;
}

.how-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}

.how-list li {
  font-size: 1rem;
  color: #555;
  line-height: 1.55;
  padding-left: 0.9rem;
  position: relative;
}

.how-list li::before {
  content: '—';
  position: absolute;
  left: 0;
  color: #555;
}

.how-tag {
  display: inline-block;
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #555;
  border: 1px solid #1a1a1a;
  border-radius: 3px;
  padding: 0.1rem 0.35rem;
  margin-right: 0.35rem;
  vertical-align: middle;
}

/* ── Network visualization ───────────────────────────────────────────────── */
.net-section {
  width: 100vw;
  position: relative;
  left: 50%;
  transform: translateX(-50%);
  margin-bottom: 3rem;
  background: #000;
  padding: 0 0 2rem;
}

.net-subtitle {
  text-align: center;
  font-size: 1.1rem;
  color: #555;
  margin: -2rem 0 2.5rem;
  letter-spacing: 0.03em;
}

.net-wrap {
  /* border: 1px solid #111; */
  border-radius: 10px;
  overflow: hidden;
  background: #000;
  width: 100%;
}

.net-svg {
  display: block;
  width: 100%;
  height: auto;
}

/* ── Edges ── */
.net-edge {
  stroke: #1c1c1c;
  stroke-width: 1.2;
  stroke-dasharray: 3 11;
  animation: net-flow 2s linear infinite;
}
.net-edge--evm    { stroke: #555; }
.net-edge--rest   { stroke: #222; }
.net-edge--solana { stroke: #2a1a44; }

.net-edge--active {
  stroke-width: 1.8;
  animation-duration: 0.45s !important;
}
.net-edge--active.net-edge--evm    { stroke: #555; }
.net-edge--active.net-edge--rest   { stroke: #555; }
.net-edge--active.net-edge--solana { stroke: #9945ff88; }

@keyframes net-flow {
  to { stroke-dashoffset: -28; }
}

/* ── Brain → verdict edges ── */
.net-verdict-edge {
  stroke-width: 1;
  stroke-dasharray: 3 9;
  animation: net-flow 3s linear infinite;
}
.net-verdict-edge--human { stroke: #1a3a1a; }
.net-verdict-edge--bot   { stroke: #3a1a1a; }

/* ── Method nodes ── */
.net-ngroup circle {
  fill: #080808;
  stroke-width: 1.5;
  transition: fill 0.25s, filter 0.25s;
}
.net-ngroup--evm    circle { stroke: #555; }
.net-ngroup--rest   circle { stroke: #1e1e1e; }
.net-ngroup--solana circle { stroke: #4a2a7a; }

.net-ngroup--active circle { fill: #111; }
.net-ngroup--active.net-ngroup--evm    circle { stroke: #666;      filter: drop-shadow(0 0 5px #555); }
.net-ngroup--active.net-ngroup--rest   circle { stroke: #555;      filter: drop-shadow(0 0 5px #555); }
.net-ngroup--active.net-ngroup--solana circle { stroke: #9945ff;   filter: drop-shadow(0 0 6px #9945ff88); }

.net-nlabel {
  font-size: 9.5px;
  fill: #3a3a3a;
  font-family: -apple-system, 'SF Mono', monospace;
  pointer-events: none;
  transition: fill 0.25s;
}
.net-ngroup--active .net-nlabel { fill: #666; }

/* ── AI Brain ── */
.net-brain-ring {
  fill: none;
  stroke: #1a1a1a;
  stroke-width: 1;
  stroke-dasharray: 4 6;
  animation: net-flow 8s linear infinite reverse;
}
.net-brain-core {
  fill: #0d0d0d;
  stroke: #fff;
  stroke-width: 1.5;
  transition: filter 0.3s;
}
.net-brain-g--pulse .net-brain-core {
  filter: drop-shadow(0 0 18px rgba(255,255,255,0.35)) drop-shadow(0 0 6px rgba(255,255,255,0.2));
}
.net-brain-g {
  transition: transform 0.2s ease;
  transform-box: fill-box;
  transform-origin: 50% 50%;
}
.net-brain-g--pulse {
  transform: scale(1.04);
}
.net-brain-title {
  font-size: 8.5px;
  font-weight: 600;
  fill: #888;
  font-family: -apple-system, sans-serif;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  pointer-events: none;
}

/* ── Role badges (E / L / C) ── */
.net-role { stroke-width: 1; }
.net-role--eval  { fill: #0a1a0a; stroke: #1a4a1a; }
.net-role--learn { fill: #0a100a; stroke: #1a3a2a; }
.net-role--comp  { fill: #0a0a1a; stroke: #1a1a4a; }

.net-brain-g--pulse .net-role--eval  { stroke: #2aaa2a; filter: drop-shadow(0 0 4px #2aaa2a88); }
.net-brain-g--pulse .net-role--learn { stroke: #2a8a5a; filter: drop-shadow(0 0 4px #2a8a5a88); }
.net-brain-g--pulse .net-role--comp  { stroke: #2a4aaa; filter: drop-shadow(0 0 4px #2a4aaa88); }

.net-role-lbl {
  font-size: 7px;
  font-weight: 700;
  fill: #555;
  font-family: -apple-system, monospace;
  pointer-events: none;
}
.net-brain-g--pulse .net-role-lbl { fill: #aaa; }

/* ── Verdict output nodes ── */
.net-verdict {
  stroke-width: 1;
  fill: #060606;
  transition: stroke 0.3s, filter 0.3s;
}
.net-verdict--human { stroke: #1a3a1a; }
.net-verdict--bot   { stroke: #3a1a1a; }

.net-verdict-lbl {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.1em;
  font-family: -apple-system, monospace;
  pointer-events: none;
}
.net-verdict--human + .net-verdict-lbl,
.net-verdict-lbl { fill: #555; }

/* ── Legend ── */
.net-legend {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 0.5rem 1.5rem;
  margin-top: 1rem;
  flex-wrap: wrap;
}
.net-legend-group {
  display: flex;
  gap: 1.25rem;
  flex-wrap: wrap;
  align-items: center;
}
.nl-sep {
  width: 1px;
  height: 14px;
  background: #222;
  flex-shrink: 0;
}
.nl-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 1.1rem;
  color: #3a3a3a;
  white-space: nowrap;
}
.nl-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  border: 1px solid transparent;
}
.nl-dot--evm    { background: #1a1a1a; border-color: #555; }
.nl-dot--solana { background: #0d0019; border-color: #4a2a7a; }
.nl-dot--rest   { background: #0d0d0d; border-color: #222; }
.nl-dot--eval   { background: #0a1a0a; border-color: #1a4a1a; }
.nl-dot--learn  { background: #0a100a; border-color: #1a3a2a; }
.nl-dot--comp   { background: #0a0a1a; border-color: #1a1a4a; }

/* ── Form sections (Listing) ─────────────────────────────────────────────── */
.form-section {
  border: 1px solid #161616;
  border-radius: 10px;
  padding: 1.25rem 1.5rem 1.5rem;
  margin-bottom: 0.75rem;
  background: #050505;
}

.form-label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid #111;
}

.form-section-label {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.16em;
  color: #3a3a3a;
}

.field-label {
  display: block;
  font-size: 0.72rem;
  font-weight: 500;
  color: #555;
  margin-bottom: 0.4rem;
  letter-spacing: 0.02em;
}

.field-hint-inline {
  color: #2e2e2e;
  font-weight: 400;
  margin-left: 0.3rem;
  font-size: 0.68rem;
}

.field-hint { font-size: 0.72rem; color: #555; margin-top: 0.3rem; }
.field-hint--warn { color: #666; }

.type-tabs {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.type-tab {
  background: none;
  border: 1px solid #1a1a1a;
  color: #555;
  padding: 0.4rem 1rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.type-tab:hover { border-color: #555; color: #aaa; }
.type-tab.active { background: #fff; color: #000; border-color: #fff; font-weight: 600; }

.form-row {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  min-width: 0;
}

.form-col { flex: 1; min-width: 0; }
.form-col-sm { flex: 0 0 100px; min-width: 0; }
.form-col-lg { flex: 2; min-width: 0; }

.listing-header {
  text-align: center;
  margin-bottom: 2rem;
}

.submit-listing-btn {
  width: 100%;
  background: #fff;
  color: #000;
  border: none;
  padding: 0.9rem 1.5rem;
  border-radius: 8px;
  font-weight: 700;
  font-size: 1.2rem;
  cursor: pointer;
  transition: opacity 0.15s;
  letter-spacing: 0.02em;
  margin-top: 0.25rem;
}

.submit-listing-btn:hover:not(:disabled) { opacity: 0.88; }
.submit-listing-btn:disabled { opacity: 0.2; cursor: not-allowed; }

/* ── Scan page ───────────────────────────────────────────────────────────── */
.scan-page {
  max-width: 600px;
  margin: 0 auto 4rem;
  padding-top: 3rem;
}

.scan-hero {
  text-align: center;
  margin-bottom: 2.5rem;
}

.scan-tag {
  font-size: 0.81rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: #555;
  text-transform: uppercase;
  margin-bottom: 0.75rem;
}

.scan-title {
  font-size: 2.19rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #fff;
  margin-bottom: 0.5rem;
}

.scan-sub {
  font-size: 1.56rem;
  color: #555;
  line-height: 1.6;
}

.scan-box {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  margin-bottom: 2rem;
}

.scan-input-row {
  display: flex;
  gap: 0;
  border: 1px solid #222;
  border-radius: 8px;
  overflow: hidden;
  background: #080808;
  transition: border-color 0.15s;
}

.scan-input-row:focus-within { border-color: #555; }

.scan-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  padding: 0.9rem 1rem;
  color: #fff;
  font-size: 1.12rem;
}

.scan-input::placeholder { color: #555; }

.scan-upload {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  border-left: 1px solid #1a1a1a;
  cursor: pointer;
  color: #555;
  transition: color 0.15s;
  flex-shrink: 0;
}

.scan-upload:hover { color: #aaa; }

.scan-btn {
  width: 100%;
  background: #fff;
  color: #000;
  border: none;
  padding: 1.25rem;
  border-radius: 7px;
  font-weight: 600;
  font-size: 1.56rem;
  cursor: pointer;
  transition: opacity 0.15s;
}

.scan-btn:hover:not(:disabled) { opacity: 0.85; }
.scan-btn:disabled { opacity: 0.25; cursor: not-allowed; }

.brain-card {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 1rem 1.25rem;
  margin-bottom: 1rem;
  border-left: 3px solid #222;
}

.brain-pending { border-left-color: #555; }
.brain-human   { border-left-color: var(--green); }
.brain-bot     { border-left-color: var(--red); }

.brain-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.brain-conf { font-size: 1.25rem; color: #555; margin-top: 0.5rem; }

.results-accordion {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
}

.evidence-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 1rem 1rem 0.75rem;
  background: #0a0a0a;
  border-bottom: 1px solid #111;
}

.evidence-title {
  font-size: 1rem;
  color: #888;
  font-weight: 500;
  flex: 1;
}

.results-accordion-header {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1rem;
  background: #0a0a0a;
  border: none;
  cursor: pointer;
  gap: 1rem;
  transition: background 0.15s;
}
.results-accordion-header:hover { background: #0f0f0f; }
.results-accordion-header.sub {
  padding: 0.65rem 1rem 0.65rem 1.25rem;
  border-top: 1px solid #111;
}

.result-empty {
  color: #333;
  font-size: 0.85rem;
  padding: 0.5rem 0;
}

.accordion-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  min-width: 0;
}

.accordion-dots {
  display: flex;
  gap: 3px;
  flex-shrink: 0;
}
.acc-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
}
.acc-dot.pass { background: #2a6a2a; }
.acc-dot.fail { background: #3a1a1a; }

.accordion-summary {
  font-size: 1rem;
  color: #555;
  white-space: nowrap;
}

.accordion-chevron {
  font-size: 1.1rem;
  color: #555;
  transform: rotate(0deg);
  transition: transform 0.2s;
  flex-shrink: 0;
}
.accordion-chevron.open { transform: rotate(90deg); }

.results-list {
  border-top: 1px solid #111;
  padding: 0 1rem;
}

.result-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem 0;
  border-bottom: 1px solid #0e0e0e;
}

.result-row:last-child { border-bottom: none; }

.result-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.result-dot.pass { background: var(--green); }
.result-dot.fail { background: #555; }

.result-desc {
  flex: 1;
  font-size: 1.02rem;
  color: #777;
  line-height: 1.4;
}

/* ── Votes page ──────────────────────────────────────────────────────────── */
.votes-page {
  max-width: 560px;
  margin: 0 auto 4rem;
  padding-top: 3rem;
}

.votes-header {
  text-align: center;
  margin-bottom: 2.5rem;
}

.vote-single { display: flex; flex-direction: column; gap: 1rem; }

.vote-progress {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.vote-progress-bar {
  flex: 1;
  height: 2px;
  background: #111;
  border-radius: 1px;
  overflow: hidden;
}

.vote-progress-fill {
  height: 100%;
  background: #fff;
  border-radius: 1px;
  transition: width 0.3s ease;
}

.vote-progress-label {
  font-size: 1.25rem;
  color: #555;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.vote-card-single {
  border: 1px solid #1a1a1a;
  border-radius: 10px;
  padding: 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  animation: fadeUp 0.2s ease-out;
}

.vcs-meta {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.vcs-chain {
  font-size: 1.25rem;
  color: #555;
  letter-spacing: 0.05em;
}

.vmc-type {
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #555;
  border: 1px solid #1a1a1a;
  padding: 0.15rem 0.45rem;
  border-radius: 3px;
}

.vmc-score {
  font-size: 1.25rem;
  color: #555;
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}

.vcs-desc {
  font-size: 1.25rem;
  color: #ccc;
  line-height: 1.6;
  font-weight: 400;
}

.vcs-detail {
  display: flex;
  gap: 1.5rem;
  align-items: baseline;
}

.vcs-detail-label {
  font-size: 1.25rem;
  color: #555;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
  flex-shrink: 0;
  width: 130px;
}

.vcs-detail-val {
  font-size: 0.94rem;
  color: #555;
  font-family: 'JetBrains Mono', monospace;
  word-break: break-all;
}

.vcs-code {
  font-size: 0.94rem;
  color: #666;
  font-family: 'JetBrains Mono', monospace;
  background: #080808;
  border: 1px solid #1a1a1a;
  padding: 0.25rem 0.5rem;
  border-radius: 4px;
}

.vcs-score-bar {
  height: 2px;
  background: #111;
  border-radius: 1px;
  overflow: hidden;
}

.vcs-score-fill {
  height: 100%;
  background: #555;
  border-radius: 1px;
}

.vcs-feedback {
  width: 100%;
  margin-top: 0.75rem;
  background: #080808;
  border: 1px solid #1e1e1e;
  border-radius: 6px;
  color: #888;
  font-size: 1rem;
  font-family: inherit;
  padding: 0.5rem 0.65rem;
  resize: none;
  overflow: hidden;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}
.vcs-feedback::placeholder { color: #555; }
.vcs-feedback:focus { border-color: #555; color: #aaa; }

.vcs-actions {
  display: flex;
  gap: 0.5rem;
  padding-top: 0.25rem;
}

.vcs-btn {
  border: 1px solid #1a1a1a;
  border-radius: 6px;
  padding: 0.65rem 1rem;
  font-size: 1.03rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  background: none;
}

.vcs-btn:disabled { opacity: 0.3; cursor: not-allowed; }

.vcs-btn-yes {
  flex: 1;
  color: var(--green);
  border-color: rgba(34,197,94,0.25);
}
.vcs-btn-yes:hover:not(:disabled) {
  background: rgba(34,197,94,0.07);
  border-color: rgba(34,197,94,0.5);
}

.vcs-btn-no {
  flex: 1;
  color: var(--red);
  border-color: rgba(239,68,68,0.25);
}
.vcs-btn-no:hover:not(:disabled) {
  background: rgba(239,68,68,0.07);
  border-color: rgba(239,68,68,0.5);
}

.vcs-btn-skip {
  color: #555;
  padding: 0.65rem 1.1rem;
}
.vcs-btn-skip:hover { color: #888; border-color: #555; }

/* ── Layout ──────────────────────────────────────────────────────────────── */
.app-container {
  max-width: 1280px;
  width: 100%;
  margin: 0 auto;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* ── Devnet banner ───────────────────────────────────────────────────────── */
.devnet-bar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 1.5rem;
  background: #0d0d0d;
  border-bottom: 1px solid #1a1a1a;
  font-size: 0.7rem;
  flex-wrap: wrap;
}
.devnet-label {
  font-size: 0.6rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: #f59e0b;
  background: rgba(245,158,11,0.12);
  border: 1px solid rgba(245,158,11,0.25);
  border-radius: 3px;
  padding: 0.1rem 0.35rem;
  flex-shrink: 0;
}
.devnet-sep { color: #333; flex-shrink: 0; }
.devnet-hint { color: #444; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.devnet-bar-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
  flex-shrink: 0;
}
.devnet-faucet-btn {
  background: rgba(245,158,11,0.1);
  border: 1px solid rgba(245,158,11,0.3);
  color: #f59e0b;
  font-size: 0.68rem;
  padding: 0.2rem 0.65rem;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  white-space: nowrap;
}
.devnet-faucet-btn:hover:not(:disabled) {
  background: rgba(245,158,11,0.2);
  border-color: rgba(245,158,11,0.5);
}
.devnet-faucet-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.devnet-faucet-msg { font-size: 0.65rem; }
.devnet-faucet-msg--ok  { color: #4ade80; }
.devnet-faucet-msg--err { color: #f87171; }

/* ── Header ──────────────────────────────────────────────────────────────── */
.header {
  padding: 1rem 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: sticky;
  top: 0;
  z-index: 100;
  background: #000;
  border-bottom: 1px solid #111;
  margin-bottom: 3rem;
}

.logo img {
  height: 64px;
  opacity: 0.9;
}

.nav {
  display: flex;
  gap: 0.25rem;
}

.nav-btn {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 1.25rem;
  font-weight: 500;
  padding: 0.5rem 0.9rem;
  border-radius: 6px;
  transition: color 0.15s, background 0.15s;
}

.nav-btn .icon { opacity: 0.7; }

.nav-btn:hover {
  color: #fff;
  background: #111;
}

.nav-btn.active {
  color: #fff;
  background: #fff;
  color: #000;
}

.nav-btn.active .icon { opacity: 1; }

/* ── Wallet ───────────────────────────────────────────────────────────────── */
.wallet-wrapper { display: flex; align-items: center; }

.select-wallet-btn {
  background: #000;
  color: #fff;
  border: none;
  padding: 0.5rem 1.3rem;
  border-radius: 6px;
  font-weight: 600;
  font-size: 1.25rem;
  cursor: pointer;
  transition: opacity 0.15s;
}

.select-wallet-btn:hover { opacity: 0.85; }

.connected-status {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  border: 1px solid #1e1e1e;
  padding: 0.45rem 0.9rem;
  border-radius: 6px;
}

.status-indicator {
  width: 5px;
  height: 5px;
  background: var(--green);
  border-radius: 50%;
}

.address-text {
  font-family: 'JetBrains Mono', 'SF Mono', monospace;
  font-size: 1.25rem;
  color: #aaa;
}

.disconnect-link {
  background: none;
  border: none;
  color: #555;
  font-size: 1.25rem;
  cursor: pointer;
  padding: 0;
  transition: color 0.15s;
}

.disconnect-link:hover { color: #aaa; }

/* ── Modal ───────────────────────────────────────────────────────────────── */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  width: 90%;
  max-width: 512px;
  padding: 1.75rem;
  background: #0c0c0c;
  border: 1px solid #1e1e1e;
  border-radius: 10px;
}

.modal-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin-bottom: 1.25rem;
  color: #aaa;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 1.25rem;
}

.wallet-select-modal { max-width: 380px; }
.wallet-list { display: flex; flex-direction: column; gap: 0.5rem; margin: 0.5rem 0 1rem; }

.wallet-option {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.85rem;
  padding: 0.75rem 1rem;
  background: #0e0e0e;
  border: 1px solid #1e1e1e;
  border-radius: 10px;
  color: #ccc;
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s, color 0.15s;
  text-align: left;
}
.wallet-option--detected {
  border-color: #1e3a1e;
  color: #fff;
}
.wallet-option:hover {
  background: #161616;
  border-color: #444;
  color: #fff;
}
.wallet-icon {
  width: 32px;
  height: 32px;
  border-radius: 8px;
  flex-shrink: 0;
}
.wallet-name { flex: 1; }
.wallet-badge {
  font-size: 0.65rem;
  letter-spacing: 0.08em;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  text-transform: uppercase;
}
.wallet-badge--detected { background: #0f2a0f; color: #22c55e; }
.wallet-badge--install  { background: #1a1a1a; color: #555; }

.modal-close {
  width: 100%;
  padding: 1rem;
  background: none;
  border: 1px solid #1e1e1e;
  color: #555;
  border-radius: 6px;
  margin-top: 0.25rem;
  cursor: pointer;
  font-size: 1.25rem;
  transition: color 0.15s, border-color 0.15s;
}

.modal-close:hover { color: #aaa; border-color: #555; }

.modal-actions {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  margin-top: 1.5rem;
}
.modal-actions > * { flex: 1; text-align: center; }
.vote-confirm-modal .modal-desc { margin: 0.4rem 0; }
.vote-confirm-warn { color: rgba(239, 68, 68, 0.75) !important; font-size: 0.82rem !important; }
.vote-confirm-human { color: #22c55e; }
.vote-confirm-bot   { color: #ef4444; }
.vote-confirm-comment {
  margin-top: 1rem;
  padding: 0.75rem 1rem;
  background: #0d0d0d;
  border: 1px solid #1e1e1e;
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.vote-confirm-comment-label {
  font-size: 0.7rem;
  letter-spacing: 0.1em;
  color: #555;
  text-transform: uppercase;
}
.vote-confirm-comment-text {
  font-size: 1.2rem;
  color: #555;
  font-style: italic;
  line-height: 1.5;
}
.mlist-feedback {
  font-size: 0.8rem;
  color: #555;
  font-style: italic;
  padding: 0.2rem 0 0.1rem;
  line-height: 1.4;
}

/* ── Hero ────────────────────────────────────────────────────────────────── */
.hero {
  text-align: center;
  padding: 3.5rem 0 4.5rem;
  max-width: 720px;
  margin: 0 auto;
}

.hero .title {
  font-size: clamp(2.5rem, 7.5vw, 4.06rem);
  line-height: 1.1;
  margin-bottom: 1.25rem;
  color: #fff;
  letter-spacing: -0.04em;
}

.hero .subtitle {
  font-size: 1.25rem;
  color: #555;
  max-width: 520px;
  margin: 0 auto;
  line-height: 1.7;
}

/* ── Error ───────────────────────────────────────────────────────────────── */
.error-msg {
  background: rgba(239,68,68,0.07);
  border: 1px solid rgba(239,68,68,0.2);
  color: #ef4444;
  padding: 1rem 1rem;
  border-radius: 6px;
  font-size: 1.44rem;
  margin-bottom: 1.25rem;
  cursor: pointer;
  max-width: 700px;
  margin-left: auto;
  margin-right: auto;
}

/* ── Content ─────────────────────────────────────────────────────────────── */
.content-section {
  max-width: 720px;
  margin: 0 auto 5rem;
  animation: fadeUp 0.3s ease-out;
  width: 100%;
}

@keyframes fadeUp {
  from { opacity: 0; transform: translateY(12px); }
  to   { opacity: 1; transform: translateY(0); }
}

/* ── Input Group ─────────────────────────────────────────────────────────── */
.input-group {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.premium-input,
.premium-select,
.premium-textarea {
  width: 100%;
  background: #080808;
  border: 1px solid #1e1e1e;
  border-radius: 7px;
  padding: 0.6rem 0.85rem;
  color: #e0e0e0;
  font-size: 1rem;
  line-height: 1.4;
  transition: border-color 0.15s, background 0.15s;
  font-family: inherit;
  box-sizing: border-box;
}

.premium-textarea {
  min-height: 80px;
  resize: none;
  overflow: hidden;
  line-height: 1.55;
}

.premium-input::placeholder,
.premium-textarea::placeholder { color: #555; }

.premium-input:focus,
.premium-select:focus,
.premium-textarea:focus {
  outline: none;
  border-color: #555;
  background: #0c0c0c;
}

.premium-select {
  cursor: pointer;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23444'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 0.75rem center;
  padding-right: 2rem;
}

.premium-select option { background: #111; }

.flex-input { display: flex; gap: 0.5rem; align-items: stretch; }

.file-label {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  flex-shrink: 0;
  background: #080808;
  border: 1px solid #1e1e1e;
  border-radius: 7px;
  cursor: pointer;
  color: #555;
  transition: color 0.15s, border-color 0.15s;
}

.file-label:hover { color: #aaa; border-color: #555; }
.hidden-input { display: none; }

.file-info {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 1rem;
  background: #080808;
  border: 1px solid #1e1e1e;
  border-radius: 6px;
}

.file-name { font-size: 1.25rem; color: #666; }

.chain-pill-row {
  padding-left: 0.1rem;
}

.chain-pill {
  display: inline-block;
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 0.2rem 0.6rem;
  border-radius: 4px;
  border: 1px solid;
}

.chain-pill--evm {
  color: #555;
  border-color: #222;
  background: #0a0a0a;
}

.chain-pill--solana {
  color: #7c4dbb;
  border-color: #2a1a44;
  background: #0c0810;
}

.resolved-display {
  font-size: 1.25rem;
  color: #555;
  padding-left: 0.25rem;
}

.resolved-address {
  font-family: 'JetBrains Mono', monospace;
  color: #888;
}

/* ── Mini button ─────────────────────────────────────────────────────────── */
.mini-btn {
  background: #080808;
  border: 1px solid #1e1e1e;
  color: #555;
  padding: 0.6rem 0.85rem;
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  font-size: 0.8rem;
  white-space: nowrap;
  flex-shrink: 0;
  align-self: flex-end;
}

.mini-btn:hover { color: #aaa; border-color: #555; }
.mini-btn:disabled { opacity: 0.3; cursor: not-allowed; }

/* ── ABI picker ──────────────────────────────────────────────────────────── */
.abi-picker {
  border: 1px solid #1e1e1e;
  border-radius: 7px;
  overflow: hidden;
  background: #080808;
}

.abi-picker-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid #1a1a1a;
}

.abi-picker-label {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #555;
}

.abi-picker-count { font-size: 0.72rem; color: #555; }

.abi-picker-list { max-height: 10rem; overflow-y: auto; }

.abi-fn-btn {
  width: 100%;
  text-align: left;
  padding: 0.5rem 0.9rem;
  background: none;
  border: none;
  border-bottom: 1px solid #111;
  color: #777;
  font-size: 0.8rem;
  font-family: 'JetBrains Mono', monospace;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;
}

.abi-fn-btn:last-child { border-bottom: none; }
.abi-fn-btn:hover { background: #111; color: #fff; }
.abi-fn-btn.selected { background: #111; color: #fff; }

/* ── Cards ───────────────────────────────────────────────────────────────── */
.card {
  padding: 1.25rem 1.5rem;
  margin-bottom: 0.5rem;
}

.section-title {
  font-size: 1.25rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #3a3a3a;
  margin-bottom: 1rem;
  font-weight: 600;
}

.card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1rem;
}

.method-desc {
  font-size: 1.56rem;
  color: #888;
  line-height: 1.4;
}

.card-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1.25rem;
  color: #3a3a3a;
}

.icon-success { color: var(--green); flex-shrink: 0; }
.icon-warning { color: var(--red); flex-shrink: 0; }

/* ── Badges ──────────────────────────────────────────────────────────────── */
.status-badge {
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  white-space: nowrap;
  flex-shrink: 0;
}

.status-badge.human {
  background: rgba(34,197,94,0.08);
  color: var(--green);
  border: 1px solid rgba(34,197,94,0.15);
}

.status-badge.ai {
  background: rgba(239,68,68,0.08);
  color: var(--red);
  border: 1px solid rgba(239,68,68,0.15);
}

/* ── Brain card ──────────────────────────────────────────────────────────── */
.brain-card {
  padding: 1.25rem 1.5rem;
  margin-bottom: 1rem;
  border-left: 2px solid #1e1e1e;
}

.brain-card.human { border-left-color: var(--green); }
.brain-card.ai    { border-left-color: var(--red); }

.brain-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.brain-label {
  font-size: 1.25rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-weight: 700;
  color: #555;
  margin-right: 10px;
}

.brain-reasoning {
  font-size: 1.44rem;
  color: #777;
  line-height: 1.5;
}

.brain-analyzing {
  font-size: 1.25rem;
  color: #555;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50%       { opacity: 1; }
}

/* ── Votes ───────────────────────────────────────────────────────────────── */
.queue-container { max-width: 520px; margin: 0 auto; }

.method-preview p { color: #666; font-size: 1.19rem; line-height: 1.6; }

.vote-btn-yes {
  background: var(--green) !important;
  color: #000 !important;
}

.vote-btn-no {
  background: var(--red) !important;
  color: #fff !important;
}

/* ── Footer bar ──────────────────────────────────────────────────────────── */
.footer {
  margin-top: auto;
}

.footer-content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: #555;
  font-size: 1.25rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

.site-footer {
  padding: 3.25rem 1.5rem;
}


/* ── Vote card ───────────────────────────────────────────────────────────── */
.vote-card {
  padding: 2rem;
}

.vote-queue-label {
  font-size: 1.25rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #555;
  font-weight: 700;
  margin-bottom: 1.5rem;
}

.method-preview {
  margin-bottom: 1.75rem;
}

.method-preview p {
  font-size: 1.19rem;
  color: #888;
  line-height: 1.6;
  margin-bottom: 1.25rem;
}

.vote-score-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.vote-score-label { font-size: 1.25rem; color: #555; }
.vote-score-value { font-size: 1.25rem; color: #666; font-variant-numeric: tabular-nums; }

.vote-actions {
  display: flex;
  gap: 1rem;
}

/* ── Empty state ─────────────────────────────────────────────────────────── */
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  padding: 5rem 0;
  color: #555;
  font-size: 1.56rem;
}

/* ── Header right group ──────────────────────────────────────────────────── */
.header-right {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

/* ── Hamburger ───────────────────────────────────────────────────────────── */
.hamburger {
  display: none;
  flex-direction: column;
  justify-content: center;
  gap: 5px;
  width: 36px;
  height: 36px;
  background: none;
  border: 1px solid #1e1e1e;
  border-radius: 6px;
  cursor: pointer;
  padding: 0 8px;
}

.hamburger span {
  display: block;
  height: 1.5px;
  background: #888;
  border-radius: 1px;
  transition: all 0.2s ease;
  transform-origin: center;
}

.hamburger.open span:nth-child(1) { transform: translateY(6.5px) rotate(45deg); }
.hamburger.open span:nth-child(2) { opacity: 0; transform: scaleX(0); }
.hamburger.open span:nth-child(3) { transform: translateY(-6.5px) rotate(-45deg); }

/* ── Mobile menu ─────────────────────────────────────────────────────────── */
.mobile-menu {
  display: none;
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0,0,0,0.6);
  backdrop-filter: blur(4px);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s;
}

.mobile-menu.open {
  opacity: 1;
  pointer-events: all;
}

.mobile-menu-inner {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(280px, 80vw);
  background: #000;
  border-left: 1px solid #1a1a1a;
  padding: 5rem 1.5rem 2rem;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  transform: translateX(100%);
  transition: transform 0.25s ease;
}

.mobile-menu.open .mobile-menu-inner {
  transform: translateX(0);
}

.mobile-nav-btn {
  background: none;
  border: none;
  color: #666;
  text-align: left;
  font-size: 1.38rem;
  font-weight: 500;
  padding: 0.75rem 0.5rem;
  cursor: pointer;
  border-radius: 6px;
  transition: color 0.15s, background 0.15s;
}

.mobile-nav-btn:hover { color: #fff; background: #0a0a0a; }
.mobile-nav-btn.active { color: #fff; font-weight: 600; }
.mobile-connect { color: #fff; margin-top: 0.25rem; }

.mobile-menu-divider {
  height: 1px;
  background: #111;
  margin: 0.5rem 0;
}

.mobile-wallet-status {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.75rem 0.5rem;
}

/* ── Responsive ──────────────────────────────────────────────────────────── */
@media (max-width: 680px) {
  .desktop-nav    { display: none; }
  .desktop-wallet { display: none; }
  .hamburger      { display: flex; }
  .mobile-menu    { display: block; }

  .landing-utilities { grid-template-columns: 1fr; }
  .how-grid { grid-template-columns: 1fr; }
  .form-row { flex-direction: column; }
  .form-col-sm { flex: unset; width: 100%; }
  .form-col-lg { flex: unset; width: 100%; }
  .profile-stats { grid-template-columns: 1fr 1fr; }
  .pricing-table .pt-row { grid-template-columns: 1fr; gap: 0.15rem; }
  .staking-grid { grid-template-columns: 1fr; }
}

/* ── Landing CTA row ─────────────────────────────────────────────────────── */
.landing-cta-row {
  display: flex;
  gap: 1rem;
  justify-content: center;
  flex-wrap: wrap;
  margin-top: 2rem;
}

.outline-btn {
  background: transparent;
  border: 1px solid #555;
  color: #888;
  padding: 1rem 2rem;
  border-radius: 6px;
  font-size: 1.0625rem;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}
.outline-btn:hover { border-color: #555; color: #ccc; }

/* ── Token economics ─────────────────────────────────────────────────────── */
.token-economics {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
  margin: 1.5rem 0 3.75rem 0;
}
.econ-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #111;
  gap: 1rem;
}
.econ-row:last-child { border-bottom: none; }
.econ-label { color: #555; font-size: 1rem; white-space: nowrap; }
.econ-val { color: #999; font-size: 1rem; text-align: right; }

/* ── Profile page ────────────────────────────────────────────────────────── */
.profile-page { max-width: 800px; margin: 0 auto; padding: 2rem 1rem 4rem; }

.profile-connect-prompt {
  text-align: center;
  padding: 3rem 1rem;
  border: 1px solid #1a1a1a;
  border-radius: 10px;
  margin-top: 2rem;
}
.prompt-text { color: #555; margin-bottom: 1.25rem; font-size: 1.0625rem; }

.profile-signup-card {
  border: 1px solid #1a1a1a;
  border-radius: 10px;
  padding: 2rem;
  margin-top: 1.5rem;
  text-align: center;
}
.signup-desc { color: #555; margin-bottom: 1.5rem; line-height: 1.6; }

.profile-error {
  background: #1a0000;
  border: 1px solid #330000;
  color: #ff4444;
  padding: 0.75rem 1rem;
  border-radius: 6px;
  margin-bottom: 1rem;
  font-size: 1.3rem;
}

.profile-stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1rem;
  margin: 1.5rem 0;
}
.pstat-card {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 1.25rem;
  text-align: center;
}
.pstat-card.deposit-stat { cursor: pointer; transition: border-color 0.2s; }
.pstat-card.deposit-stat:hover { border-color: #555; }
.pstat-deposit-hint { font-size: 0.7rem; color: #555; margin-left: 0.35rem; }
.pstat-val { font-size: 1.75rem; font-weight: 700; color: #fff; }
.pstat-label { font-size: 0.8125rem; color: #555; margin-top: 0.25rem; }

.vote-badge { font-size: 0.75rem; font-weight: 600; padding: 0.2rem 0.5rem; border-radius: 4px; }
.vote-human { color: #2aaa2a; background: #0a1a0a; }
.vote-bot   { color: #aa2a2a; background: #1a0a0a; }

.modal-desc { font-size: 1.2rem; color: #555; margin: 0.5rem 0 0; line-height: 1.5; }
.deposit-msg { font-size: 1rem; padding: 0.5rem; border-radius: 4px; margin-bottom: 0.75rem; }
.deposit-ok  { color: #2aaa2a; background: #0a1a0a; }
.deposit-err { color: #aa4444; background: #1a0a0a; }

.profile-card {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 1.25rem;
  margin-bottom: 1rem;
}
.profile-card-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 1rem;
}
.profile-card-title { font-size: 1.3rem; font-weight: 600; color: #ccc; }

.profile-claim-card { border-color: #1a3a1a; }
.claim-amount { font-size: 1rem; font-weight: 700; color: #5a8a5a; font-family: 'JetBrains Mono', monospace; }
.claim-btn { margin-top: 0.75rem; width: 100%; }
.profile-card-count {
  background: #111;
  border: 1px solid #222;
  color: #666;
  font-size: 0.8125rem;
  padding: 0.15rem 0.5rem;
  border-radius: 20px;
}
.faucet-bar {
  margin: 25px 0px;
}
.apikey-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: #050505;
  border: 1px solid #1a1a1a;
  border-radius: 6px;
  padding: 0.75rem;
  margin-bottom: 0.5rem;
}
.apikey-display {
  flex: 1;
  font-family: monospace;
  font-size: 1rem;
  color: #888;
  word-break: break-all;
}
.profile-hint { font-size: 0.8125rem; color: #555; margin-top: 0.5rem; }
.profile-hint code { background: #111; padding: 0.1rem 0.3rem; border-radius: 3px; color: #888; }

.profile-empty { color: #555; font-size: 1.3rem; display: flex; gap: 0.5rem; align-items: center; }

.method-list-profile { display: flex; flex-direction: column; gap: 0.5rem; }
.mlist-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 0.75rem;
  background: #050505;
  border: 1px solid #111;
  border-radius: 6px;
  gap: 1rem;
}
.mlist-main { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
.mlist-type {
  font-size: 0.6875rem;
  font-weight: 700;
  color: #555;
  background: #0c0c0c;
  border: 1px solid #1e1e1e;
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  white-space: nowrap;
}
.mlist-desc { font-size: 1.3rem; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mlist-meta { display: flex; flex-direction: column; align-items: flex-end; gap: 0.2rem; white-space: nowrap; }
.mlist-score { font-size: 0.8125rem; color: #555; }
.mlist-earned { font-size: 0.8125rem; color: #888; }

/* ── API page ────────────────────────────────────────────────────────────── */
.api-page { max-width: 900px; margin: 0 auto; padding: 2rem 1rem 4rem; }

.api-section { margin-bottom: 2.5rem; }
.api-section-title {
  font-size: 1.125rem;
  font-weight: 600;
  color: #ccc;
  margin-bottom: 1rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #1a1a1a;
  font-family: monospace;
}
.api-card {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
}
.api-desc {
  padding: 1rem 1.25rem;
  color: #666;
  font-size: 1.3rem;
  line-height: 1.6;
  border-bottom: 1px solid #111;
}
.api-desc code { background: #111; padding: 0.1rem 0.3rem; border-radius: 3px; color: #888; font-size: 1rem; }
.api-params { padding: 0.75rem 1.25rem; border-bottom: 1px solid #111; display: flex; flex-direction: column; gap: 0.4rem; }
.param-row { display: flex; align-items: baseline; gap: 0.75rem; font-size: 1.2rem; }
.param-row code { color: #fff; font-size: 1rem; background: #0c0c0c; border: 1px solid #1e1e1e; padding: 0.1rem 0.35rem; border-radius: 3px; white-space: nowrap; }
.param-row span { color: #555; }

.code-block { border-top: 1px solid #111; }
.code-lang {
  padding: 0.35rem 1.25rem;
  font-size: 0.75rem;
  color: #555;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  background: #050505;
  border-bottom: 1px solid #0d0d0d;
}
.code-pre {
  margin: 0;
  padding: 1rem 1.25rem;
  background: #030303;
  color: #888;
  font-size: 1rem;
  font-family: monospace;
  white-space: pre-wrap;
  word-break: break-all;
}

.pricing-table {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  overflow: hidden;
}
.pt-row {
  display: grid;
  grid-template-columns: 1fr 1fr 1.2fr;
  padding: 0.75rem 1.25rem;
  border-bottom: 1px solid #111;
  font-size: 1.3rem;
  gap: 1rem;
}
.pt-row:last-child { border-bottom: none; }
.pt-head { font-size: 0.8125rem; font-weight: 600; color: #555; text-transform: uppercase; letter-spacing: 0.05em; background: #050505; }
.pt-free { background: #0a0f0a; color: #5a8a5a; }
.pt-row span:nth-child(2) { color: #aaa; }
.pt-row span:nth-child(3) { color: #555; }

.api-cta {
  text-align: center;
  padding: 2rem;
  color: #555;
  font-size: 1.0625rem;
}

/* ── Staking page ────────────────────────────────────────────────────────── */
.staking-page { max-width: 900px; margin: 0 auto; padding: 2rem 1rem 4rem; }

.staking-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
  margin-bottom: 2rem;
}
.staking-info-card {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 1.5rem;
}
.si-title { font-size: 1rem; font-weight: 600; color: #ccc; margin-bottom: 1rem; }
.si-list { padding-left: 1.25rem; display: flex; flex-direction: column; gap: 0.6rem; }
.si-list li { color: #666; font-size: 1.3rem; line-height: 1.5; }

.stake-form-card {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 1.5rem;
}
.stake-form-title { font-size: 1.0625rem; font-weight: 600; color: #ccc; margin-bottom: 1.25rem; }
.stake-message { margin-top: 0.75rem; font-size: 1.3rem; color: #888; }

/* ── Stake balance row ───────────────────────────────────────────────────── */
.stake-balance-row {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.75rem;
  margin-bottom: 1.5rem;
}
.sbal-item {
  background: #050505;
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 1rem 0.75rem;
  text-align: center;
}
.sbal-val { font-size: 1.25rem; font-weight: 700; color: #fff; }
.sbal-label { font-size: 0.75rem; color: #555; margin-top: 0.2rem; }
.sbal-claimable .sbal-val { color: #5a8a5a; }

.stake-action-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.max-btn {
  background: none;
  border: 1px solid #222;
  color: #555;
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.4rem 0.6rem;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  transition: border-color 0.15s, color 0.15s;
}
.max-btn:hover { border-color: #555; color: #aaa; }

.stake-claim-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: #0a0f0a;
  border: 1px solid #1a2a1a;
  border-radius: 8px;
  padding: 1rem 1rem;
  margin-top: 0.5rem;
  margin-bottom: 0.75rem;
}
.claim-desc { font-size: 1.3rem; color: #5a8a5a; }

/* ── Listing fee row ─────────────────────────────────────────────────────── */
.listing-fee-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 0;
  font-size: 1.3rem;
}
.listing-fee-label { color: #888; }
.listing-fee-balance { color: #666; }
.listing-fee-balance.insufficient { color: #aa4444; }

@media (max-width: 680px) {
  .stake-balance-row { grid-template-columns: 1fr 1fr; }
  .stake-action-row { flex-wrap: wrap; }
  .stake-claim-row { flex-direction: column; align-items: flex-start; }
}
</style>
