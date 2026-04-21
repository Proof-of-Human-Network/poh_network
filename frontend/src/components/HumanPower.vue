<script setup>
import { ref, computed, onMounted } from 'vue'
import axios from 'axios'
import {
  Search, PlusSquare, Vote, ShieldCheck,
  Activity, Trash2, FileUp
} from 'lucide-vue-next'
import { 
  Connection, 
  PublicKey, 
  Transaction, 
  SystemProgram, 
  LAMPORTS_PER_SOL 
} from '@solana/web3.js'
// import {
//   createBurnInstruction,
//   getAssociatedTokenAddress
// } from '@solana/spl-token'

// ── Wallet State ─────────────────────────────────────────────────────────────
const walletAddress = ref(null)      // string | null
const walletProvider = ref(null)     // the raw provider object
const showWalletModal = ref(false)
const currentSection = ref('landing')

const connected = computed(() => !!walletAddress.value)

const shortAddress = computed(() => {
  if (!walletAddress.value) return ''
  return `${walletAddress.value.slice(0, 4)}...${walletAddress.value.slice(-4)}`
})

function getPhantomProvider() {
  if ('phantom' in window && window.phantom?.solana?.isPhantom) {
    return window.phantom.solana
  }
  return null
}

function getSolflareProvider() {
  if ('solflare' in window && window.solflare?.isSolflare) {
    return window.solflare
  }
  return null
}

async function connectWallet(type) {
  showWalletModal.value = false
  try {
    let provider = null
    if (type === 'phantom') {
      provider = getPhantomProvider()
      if (!provider) {
        window.open('https://phantom.app/', '_blank')
        return
      }
    } else if (type === 'solflare') {
      provider = getSolflareProvider()
      if (!provider) {
        window.open('https://solflare.com/', '_blank')
        return
      }
    }

    const resp = await provider.connect()
    const address = resp.publicKey.toString()
    walletAddress.value = address
    walletProvider.value = provider
    console.log('[wallet] Connected:', address)

    // Listen for disconnect
    provider.on('disconnect', () => {
      walletAddress.value = null
      walletProvider.value = null
      console.log('[wallet] Disconnected')
    })
    // Listen for account change
    provider.on('accountChanged', (pk) => {
      if (pk) {
        walletAddress.value = pk.toString()
      } else {
        walletAddress.value = null
        walletProvider.value = null
      }
    })
  } catch (err) {
    error.value = `Connection failed: ${err.message}`
    console.error(err)
  }
}

async function disconnectWallet() {
  try {
    await walletProvider.value?.disconnect()
  } catch {}
  walletAddress.value = null
  walletProvider.value = null
}

// ── Config ────────────────────────────────────────────────────────────────────
const VOTE_MINT = ref('')
const FEE_RECIPIENT = ref('')
const SOLANA_RPC = ref('https://api.devnet.solana.com')

const fetchConfig = async () => {
  try {
    const res = await axios.get('/config')
    VOTE_MINT.value = res.data.VOTE_MINT
    FEE_RECIPIENT.value = res.data.FEE_RECIPIENT
    SOLANA_RPC.value = res.data.SOLANA_RPC
  } catch (err) {
    console.error('Failed to fetch config', err)
  }
}

// ── UI State ──────────────────────────────────────────────────────────────────
const loading = ref(false)
const error = ref(null)
const mobileMenuOpen = ref(false)
const showSection = (id) => { currentSection.value = id; mobileMenuOpen.value = false }

// ── Helpers ───────────────────────────────────────────────────────────────────
async function signAndSendTransaction(transaction) {
  if (!walletProvider.value) throw new Error('Wallet not connected')
  const provider = walletProvider.value
  const connection = new Connection(SOLANA_RPC.value, 'confirmed')

  const { blockhash } = await connection.getLatestBlockhash()
  transaction.recentBlockhash = blockhash
  transaction.feePayer = new PublicKey(walletAddress.value)

  const signed = await provider.signTransaction(transaction)
  const txHash = await connection.sendRawTransaction(signed.serialize())
  await connection.confirmTransaction(txHash, 'confirmed')
  return txHash
}

// ── 1. Checker ────────────────────────────────────────────────────────────────
const scanInput = ref('')
const resolvedInputDisplay = ref('')
const checkerResults = ref(null)
const brainVerdict = ref(null)
const brainPolling = ref(false)
const batchFile = ref(null)
const batchRowCount = ref(0)
const batchRows = ref([])   // raw parsed rows from CSV
const isResolving = ref(false)

function isWalletAddress(input) {
  if (!input) return false
  if (/^0x[0-9a-fA-F]{40}$/.test(input)) return true          // EVM
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) return true // Solana base58
  return false
}

