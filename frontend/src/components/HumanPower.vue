<script setup>
import { ref, computed, onMounted, watch } from 'vue'
import axios from 'axios'
import {
  Search, PlusSquare, Vote, ShieldCheck,
  Activity, Trash2, FileUp, SquareArrowDown, PersonStanding, FolderCode, CreditCard, Bitcoin
} from 'lucide-vue-next'
import {
  Connection,
  PublicKey,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL
} from '@solana/web3.js'
import {
  getAssociatedTokenAddress,
  createTransferInstruction,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token'
import {
  getPohBalance, getStakeInfo, getGlobalState,
  stakeTokens, unstakeTokens, registerMethod,
  castVote as castVoteOnChain, claimStakerRewards,
} from '../pohProgram.js'
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
const POH_MINT = ref('')
const FEE_RECIPIENT = ref('')
const SOLANA_RPC = ref('https://api.devnet.solana.com')

const fetchConfig = async () => {
  try {
    const res = await axios.get('/config')
    POH_MINT.value = res.data.POH_MINT
    FEE_RECIPIENT.value = res.data.FEE_RECIPIENT
    SOLANA_RPC.value = res.data.SOLANA_RPC
    STAKING_CONTRACT.value = res.data.STAKING_CONTRACT || ''
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

const detectedChain = computed(() => {
  const v = scanInput.value?.trim()
  if (!v) return null
  if (/^0x[0-9a-fA-F]{40}$/.test(v)) return 'evm'
  if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return 'solana'
  return null
})

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

    // ── Burn POH tokens ──────────────────────────────────────────────────
    // const connection = new Connection(SOLANA_RPC.value, 'confirmed')
    // const count = resolvedInputs.length
    // if (!POH_MINT.value || POH_MINT.value.startsWith('YOUR_')) throw new Error('POH_MINT not configured on server — set POH_TOKEN_MINT in .env')
    // const mintPubkey = new PublicKey(POH_MINT.value)
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

const LISTING_FEE_POH = 1000 // 1000 POH

const submitListing = async () => {
  if (!connected.value) { error.value = 'Please connect your wallet'; return }
  if (pohBalance.value < LISTING_FEE_POH) {
    error.value = `Insufficient POH — need ${LISTING_FEE_POH} POH, you have ${pohBalance.value.toFixed(2)}`
    return
  }
  loading.value = true
  try {
    // Generate deterministic method ID for on-chain registration
    const methodId = crypto.randomUUID().replace(/-/g, '')

    // Get current total_methods index for PDA derivation
    const global = await getGlobalState(SOLANA_RPC.value)
    const methodIndex = global?.totalMethods ?? 0

    // Register on-chain: pays 1000 POH, splits 50/50 deployer/stakers
    const txHash = await registerMethod(
      walletProvider.value, walletAddress.value, POH_MINT.value, SOLANA_RPC.value,
      methodId, methodIndex
    )

    // Register in backend with the on-chain txHash + methodId
    const headerObj = headers.value.reduce((a, h) => { if (h.key) a[h.key] = h.value; return a }, {})
    const payload = {
      ...listing.value,
      headers: JSON.stringify(headerObj),
      txHash,
      walletAddress: walletAddress.value,
      onChainMethodId: methodId,
      onChainIndex: methodIndex,
    }
    if (listing.value.type === 'rest') payload.method = listing.value.httpMethod
    await axios.post('/methods/listing', payload)

    await loadPohBalance()
    alert(`Method registered! Paid ${LISTING_FEE_POH} POH — 500 to deployer, 500 distributed to stakers.`)
    listing.value = { type: 'evm', chainId: 1, address: '', method: '', abiTypes: '', returnTypes: '', decimals: '', expression: '', lang: 'js', description: '', body: '', httpMethod: 'GET' }
    headers.value = [{ key: '', value: '' }]
  } catch (err) {
    error.value = err.message || 'Registration failed'
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

// ── 4. Profile ────────────────────────────────────────────────────────────────
const profileData   = ref(null)
const profileLoading = ref(false)
const profileError  = ref(null)
const signupLoading = ref(false)
const STAKING_CONTRACT = ref('')

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function encodeBase58(bytes) {
  let n = BigInt('0x' + Array.from(bytes, b => b.toString(16).padStart(2, '0')).join(''))
  let result = ''
  while (n > 0n) { result = BASE58_ALPHABET[Number(n % 58n)] + result; n /= 58n }
  for (const b of bytes) { if (b !== 0) break; result = '1' + result }
  return result
}

async function loadProfile() {
  if (!walletAddress.value) return
  profileLoading.value = true
  profileError.value = null
  try {
    const res = await axios.get(`/profile/${walletAddress.value}`)
    profileData.value = res.data
  } catch (err) {
    if (err.response?.status === 404) profileData.value = null
    else profileError.value = err.response?.data?.error || 'Failed to load profile'
  } finally {
    profileLoading.value = false
  }
}

async function signupProfile() {
  if (!walletAddress.value || !walletProvider.value) { error.value = 'Connect wallet first'; return }
  signupLoading.value = true
  profileError.value = null
  try {
    const message = `poh-profile-v1:${walletAddress.value}:${Date.now()}`
    const messageBytes = new TextEncoder().encode(message)
    const { signature } = await walletProvider.value.signMessage(messageBytes, 'utf8')
    const bs58sig = encodeBase58(signature)
    await axios.post('/profile/signup', { address: walletAddress.value, signature: bs58sig, message })
    await loadProfile()
  } catch (err) {
    profileError.value = err.response?.data?.error || err.message || 'Signup failed'
  } finally {
    signupLoading.value = false
  }
}

async function rotateApiKey() {
  if (!walletAddress.value) return
  try {
    const res = await axios.post('/profile/apikey/rotate', { address: walletAddress.value })
    if (profileData.value?.profile) profileData.value.profile.apiKey = res.data.apiKey
  } catch (err) {
    profileError.value = err.response?.data?.error || 'Rotate failed'
  }
}

function copyText(text) {
  navigator.clipboard.writeText(text).catch(() => {})
}

// ── 5. Staking ────────────────────────────────────────────────────────────────
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

function goTo (url) {
  window.open(url, '_blank')
}

watch(walletAddress, (addr) => {
  if (addr && POH_MINT.value) loadPohBalance()
})

onMounted(async () => {
  await fetchConfig()
  if (currentSection.value === 'votes') loadVoting()
  if (connected.value) loadPohBalance()
})
</script>

<template>
  <div class="app-container">
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
          <PlusSquare class="icon" :size="14" /> List
        </button>
        <button :class="['nav-btn', { active: currentSection === 'votes' }]" @click="showSection('votes'); loadVoting()">
          <Vote class="icon" :size="14" /> Vote
        </button>
        <button :class="['nav-btn', { active: currentSection === 'staking' }]" @click="showSection('staking')">
          <SquareArrowDown class="icon" :size="14" /> Stake
        </button>
        <button :class="['nav-btn', { active: currentSection === 'profile' }]" @click="showSection('profile'); loadProfile()">
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
        <button :class="['mobile-nav-btn', { active: currentSection === 'listing' }]" @click="showSection('listing')">List</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'votes' }]" @click="showSection('votes'); loadVoting()">Vote</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'api' }]" @click="showSection('api')">API</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'staking' }]" @click="showSection('staking')">Stake</button>
        <button :class="['mobile-nav-btn', { active: currentSection === 'profile' }]" @click="showSection('profile'); loadProfile()">Profile</button>
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
          <p class="landing-sub">On-chain evidence. Community-powered signal.<br>100 free scans per wallet. API access. Community rewards.</p>
          <div class="landing-cta-row">
            <button class="neon-btn landing-cta" @click="showSection('checker')">Start Scanning →</button>
            <button class="outline-btn landing-cta" @click="showSection('api')">View API Docs</button>
          </div>
        </section>

        <!-- How it works -->
        <section class="how-section">
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
                <li>Evaluator interprets top 5 signals with explicit per-method weights, runs a second pass to catch overconfidence</li>
                <li>Learner updates weights after every community vote (±0.05 max drift)</li>
                <li>Compiler rewrites a compact brain state hourly — no hallucination, stats only</li>
              </ul>
            </div>
          </div>
        </section>

        <div class="network-label">$POH Token</div>

        <section class="landing-token">
          <p class="token-desc">Fair launch via bonding curve. No VC rounds. No pre-mine. Every scan either burns $POH or flows 50% back to method contributors. Stake to govern signal quality.</p>

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
            <div class="split-bar"><div class="split-fill" style="width:20%; background:#333"></div></div>
            <div class="split-note">1 month cliff · 6 month linear vesting</div>
          </div>

          <div class="token-economics">
            <div class="econ-row">
              <span class="econ-label">Per scan cost</span>
              <span class="econ-val">1 POH (bulk discounts up to 60%)</span>
            </div>
            <div class="econ-row">
              <span class="econ-label">Method owner share</span>
              <span class="econ-val">50% of each paid scan, weighted by score × stake</span>
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
        </section>

        <section class="landing-utilities">
          <div class="utility-card">
            <div class="utility-icon"><Search :size="48" /></div>
            <div class="utility-name">Scan</div>
            <div class="utility-desc">Verify any EVM or Solana wallet against all registered detection methods. Get an instant AI verdict on human vs bot probability.</div>
            <button class="utility-link" @click="showSection('checker')">Open Scanner →</button>
          </div>
          <div class="utility-card">
            <div class="utility-icon"><PlusSquare :size="48" /></div>
            <div class="utility-name">List</div>
            <div class="utility-desc">Submit a new on-chain detection method — smart contract call, Solana program, or REST API. Pay 1000 POH. 50% distributed to stakers, 50% to protocol. Earn scan rewards forever.</div>
            <button class="utility-link" @click="showSection('listing')">Submit Method →</button>
          </div>
          <div class="utility-card">
            <div class="utility-icon"><Vote :size="48" /></div>
            <div class="utility-name">Vote</div>
            <div class="utility-desc">Review submitted methods in the consensus queue. Your POH stake weight determines your influence. Curate signal from noise.</div>
            <button class="utility-link" @click="showSection('votes'); loadVoting()">Open Queue →</button>
          </div>
          <div class="utility-card">
            <div class="utility-icon"><ShieldCheck :size="48" /></div>
            <div class="utility-name">API</div>
            <div class="utility-desc">Integrate human verification directly into your app. First 100 scans free per wallet. Bulk pricing with curve discounts for large batches.</div>
            <button class="utility-link" @click="showSection('api')">API Docs →</button>
          </div>
          <div class="utility-card">
            <div class="utility-icon"><Activity :size="48" /></div>
            <div class="utility-name">Stake</div>
            <div class="utility-desc">Stake POH to amplify your vote weight in method scoring. Higher stake = more influence over which detection signals matter.</div>
            <button class="utility-link" @click="showSection('staking')">Stake POH →</button>
          </div>
        </section>

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
        <div class="listing-header">
          <div class="scan-tag">METHOD LISTING</div>
          <h2 class="scan-title">Submit a detection method</h2>
          <p class="scan-sub">Define an on-chain check and pay 1000 POH to register it. 500 POH goes to stakers immediately, 500 to the protocol. Earn rewards when your method is used in scans.</p>
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
            <textarea v-model="listing.description" placeholder="What does this method detect? What constitutes human evidence?" class="premium-textarea" rows="2"></textarea>
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
                {{ voteSubmitting ? '...' : '✓ Human' }}
              </button>
              <button class="vcs-btn vcs-btn-no" :disabled="voteSubmitting" @click="castVote(false)">
                ✗ Robot
              </button>
              <button class="vcs-btn vcs-btn-skip" @click="castVote('skip')">
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
              <div class="pstat-card">
                <div class="pstat-val">{{ ((profileData.profile?.balance ?? 0) / 1e6).toFixed(2) }}</div>
                <div class="pstat-label">Balance (POH)</div>
              </div>
              <div class="pstat-card">
                <div class="pstat-val">{{ profileData.earned ? (profileData.earned / 1e6).toFixed(2) : '0.00' }}</div>
                <div class="pstat-label">Total Earned</div>
              </div>
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
                    <span class="mlist-earned">{{ ((profileData.pending) / 1e6).toFixed(4) }} POH pending</span>
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
            <div class="api-desc">Scan one or more wallet addresses against all registered detection methods. Returns per-method results and a <code>brainKey</code> for async AI verdict polling.</div>
            <div class="api-params">
              <div class="param-row"><code>input</code><span>string or array — wallet address(es) to scan</span></div>
              <div class="param-row"><code>walletAddress</code><span>your Solana wallet (for free tier tracking)</span></div>
              <div class="param-row"><code>apiKey</code><span>API key from your profile (alternative to walletAddress)</span></div>
              <div class="param-row"><code>txHash</code><span>POH burn transaction hash (required for paid scans)</span></div>
              <div class="param-row"><code>chainIds</code><span>comma-separated chain IDs to filter EVM methods (optional)</span></div>
              <div class="param-row"><code>csv</code><span>multipart file upload — CSV with address column (batch mode)</span></div>
            </div>
            <div class="code-block">
              <div class="code-lang">curl</div>
              <pre class="code-pre">curl -X POST https://poh.assetux.com/checker \
  -H "Content-Type: application/json" \
  -d '{
    "input": "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
    "apiKey": "your-api-key-here"
  }'</pre>
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
          <div class="api-section-title">GET /checker/brain/:key</div>
          <div class="api-card">
            <div class="api-desc">Poll for the async AI verdict after a scan. <code>brainKey</code> is returned by POST /checker. Returns <code>status: "pending" | "done" | "error"</code>.</div>
            <div class="code-block">
              <div class="code-lang">curl</div>
              <pre class="code-pre">curl https://poh.assetux.com/checker/brain/0xabc123...</pre>
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
              <pre class="code-pre">curl "https://poh.assetux.com/checker/pricing?count=100"
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
              <pre class="code-pre">curl https://poh.assetux.com/profile/YourSolanaWalletAddressHere</pre>
            </div>
          </div>
        </div>

        <div class="api-cta">
          <p>Get your API key from your <button class="utility-link" @click="showSection('profile'); loadProfile()">profile →</button></p>
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
                <button class="neon-btn" :disabled="stakeLoading || !stakeAmount" @click="submitStake()">
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

            <!-- Claim rewards -->
            <div v-if="claimable > 0" class="stake-claim-row">
              <span class="claim-desc">{{ claimable.toFixed(4) }} POH from staking rewards</span>
              <button class="neon-btn" :disabled="claimLoading" @click="claimRewards()">
                {{ claimLoading ? 'Claiming...' : 'Claim Rewards' }}
              </button>
            </div>

            <div v-if="stakeMessage" class="stake-message">{{ stakeMessage }}</div>
            <p class="profile-hint" style="margin-top:0.75rem">
              Contract: <code>{{ STAKING_CONTRACT?.slice(0, 20) }}…</code>
            </p>
          </template>
        </div>
      </div>

    </main>

    <footer class="footer">
      <div class="network-label">Connect</div>
    </footer>
  </div>
