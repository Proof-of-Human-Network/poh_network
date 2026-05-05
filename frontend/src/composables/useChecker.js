import { ref, computed } from 'vue'
import axios from 'axios'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import { getAssociatedTokenAddress, createTransferInstruction } from '@solana/spl-token'

export function useChecker({ walletAddress, connected, POH_MINT, FEE_RECIPIENT, SOLANA_RPC, signAndSendTransaction }) {
  const scanInput            = ref('')
  const resolvedInputDisplay = ref('')
  const checkerResults       = ref(null)
  const showEvidence         = ref(false)
  const brainVerdict         = ref(null)
  const brainPolling         = ref(false)
  const brainKey             = ref(null)
  const faucetLoading        = ref(false)
  const faucetMsg            = ref(null)
  const batchFile            = ref(null)
  const batchRowCount        = ref(0)
  const batchRows            = ref([])
  const isResolving          = ref(false)
  const loading              = ref(false)
  const error                = ref(null)

  const detectedChain = computed(() => {
    const v = scanInput.value?.trim()
    if (!v) return null
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return 'evm'
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v)) return 'solana'
    return null
  })

  function isWalletAddress(input) {
    if (!input) return false
    if (/^0x[0-9a-fA-F]{40}$/.test(input)) return true
    if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input)) return true
    return false
  }

  async function resolveToAddress(input) {
    const trimmed = input.trim()
    if (isWalletAddress(trimmed)) return trimmed

    // .sol domain → Bonfida SNS
    if (trimmed.endsWith('.sol')) {
      const domain = trimmed.slice(0, -4)
      const res = await axios.get(`https://sns-sdk-proxy.bonfida.workers.dev/resolve/${domain}`)
      if (res.data?.result) return res.data.result
      throw new Error(`Could not resolve "${trimmed}" — SNS domain not found`)
    }

    // ENS / Space ID domains
    try {
      const res = await axios.get('https://nameapi.space.id/getAddress', { params: { domain: trimmed } })
      if (res.data?.code === 0 && res.data.address) return res.data.address
    } catch { /* fall through to ZNS */ }

    // ZNS domains
    const ZNS_TLD_CHAIN = {
      ink: 57073, bnb: 56, base: 8453, blast: 81457, polygon: 137,
      zora: 7777777, scroll: 534352, taiko: 167000, bera: 80094,
      sonic: 146, kaia: 8217, abstract: 2741, defi: 130, unichain: 1301,
      soneium: 1868, plume: 98865, hemi: 43111, xrpl: 1440002,
    }
    const tld = trimmed.split('.').pop()?.toLowerCase()
    const onlyDomain = trimmed.split('.').slice(0, -1).join('.')

    const znsChains = ZNS_TLD_CHAIN[tld] ? [ZNS_TLD_CHAIN[tld]] : Object.values(ZNS_TLD_CHAIN)
    for (const chain of znsChains) {
      try {
        const res = await axios.get('https://zns.bio/api/resolveDomain', { params: { chain, domain: onlyDomain } })
        if (res.data?.code === 200 && isWalletAddress(res.data.address)) return res.data.address
      } catch { /* try next chain */ }
    }

    throw new Error(`Could not resolve "${trimmed}" — not a valid address or domain`)
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

  const claimFaucet = async () => {
    if (!walletAddress.value) { error.value = 'Connect wallet first'; return }
    faucetLoading.value = true
    faucetMsg.value = null
    try {
      const res = await axios.post('/profile/faucet', { address: walletAddress.value })
      faucetMsg.value = { ok: true, text: `10 000 POH sent — tx: ${res.data.txHash?.slice(0, 16)}…` }
    } catch (err) {
      faucetMsg.value = { ok: false, text: err.response?.data?.error || 'Faucet failed' }
    } finally {
      faucetLoading.value = false
    }
  }

  const runCheck = async () => {
    if (!connected.value) { error.value = 'Please connect your wallet first'; return }
    loading.value = true
    isResolving.value = true
    error.value = null
    resolvedInputDisplay.value = ''
    try {
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

      let txHash = null
      const { data: pricingData } = await axios.get(`/checker/pricing?count=${resolvedInputs.length}`)
      const freeScanData = await axios.get('/profile/' + walletAddress.value).catch(() => null)
      const freeScansLeft = freeScanData?.data?.profile?.freeScansLeft ?? 100

      if (freeScansLeft < resolvedInputs.length && POH_MINT.value && !POH_MINT.value.startsWith('YOUR_')) {
        const costRaw = pricingData.total
        const connection = new Connection(SOLANA_RPC.value, 'confirmed')
        const mintPubkey = new PublicKey(POH_MINT.value)
        const walletPubkey = new PublicKey(walletAddress.value)
        const recipientPubkey = new PublicKey(FEE_RECIPIENT.value)
        const fromAta = await getAssociatedTokenAddress(mintPubkey, walletPubkey)
        const toAta = await getAssociatedTokenAddress(mintPubkey, recipientPubkey)
        const payTx = new Transaction().add(
          createTransferInstruction(fromAta, toAta, walletPubkey, BigInt(costRaw))
        )
        txHash = await signAndSendTransaction(payTx)
      }

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
      if (txHash) formData.append('txHash', txHash)

      const res = await axios.post('/checker', formData)
      checkerResults.value = res.data.result
      brainVerdict.value = null
      brainKey.value     = null
      showEvidence.value = false

      const _brainKey = res.data.brainKey
      if (_brainKey) {
        brainKey.value = _brainKey
        brainPolling.value = true
        const poll = setInterval(async () => {
          try {
            const b = await axios.get(`/checker/brain/${encodeURIComponent(_brainKey)}`)
            if (b.data.status === 'done' || b.data.status === 'error') {
              brainVerdict.value = b.data
              brainPolling.value = false
              clearInterval(poll)
            }
          } catch { clearInterval(poll); brainPolling.value = false }
        }, 4000)
        setTimeout(() => { clearInterval(poll); brainPolling.value = false }, 180000)
      }
    } catch (err) {
      console.log(err.data, err.message, err.response)
      error.value = err.response?.data?.error || err.message || 'Scan failed'
      isResolving.value = false
    } finally {
      loading.value = false
    }
  }

  return {
    scanInput,
    resolvedInputDisplay,
    checkerResults,
    showEvidence,
    brainVerdict,
    brainPolling,
    brainKey,
    faucetLoading,
    faucetMsg,
    batchFile,
    batchRowCount,
    batchRows,
    isResolving,
    loading,
    error,
    detectedChain,
    resolveToAddress,
    handleFileSelect,
    claimFaucet,
    runCheck,
  }
}