async function resolveToAddress(input) {
  const trimmed = input.trim()
  if (isWalletAddress(trimmed)) return trimmed
  // Try Space ID resolution
  const res = await axios.get('https://nameapi.space.id/getAddress', { params: { domain: trimmed } })
  if (res.data.code === 0 && res.data.address) return res.data.address
  throw new Error(`Could not resolve "${trimmed}" — not a valid address or Space ID`)
}

const handleFileSelect = (event) => {
  const file = event.target.files[0]
  if (file) {
    batchFile.value = file
    const reader = new FileReader()
    reader.onload = (e) => {
      const lines = e.target.result.split('\n').filter(r => r.trim())
      const rows = lines.slice(1) // skip header
      batchRows.value = rows.map(r => r.split(',')[0].trim().replace(/^"(.*)"$/, '$1'))
      batchRowCount.value = rows.length
    }
    reader.readAsText(file)
  }
}

const runCheck = async () => {
  if (!connected.value) { error.value = 'Please connect your wallet first'; return }
  loading.value = true
  isResolving.value = true
  error.value = null
  resolvedInputDisplay.value = ''
  try {
    // ── Resolve addresses (Space ID support) ──────────────────────────────
    let resolvedInputs = []
    if (batchFile.value) {
      resolvedInputs = await Promise.all(batchRows.value.map(resolveToAddress))
    } else {
      const resolved = await resolveToAddress(scanInput.value)
      if (resolved !== scanInput.value.trim()) {
        resolvedInputDisplay.value = resolved
      }
      resolvedInputs = [resolved]
    }
    isResolving.value = false

    // ── Burn VOTE tokens ──────────────────────────────────────────────────
    // const connection = new Connection(SOLANA_RPC.value, 'confirmed')
    // const count = resolvedInputs.length
    // if (!VOTE_MINT.value || VOTE_MINT.value.startsWith('YOUR_')) throw new Error('VOTE_MINT not configured on server — set VOTE_TOKEN_MINT in .env')
    // const mintPubkey = new PublicKey(VOTE_MINT.value)
    // const walletPubkey = new PublicKey(walletAddress.value)
    // const ata = await getAssociatedTokenAddress(mintPubkey, walletPubkey)
    // const tx = new Transaction().add(
    //   createBurnInstruction(ata, mintPubkey, walletPubkey, count * 1e9)
    // )
    // const txHash = await signAndSendTransaction(tx)
    const txHash = 'MOCK_BURN'

    // ── Build form data with resolved addresses ───────────────────────────
    const formData = new FormData()
    if (batchFile.value) {
      const header = 'address\n'
      const csvContent = header + resolvedInputs.join('\n')
      const blob = new Blob([csvContent], { type: 'text/csv' })
      formData.append('csv', blob, 'resolved.csv')
    } else {
      formData.append('input', resolvedInputs[0])
    }
    formData.append('walletAddress', walletAddress.value)
    formData.append('txHash', txHash)

    const res = await axios.post('/checker', formData)
    checkerResults.value = res.data.result
    brainVerdict.value = null

    // Poll for brain verdict in background
    const brainKey = res.data.brainKey
    if (brainKey) {
      brainPolling.value = true
      const poll = setInterval(async () => {
        try {
          const b = await axios.get(`/checker/brain/${encodeURIComponent(brainKey)}`)
          if (b.data.status === 'done' || b.data.status === 'error') {
            brainVerdict.value = b.data
            brainPolling.value = false
            clearInterval(poll)
          }
        } catch { clearInterval(poll); brainPolling.value = false }
      }, 4000)
      // Stop polling after 3 minutes regardless
      setTimeout(() => { clearInterval(poll); brainPolling.value = false }, 180000)
    }
  } catch (err) {
    error.value = err.message || 'Scan failed'
    isResolving.value = false
  } finally {
    loading.value = false
  }
}

// ── 2. Listing ────────────────────────────────────────────────────────────────
const listing = ref({ type: 'evm', chainId: 1, address: '', method: '', abiTypes: '', returnTypes: '', decimals: '', expression: '', lang: 'js', description: '', body: '', httpMethod: 'GET' })
const headers = ref([{ key: '', value: '' }])
const addHeader = () => headers.value.push({ key: '', value: '' })
const removeHeader = (i) => headers.value.splice(i, 1)

// ABI / IDL picker
const abiFns = ref([])        // [{name, abiTypes, returnTypes, inputs, outputs}]
const abiLoading = ref(false)
const abiError = ref(null)

async function fetchAbi() {
  const addr = listing.value.address?.trim()
  if (!addr || listing.value.type === 'rest') return
  abiLoading.value = true
  abiError.value = null
  abiFns.value = []
  try {
    if (listing.value.type === 'evm') {
      const res = await axios.get(`/abi/evm?address=${addr}&chainId=${listing.value.chainId}`)
      abiFns.value = res.data.abi || []
      if (!abiFns.value.length) abiError.value = 'No functions found in ABI'
    } else if (listing.value.type === 'solana') {
      const res = await axios.get(`/abi/solana?programId=${addr}`)
      // Map instructions to picker format
      abiFns.value = (res.data.instructions || []).map(ix => ({
        name: ix.name,
        abiTypes: JSON.stringify(ix.args?.map(a => a.type) || []),
        returnTypes: '[]',
        inputs: ix.args || [],
        outputs: [],
        isInstruction: true
      }))
      if (!abiFns.value.length) abiError.value = res.data.note || 'No IDL found for this program'
    }
  } catch (err) {
    abiError.value = err.response?.data?.error || 'Could not fetch ABI'
  } finally {
    abiLoading.value = false
  }
}