</template>

<style scoped>
/* ── Landing ─────────────────────────────────────────────────────────────── */
.landing {
  max-width: 1280px;
  margin: 0 auto 0;
  padding: 0 0 2rem;
}

.landing-hero {
  padding: 10rem 0 10rem;
  text-align: center;
}

.landing-tag {
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: #444;
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
.landing-utilities {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 1px;
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
  margin-top: 25px;
  font-size: 1.25rem;
  font-weight: 600;
  color: #fff;
  letter-spacing: -0.02em;
}

.utility-desc {
  margin-top: 25px;
  font-size: 1.25rem;
  color: #555;
  line-height: 1.6;
  flex-grow: 1;
}

.utility-link {
  margin-top: 25px;
  background: none;
  border: none;
  color: #888;
  font-size: 1.25rem;
  cursor: pointer;
  padding: 0;
  text-align: left;
  transition: color 0.15s;
}

.no-margin {
  margin: 0 !important;
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
  color: #444;
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
.how-section { margin: 0 0 3rem; }

.how-label {
  font-size: 0.81rem;
  font-weight: 700;
  letter-spacing: 0.2em;
  color: #333;
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
  color: #2a2a2a;
}

.how-tag {
  display: inline-block;
  font-size: 0.78rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #444;
  border: 1px solid #1a1a1a;
  border-radius: 3px;
  padding: 0.1rem 0.35rem;
  margin-right: 0.35rem;
  vertical-align: middle;
}

/* ── Network graph ───────────────────────────────────────────────────────── */
.network-section {
  margin-bottom: 3rem;
}

.network-label {
  font-size: 3rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  color: #333;
  text-transform: uppercase;
  margin: 10rem 0 3rem 0;
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
  font-size: 11px;
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
  font-size: 1.25rem;
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

.field-hint { font-size: 0.72rem; color: #444; margin-top: 0.3rem; }
.field-hint--warn { color: #666; }

.type-tabs {
  display: flex;
  gap: 0.3rem;
  flex-wrap: wrap;
}

.type-tab {
  background: none;
  border: 1px solid #1a1a1a;
  color: #444;
  padding: 0.4rem 1rem;
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
  white-space: nowrap;
}

.type-tab:hover { border-color: #2a2a2a; color: #aaa; }
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
  font-size: 0.9rem;
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
  color: #444;
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

.scan-input-row:focus-within { border-color: #444; }

.scan-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  padding: 0.9rem 1rem;
  color: #fff;
  font-size: 1.12rem;
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

.brain-pending { border-left-color: #333; }
.brain-human   { border-left-color: var(--green); }
.brain-bot     { border-left-color: var(--red); }

.brain-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.5rem;
}

.brain-conf { font-size: 1.25rem; color: #444; margin-top: 0.5rem; }

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
  font-size: 1.25rem;
  color: #333;
  letter-spacing: 0.05em;
}

.vmc-type {
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #444;
  border: 1px solid #1a1a1a;
  padding: 0.15rem 0.45rem;
  border-radius: 3px;
}

.vmc-score {
  font-size: 1.25rem;
  color: #444;
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
  color: #333;
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
  color: #444;
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
  max-width: 360px;
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
  font-size: 1.12rem;
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
  font-size: 1.25rem;
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
  font-size: 0.875rem;
  line-height: 1.4;
  transition: border-color 0.15s, background 0.15s;
  font-family: inherit;
  box-sizing: border-box;
}

.premium-textarea {
  min-height: 80px;
  resize: vertical;
  line-height: 1.55;
}

.premium-input::placeholder,
.premium-textarea::placeholder { color: #2a2a2a; }

.premium-input:focus,
.premium-select:focus,
.premium-textarea:focus {
  outline: none;
  border-color: #2a2a2a;
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
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: #444;
}

.abi-picker-count { font-size: 0.72rem; color: #333; }

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
  color: #444;
}

.brain-reasoning {
  font-size: 1.44rem;
  color: #777;
  line-height: 1.5;
}

.brain-analyzing {
  font-size: 1.25rem;
  color: #444;
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
  color: #2a2a2a;
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
  color: #333;
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

.vote-score-label { font-size: 1.25rem; color: #444; }
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
  color: #2a2a2a;
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
  border: 1px solid #333;
  color: #888;
  padding: 0.875rem 2rem;
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
.econ-label { color: #555; font-size: 0.875rem; white-space: nowrap; }
.econ-val { color: #999; font-size: 0.875rem; text-align: right; }

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
  font-size: 0.9375rem;
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
.pstat-val { font-size: 1.75rem; font-weight: 700; color: #fff; }
.pstat-label { font-size: 0.8125rem; color: #555; margin-top: 0.25rem; }

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
  margin-bottom: 0.875rem;
}
.profile-card-title { font-size: 0.9375rem; font-weight: 600; color: #ccc; }
.profile-card-count {
  background: #111;
  border: 1px solid #222;
  color: #666;
  font-size: 0.8125rem;
  padding: 0.15rem 0.5rem;
  border-radius: 20px;
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
  font-size: 0.875rem;
  color: #888;
  word-break: break-all;
}
.profile-hint { font-size: 0.8125rem; color: #444; margin-top: 0.5rem; }
.profile-hint code { background: #111; padding: 0.1rem 0.3rem; border-radius: 3px; color: #888; }

.profile-empty { color: #444; font-size: 0.9375rem; display: flex; gap: 0.5rem; align-items: center; }

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
.mlist-desc { font-size: 0.9375rem; color: #888; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
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
  font-size: 0.9375rem;
  line-height: 1.6;
  border-bottom: 1px solid #111;
}
.api-desc code { background: #111; padding: 0.1rem 0.3rem; border-radius: 3px; color: #888; font-size: 0.875rem; }
.api-params { padding: 0.75rem 1.25rem; border-bottom: 1px solid #111; display: flex; flex-direction: column; gap: 0.4rem; }
.param-row { display: flex; align-items: baseline; gap: 0.75rem; font-size: 0.9rem; }
.param-row code { color: #fff; font-size: 0.875rem; background: #0c0c0c; border: 1px solid #1e1e1e; padding: 0.1rem 0.35rem; border-radius: 3px; white-space: nowrap; }
.param-row span { color: #555; }

.code-block { border-top: 1px solid #111; }
.code-lang {
  padding: 0.35rem 1.25rem;
  font-size: 0.75rem;
  color: #444;
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
  font-size: 0.875rem;
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
  font-size: 0.9375rem;
  gap: 1rem;
}
.pt-row:last-child { border-bottom: none; }
.pt-head { font-size: 0.8125rem; font-weight: 600; color: #444; text-transform: uppercase; letter-spacing: 0.05em; background: #050505; }
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
.si-list li { color: #666; font-size: 0.9375rem; line-height: 1.5; }

.stake-form-card {
  border: 1px solid #1a1a1a;
  border-radius: 8px;
  padding: 1.5rem;
}
.stake-form-title { font-size: 1.0625rem; font-weight: 600; color: #ccc; margin-bottom: 1.25rem; }
.stake-message { margin-top: 0.75rem; font-size: 0.9375rem; color: #888; }

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
  padding: 0.875rem 0.75rem;
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
.max-btn:hover { border-color: #444; color: #aaa; }

.stake-claim-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  background: #0a0f0a;
  border: 1px solid #1a2a1a;
  border-radius: 8px;
  padding: 0.875rem 1rem;
  margin-top: 0.5rem;
  margin-bottom: 0.75rem;
}
.claim-desc { font-size: 0.9375rem; color: #5a8a5a; }

/* ── Listing fee row ─────────────────────────────────────────────────────── */
.listing-fee-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 0;
  font-size: 0.9375rem;
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