function pickMethod(fn) {
  listing.value.method = fn.name
  listing.value.abiTypes = fn.abiTypes
  listing.value.returnTypes = fn.returnTypes
  // Build expression hint
  if (!fn.isInstruction) {
    const returns = JSON.parse(fn.returnTypes || '[]')
    if (returns[0] === 'uint256' || returns[0] === 'uint128') {
      listing.value.expression = 'result[0] > 0n'
    } else if (returns[0] === 'bool') {
      listing.value.expression = 'result[0] === true'
    } else if (returns[0] === 'address') {
      listing.value.expression = 'result[0] !== "0x0000000000000000000000000000000000000000"'
    } else {
      listing.value.expression = 'result[0] > 0n'
    }
  }
}

const submitListing = async () => {
  if (!connected.value) { error.value = 'Please connect wallet to pay 0.01 SOL fee'; return }
  loading.value = true
  try {
    if (!FEE_RECIPIENT.value || FEE_RECIPIENT.value.startsWith('YOUR_')) throw new Error('FEE_RECIPIENT not configured on server — set FEE_RECIPIENT in .env')
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(walletAddress.value),
        toPubkey: new PublicKey(FEE_RECIPIENT.value),
        lamports: 0.01 * LAMPORTS_PER_SOL
      })
    )
    const txHash = await signAndSendTransaction(tx)
    const headerObj = headers.value.reduce((a, h) => { if (h.key) a[h.key] = h.value; return a }, {})
    const payload = { ...listing.value, headers: JSON.stringify(headerObj), txHash, walletAddress: walletAddress.value }
    // For REST, the backend uses `method` as the HTTP verb
    if (listing.value.type === 'rest') payload.method = listing.value.httpMethod
    await axios.post('/methods/listing', payload)
    alert('Listing successfully registered')
    listing.value = { type: 'evm', chainId: 1, address: '', method: '', abiTypes: '', returnTypes: '', decimals: '', expression: '', lang: 'js', description: '', body: '', httpMethod: 'GET' }
    headers.value = [{ key: '', value: '' }]
  } catch (err) {
    error.value = err.message || 'Payment or Registration failed'
  } finally {
    loading.value = false
  }
}

// ── 3. Votes ──────────────────────────────────────────────────────────────────
const votingList = ref([])
const voteIndex = ref(0)
const voteSubmitting = ref(false)
const currentVoteItem = computed(() => votingList.value[voteIndex.value] ?? null)

const loadVoting = async () => {
  loading.value = true
  try {
    const res = await axios.get('/methods/verifyer')
    votingList.value = res.data.sort((a, b) => (a.score || 0) - (b.score || 0))
    voteIndex.value = 0
  } catch (err) {
    error.value = 'Failed to load voting queue'
  } finally {
    loading.value = false
  }
}

const castVote = async (voteVal) => {
  if (voteVal === 'skip') { voteIndex.value++; return }
  if (!connected.value) { error.value = 'Connect wallet to vote'; return }
  voteSubmitting.value = true
  try {
    if (!FEE_RECIPIENT.value || FEE_RECIPIENT.value.startsWith('YOUR_')) throw new Error('FEE_RECIPIENT not configured')
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: new PublicKey(walletAddress.value),
        toPubkey: new PublicKey(FEE_RECIPIENT.value),
        lamports: 0.001 * LAMPORTS_PER_SOL
      })
    )
    const txHash = await signAndSendTransaction(tx)
    await axios.post('/methods/verifyer/vote', {
      methodId: currentVoteItem.value.id, vote: voteVal, type: 'method',
      walletAddress: walletAddress.value, txHash
    })
    voteIndex.value++
  } catch (err) {
    error.value = err.message || 'Vote failed'
  } finally {
    voteSubmitting.value = false
  }
}

// ── Network graph (static illustrative layout) ────────────────────────────
const gW = 700, gH = 340

const graphNodes = [
  // Brain — center
  { id: 'brain',   kind: 'brain',  label: 'AI Brain',     x: 350, y: 170, r: 28 },
  // EVM methods
  { id: 'evm1',    kind: 'evm',    label: 'ETH Balance',  x: 120, y:  70, r: 14 },
  { id: 'evm2',    kind: 'evm',    label: 'TX Count',     x:  70, y: 180, r: 14 },
  { id: 'evm3',    kind: 'evm',    label: 'USDC Hold',    x: 155, y: 280, r: 14 },
  // Solana methods
  { id: 'sol1',    kind: 'solana', label: 'SOL Balance',  x: 580, y:  65, r: 14 },
  { id: 'sol2',    kind: 'solana', label: 'SPL Token',    x: 635, y: 180, r: 14 },
  // REST methods
  { id: 'rest1',   kind: 'rest',   label: 'Farcaster',    x: 260, y:  35, r: 14 },
  { id: 'rest2',   kind: 'rest',   label: 'ENS',          x: 440, y:  35, r: 14 },
  { id: 'rest3',   kind: 'rest',   label: 'Snapshot',     x: 560, y: 290, r: 14 },
  // Wallet outputs
  { id: 'w1',      kind: 'wallet', label: 'HUMAN',        x: 230, y: 310, r: 10 },
  { id: 'w2',      kind: 'wallet', label: 'BOT',          x: 460, y: 310, r: 10 },
]

const graphEdges = [
  // methods → brain
  ...['evm1','evm2','evm3','sol1','sol2','rest1','rest2','rest3'].map((id) => {
    const n = graphNodes.find(n => n.id === id)
    const b = graphNodes.find(n => n.id === 'brain')
    return { id: `e-${id}`, x1: n.x, y1: n.y, x2: b.x, y2: b.y }
  }),
  // brain → outputs
  { id: 'e-w1', x1: 350, y1: 170, x2: 230, y2: 310 },
  { id: 'e-w2', x1: 350, y1: 170, x2: 460, y2: 310 },
]

onMounted(async () => {
  await fetchConfig()
  if (currentSection.value === 'votes') loadVoting()
})
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div @click="showSection('landing')" class="logo">
        <img src="/assetux-icon.png" alt="POH Logo">
      </div>

      <!-- Desktop nav -->
      <nav class="nav desktop-nav">
        <button :class="['nav-btn', { active: currentSection === 'checker' }]" @click="showSection('checker')">
          <Search class="icon" :size="14" /> Scan
        </button>
        <button :class="['nav-btn', { active: currentSection === 'listing' }]" @click="showSection('listing')">
          <PlusSquare class="icon" :size="14" /> List
        </button>
        <button :class="['nav-btn', { active: currentSection === 'votes' }]" @click="showSection('votes'); loadVoting()">
          <Vote class="icon" :size="14" /> Vote
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
        <button :class="['mobile-nav-btn', { active: currentSection === 'listing' }]" @click="showSection('listing')">List</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'votes' }]" @click="showSection('votes'); loadVoting()">Vote</button>
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

    <!-- Wallet Selection Modal -->
    <div v-if="showWalletModal" class="modal-overlay" @click.self="showWalletModal = false">
      <div class="glass-panel modal">
        <h3 class="modal-title">Select Wallet</h3>
        <button class="wallet-option" @click="connectWallet('phantom')">
          Phantom
        </button>
        <button class="wallet-option" @click="connectWallet('solflare')">
          Solflare
        </button>
        <button class="modal-close" @click="showWalletModal = false">Cancel</button>
      </div>
    </div>

    <main class="main">
      <div v-if="error" class="error-msg" @click="error = null">{{ error }}</div>

      <!-- Landing -->
      <div v-if="currentSection === 'landing'" class="landing">
        <section class="landing-hero">
          <div class="landing-tag">PROOF OF HUMAN</div>
          <h1 class="landing-title">Decentralized<br>Human Verification</h1>
          <p class="landing-sub">On-chain evidence.<br>Community-powered detection of real wallets.</p>
          <button class="neon-btn landing-cta" @click="showSection('checker')">Start Scanning →</button>
        </section>

        <div class="landing-divider"></div>

        <section class="landing-utilities">
          <div class="utility-card">
            <div class="utility-icon"><Search :size="20" /></div>
            <div class="utility-name">Scan</div>
            <div class="utility-desc">Verify any EVM or Solana wallet against all registered detection methods. Get an instant AI verdict on human vs bot probability.</div>
            <button class="utility-link" @click="showSection('checker')">Open Scanner →</button>
          </div>
          <div class="utility-card">
            <div class="utility-icon"><PlusSquare :size="20" /></div>
            <div class="utility-name">List</div>
            <div class="utility-desc">Submit a new on-chain detection method — smart contract call, Solana program, or REST API. Pay 0.01 SOL. Earn rewards when your method is used.</div>
            <button class="utility-link" @click="showSection('listing')">Submit Method →</button>
          </div>
          <div class="utility-card">
            <div class="utility-icon"><Vote :size="20" /></div>
            <div class="utility-name">Vote</div>
            <div class="utility-desc">Review submitted methods in the consensus queue. Your VOTE stake weight determines your influence. Curate signal from noise.</div>
            <button class="utility-link" @click="showSection('votes'); loadVoting()">Open Queue →</button>
          </div>
        </section>

        <div class="landing-divider"></div>

        <!-- Network graph -->
        <section class="network-section">
          <div class="network-label">DETECTION NETWORK</div>
          <div class="network-graph">
            <svg class="network-svg" :viewBox="`0 0 ${gW} ${gH}`" preserveAspectRatio="xMidYMid meet">
              <!-- edges -->
              <line v-for="e in graphEdges" :key="e.id"
                :x1="e.x1" :y1="e.y1" :x2="e.x2" :y2="e.y2"
                class="g-edge" />
              <!-- nodes -->
              <g v-for="n in graphNodes" :key="n.id" :transform="`translate(${n.x},${n.y})`">
                <circle :r="n.r" :class="['g-node', `g-node--${n.kind}`]" />
                <text class="g-label" :y="n.r + 12" text-anchor="middle">{{ n.label }}</text>
              </g>
            </svg>
          </div>
          <div class="network-legend">
            <div class="nl-item"><span class="nl-dot nl-dot--brain"></span>AI Brain</div>
            <div class="nl-item"><span class="nl-dot nl-dot--evm"></span>EVM Method</div>
            <div class="nl-item"><span class="nl-dot nl-dot--solana"></span>Solana Method</div>
            <div class="nl-item"><span class="nl-dot nl-dot--rest"></span>REST Method</div>
            <div class="nl-item"><span class="nl-dot nl-dot--wallet"></span>Wallet</div>
          </div>
        </section>

        <div class="landing-divider"></div>

        <section class="landing-token">
          <div class="token-header">
            <span class="token-ticker">$VOTE</span>
            <span class="token-label">Network Token</span>
          </div>
          <p class="token-desc">Fair launch via bonding curve. No VC rounds. No pre-mine. Tokens unlock utility across the entire verification stack.</p>

          <div class="token-split">
            <div class="split-row">
              <span class="split-label">Community Reward Pool</span>
              <span class="split-pct">80%</span>
            </div>
            <div class="split-bar"><div class="split-fill" style="width:80%"></div></div>
            <div class="split-note">Distributed via bonding curve, scan fees, and staking rewards</div>

            <div class="split-row" style="margin-top:1.25rem">
              <span class="split-label">Team &amp; Contributors</span>
              <span class="split-pct">20%</span>
            </div>
            <div class="split-bar"><div class="split-fill" style="width:20%; background:#333"></div></div>
            <div class="split-note">1 month cliff · 6 month linear vesting</div>
          </div>

          <div class="token-features">
            <div class="token-feat">Bonding Curve Fair Launch</div>
            <div class="token-feat">Scan Fee Burn</div>
            <div class="token-feat">Stake-Weighted Voting</div>
            <div class="token-feat">Method Reward Distribution</div>
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
          <div v-if="resolvedInputDisplay" class="resolved-display">
            ↳ <span class="resolved-address">{{ resolvedInputDisplay }}</span>
          </div>
          <div v-if="batchFile" class="file-info">
            <span class="file-name">{{ batchFile.name }} — {{ batchRowCount }} addresses</span>
            <button @click="batchFile = null; batchRowCount = 0; batchRows = []" class="mini-btn"><Trash2 :size="12" /></button>
          </div>
          <button @click="runCheck" :disabled="loading || (!scanInput && !batchFile)" class="scan-btn">
            {{ isResolving ? 'Resolving...' : loading ? 'Scanning...' : batchFile ? 'Scan Batch' : 'Scan Wallet' }}
          </button>
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

        <div v-if="checkerResults" class="results-list">
          <div class="results-header">
            <span class="section-title">Evidence — {{ checkerResults.filter(r => r.result).length }}/{{ checkerResults.length }} passed</span>
          </div>
          <div v-for="res in checkerResults" :key="res.methodId" class="result-row">
            <div class="result-dot" :class="res.result ? 'pass' : 'fail'"></div>
            <span class="result-desc">{{ res.description }}</span>
            <span :class="['status-badge', res.result ? 'human' : 'ai']">{{ res.result ? 'PASS' : 'FAIL' }}</span>
          </div>
        </div>
      </div>

      <!-- Listing -->
      <div v-if="currentSection === 'listing'" class="content-section">
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
            <textarea v-model="listing.description" placeholder="What does this method detect? What constitutes human evidence?" class="premium-textarea" rows="2"></textarea>
            <button @click="submitListing" :disabled="loading || !listing.description" class="neon-btn">
              {{ loading ? 'Confirming...' : 'Submit Method — 0.01 SOL' }}
            </button>
          </div>
        </div>
      </div>

      <!-- Votes -->
      <div v-if="currentSection === 'votes'" class="votes-page">
        <div class="votes-header">
          <div class="scan-tag">CONSENSUS QUEUE</div>
          <h2 class="scan-title">Review detection methods</h2>
          <p class="scan-sub">Vote on whether each method reliably distinguishes humans from bots. Your VOTE stake weight determines your influence.</p>
        </div>

        <div v-if="loading" class="empty-state"><p>Loading...</p></div>

        <div v-else-if="!currentVoteItem" class="empty-state">
          <ShieldCheck :size="28" />
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

            <div class="vcs-actions">
              <button class="vcs-btn vcs-btn-yes" :disabled="voteSubmitting" @click="castVote(true)">
                {{ voteSubmitting ? '...' : '✓ Legitimate' }}
              </button>
              <button class="vcs-btn vcs-btn-no" :disabled="voteSubmitting" @click="castVote(false)">
                ✗ Malicious
              </button>
              <button class="vcs-btn vcs-btn-skip" @click="castVote('skip')">
                Skip →
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>

    <footer class="footer">
      <div class="footer-content">
        <Activity :size="14" />
        <span>POWERED BY HUMAN CONSENSUS ENGINE</span>
      </div>
    </footer>
  </div>
</template>

<style scoped>
/* ── Landing ─────────────────────────────────────────────────────────────── */
.landing {
  max-width: 1280px;
  margin: 0 auto 4rem;
  padding: 0 0 2rem;
}

.landing-hero {
  padding: 10rem 0 10rem;
  text-align: center;
}

.landing-tag {
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: #444;
  text-transform: uppercase;
  margin-bottom: 1.5rem;
}

.landing-title {
  font-size: clamp(2.2rem, 6vw, 3.5rem);
  font-weight: 700;
  letter-spacing: -0.04em;
  line-height: 1.05;
  color: #fff;
  margin: 3rem 0;
}

.landing-sub {
  font-size: 1rem;
  color: #555;
  line-height: 1.7;
  margin-bottom: 2rem;
}

.landing-cta {
  font-size: 1.25rem;
  padding: 1rem 1.75rem;
}

.landing-divider {
  height: 1px;
  background: #111;
  margin: 0.5rem 0 3rem;
}

/* Utilities grid */
.landing-utilities {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
  background: #111;
  border: 1px solid #111;
  border-radius: 8px;
  overflow: hidden;
  margin: 10rem 0;
}

.utility-card {
  background: #000;
  padding: 1.75rem 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

.utility-icon { color: #fff; }

.utility-name {
  font-size: 1rem;
  font-weight: 600;
  color: #fff;
  letter-spacing: -0.02em;
}

.utility-desc {
  font-size: 1rem;
  color: #555;
  line-height: 1.6;
  flex-grow: 1;
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
  margin-top: 0.25rem;
}

.utility-link:hover { color: #fff; }

/* Token section */
.landing-token {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 2rem;
  margin: 10rem 0;
}

.token-header {
  display: flex;
  align-items: baseline;
  gap: 1rem;
  margin-bottom: 1rem;
}

.token-ticker {
  font-size: 1.3rem;
  font-weight: 700;
  color: #fff;
  letter-spacing: -0.02em;
}

.token-label {
  font-size: 1rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #444;
}

.token-desc {
  font-size: 1.15rem;
  color: #555;
  line-height: 1.6;
  margin-bottom: 1.75rem;
}

.token-split { margin-bottom: 1.75rem; }

.split-row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 0.4rem;
}

.split-label { font-size: 1rem; color: #888; }
.split-pct { font-size: 0.9rem; font-weight: 600; color: #fff; font-variant-numeric: tabular-nums; }

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
  font-size: 1rem;
  color: #3a3a3a;
}

.token-features {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.token-feat {
  font-size: 1rem;
  color: #555;
  border: 1px solid #1a1a1a;
  border-radius: 4px;
  padding: 0.3rem 1rem;
}

/* ── Network graph ───────────────────────────────────────────────────────── */
.network-section {
  margin-bottom: 3rem;
}

.network-label {
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: #333;
  text-transform: uppercase;
  margin-bottom: 1rem;
  text-align: center;
}

.network-graph {
  border: 1px solid #111;
  border-radius: 8px;
  overflow: hidden;
  background: #000;
  width: 100%;
}

.network-svg {
  display: block;
  width: 100%;
  height: auto;
}

.g-edge {
  stroke: #1a1a1a;
  stroke-width: 1;
}

.g-node {
  stroke-width: 1.5;
  fill: #000;
}

.g-node--brain  { r: 28; fill: #fff;  stroke: #fff; }
.g-node--evm    { fill: #0a0a0a; stroke: #2a2a2a; }
.g-node--solana { fill: #0a0a0a; stroke: #9945ff44; }
.g-node--rest   { fill: #0a0a0a; stroke: #1a1a1a; }
.g-node--wallet { fill: #111; stroke: #333; }

.g-label {
  font-size: 9px;
  fill: #444;
  font-family: -apple-system, sans-serif;
  pointer-events: none;
}

.network-legend {
  display: flex;
  justify-content: center;
  gap: 1.5rem;
  margin-top: 0.75rem;
  flex-wrap: wrap;
}

.nl-item {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 1rem;
  color: #444;
}

.nl-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.nl-dot--brain  { background: #fff; }
.nl-dot--evm    { background: #444; border: 1px solid #555; }
.nl-dot--solana { background: #1a0033; border: 1px solid #9945ff66; }
.nl-dot--rest   { background: #111; border: 1px solid #2a2a2a; }
.nl-dot--wallet { background: #222; border: 1px solid #333; }

/* ── Form sections (Listing) ─────────────────────────────────────────────── */
.form-section {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 1.25rem 1.5rem;
  margin-bottom: 1rem;
}

.form-label-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.9rem;
}

.form-section-label {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #444;
}

.field-label {
  display: block;
  font-size: 0.75rem;
  color: #555;
  margin-bottom: 0.4rem;
}

.field-hint-inline {
  color: #333;
  font-weight: 400;
  margin-left: 0.35rem;
  font-size: 1rem;
}

.field-hint { font-size: 0.75rem; color: #555; margin-top: 0.25rem; }
.field-hint--warn { color: #888; }

.type-tabs {
  display: flex;
  gap: 0.25rem;
  flex-wrap: wrap;
}

.type-tab {
  background: none;
  border: 1px solid #1a1a1a;
  color: #555;
  padding: 0.45rem 0.9rem;
  border-radius: 5px;
  font-size: 0.8rem;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.type-tab:hover { border-color: #333; color: #aaa; }
.type-tab.active { background: #fff; color: #000; border-color: #fff; font-weight: 600; }

.form-row {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  min-width: 0;
}

.form-col { flex: 1; min-width: 0; }
.form-col-sm { flex: 0 0 130px; min-width: 0; }
.form-col-lg { flex: 2; min-width: 0; }

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
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: #444;
  text-transform: uppercase;
  margin-bottom: 0.75rem;
}

.scan-title {
  font-size: 1.75rem;
  font-weight: 700;
  letter-spacing: -0.03em;
  color: #fff;
  margin-bottom: 0.5rem;
}

.scan-sub {
  font-size: 1.25rem;
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

.scan-input-row:focus-within { border-color: #444; }

.scan-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  padding: 0.9rem 1rem;
  color: #fff;
  font-size: 0.9rem;
}

.scan-input::placeholder { color: #333; }

.scan-upload {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  border-left: 1px solid #1a1a1a;
  cursor: pointer;
  color: #444;
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
  font-size: 1.25rem;
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

.brain-pending { border-left-color: #333; }
.brain-human   { border-left-color: var(--green); }
.brain-bot     { border-left-color: var(--red); }

.brain-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.brain-conf { font-size: 1rem; color: #444; margin-top: 0.5rem; }

.results-header { margin-bottom: 0.75rem; }

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
.result-dot.fail { background: #2a2a2a; }

.result-desc {
  flex: 1;
  font-size: 0.82rem;
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
  font-size: 1rem;
  color: #444;
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
  font-size: 1rem;
  color: #333;
  letter-spacing: 0.05em;
}

.vmc-type {
  font-size: 1rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #444;
  border: 1px solid #1a1a1a;
  padding: 0.15rem 0.45rem;
  border-radius: 3px;
}

.vmc-score {
  font-size: 1rem;
  color: #444;
  font-variant-numeric: tabular-nums;
  margin-left: auto;
}

.vcs-desc {
  font-size: 1rem;
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
  font-size: 1rem;
  color: #333;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  white-space: nowrap;
  flex-shrink: 0;
  width: 100px;
}

.vcs-detail-val {
  font-size: 0.75rem;
  color: #555;
  font-family: 'JetBrains Mono', monospace;
  word-break: break-all;
}

.vcs-code {
  font-size: 0.75rem;
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
  background: #2a2a2a;
  border-radius: 1px;
}

.vcs-actions {
  display: flex;
  gap: 0.5rem;
  padding-top: 0.25rem;
}

.vcs-btn {
  border: 1px solid #1a1a1a;
  border-radius: 6px;
  padding: 0.65rem 1rem;
  font-size: 0.825rem;
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
  color: #444;
  padding: 0.65rem 1.1rem;
}
.vcs-btn-skip:hover { color: #888; border-color: #2a2a2a; }

/* ── Layout ──────────────────────────────────────────────────────────────── */
.app-container {
  max-width: 1280px;
  width: 100%;
  margin: 0 auto;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

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
  height: 28px;
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
  font-size: 1rem;
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
  font-size: 1rem;
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
  font-size: 1rem;
  color: #aaa;
}

.disconnect-link {
  background: none;
  border: none;
  color: #444;
  font-size: 1rem;
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
  max-width: 360px;
  padding: 1.75rem;
  background: #0c0c0c;
  border: 1px solid #1e1e1e;
  border-radius: 10px;
}

.modal-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 1.25rem;
  color: #aaa;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  font-size: 1rem;
}

.wallet-option {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.9rem 1rem;
  background: #111;
  border: 1px solid #1e1e1e;
  border-radius: 7px;
  color: #fff;
  font-size: 0.9rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s, border-color 0.15s;
  margin-bottom: 0.6rem;
}

.wallet-option:hover {
  background: #1a1a1a;
  border-color: #2a2a2a;
}

.modal-close {
  width: 100%;
  padding: 1rem;
  background: none;
  border: 1px solid #1e1e1e;
  color: #555;
  border-radius: 6px;
  margin-top: 0.25rem;
  cursor: pointer;
  font-size: 1rem;
  transition: color 0.15s, border-color 0.15s;
}

.modal-close:hover { color: #aaa; border-color: #2a2a2a; }

/* ── Hero ────────────────────────────────────────────────────────────────── */
.hero {
  text-align: center;
  padding: 3.5rem 0 4.5rem;
  max-width: 720px;
  margin: 0 auto;
}

.hero .title {
  font-size: clamp(2rem, 6vw, 3.25rem);
  line-height: 1.1;
  margin-bottom: 1.25rem;
  color: #fff;
  letter-spacing: -0.04em;
}

.hero .subtitle {
  font-size: 1rem;
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
  font-size: 1.15rem;
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
  background: #080808;
  border: 1px solid #1e1e1e;
  border-radius: 7px;
  padding: 1.15rem 1rem;
  max-width: 100%;
  color: #fff;
  font-size: 1.25rem;
  transition: border-color 0.15s;
  font-family: inherit;
}

.premium-textarea {
  min-height: 80px;
  resize: vertical;
  line-height: 1.5;
}

.premium-input::placeholder,
.premium-textarea::placeholder { color: #333; }

.premium-input:focus,
.premium-select:focus,
.premium-textarea:focus {
  outline: none;
  border-color: #333;
  background: #0a0a0a;
}

.premium-select option { background: #111; }

.flex-input { display: contents; gap: 0.5rem; }

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
  color: #444;
  transition: color 0.15s, border-color 0.15s;
}

.file-label:hover { color: #aaa; border-color: #2a2a2a; }
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

.file-name { font-size: 1rem; color: #666; }

.resolved-display {
  font-size: 1rem;
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
  padding: 0.5rem 0.6rem;
  border-radius: 6px;
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
  font-size: 1rem;
  white-space: nowrap;
}

.mini-btn:hover { color: #aaa; border-color: #2a2a2a; }
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
  font-size: 1rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #444;
}

.abi-picker-count { font-size: 1rem; color: #333; }

.abi-picker-list { max-height: 12rem; overflow-y: auto; }

.abi-fn-btn {
  width: 100%;
  text-align: left;
  padding: 0.6rem 0.9rem;
  background: none;
  border: none;
  border-bottom: 1px solid #111;
  color: #888;
  font-size: 1rem;
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
  font-size: 1rem;
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
  font-size: 1.25rem;
  color: #888;
  line-height: 1.4;
}

.card-footer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 1rem;
  color: #3a3a3a;
}

.icon-success { color: var(--green); flex-shrink: 0; }
.icon-warning { color: var(--red); flex-shrink: 0; }

/* ── Badges ──────────────────────────────────────────────────────────────── */
.status-badge {
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  font-size: 1rem;
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
  font-size: 1rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-weight: 700;
  color: #444;
}

.brain-reasoning {
  font-size: 1.15rem;
  color: #777;
  line-height: 1.5;
}

.brain-analyzing {
  font-size: 1rem;
  color: #444;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50%       { opacity: 1; }
}

/* ── Votes ───────────────────────────────────────────────────────────────── */
.queue-container { max-width: 520px; margin: 0 auto; }

.method-preview p { color: #666; font-size: 0.95rem; line-height: 1.6; }

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
  padding: 2rem 0;
  border-top: 1px solid #111;
  margin-top: auto;
}

.footer-content {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  color: #2a2a2a;
  font-size: 1rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}


/* ── Vote card ───────────────────────────────────────────────────────────── */
.vote-card {
  padding: 2rem;
}

.vote-queue-label {
  font-size: 1rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #333;
  font-weight: 700;
  margin-bottom: 1.5rem;
}

.method-preview {
  margin-bottom: 1.75rem;
}

.method-preview p {
  font-size: 0.95rem;
  color: #888;
  line-height: 1.6;
  margin-bottom: 1.25rem;
}

.vote-score-row {
  display: flex;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.vote-score-label { font-size: 1rem; color: #444; }
.vote-score-value { font-size: 1rem; color: #666; font-variant-numeric: tabular-nums; }

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
  color: #2a2a2a;
  font-size: 1.25rem;
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
  font-size: 1.1rem;
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
  .form-row { flex-direction: column; }
  .form-col-sm { flex: unset; width: 100%; }
  .form-col-lg { flex: unset; width: 100%; }
}
</style>
