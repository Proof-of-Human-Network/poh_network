import { ref } from 'vue'
import axios from 'axios'
import { getGlobalState, registerMethod } from '../pohProgram.js'

export function useListing({ walletAddress, walletProvider, connected, POH_MINT, SOLANA_RPC, pohBalance, loadPohBalance }) {
  const listing = ref({
    type: 'evm', chainId: 1, address: '', method: '', abiTypes: '', returnTypes: '',
    decimals: '', expression: '', lang: 'js', description: '', body: '', httpMethod: 'GET',
  })
  const headers     = ref([{ key: '', value: '' }])
  const abiFns      = ref([])
  const abiLoading  = ref(false)
  const abiError    = ref(null)
  const loading     = ref(false)
  const error       = ref(null)

  const LISTING_FEE_POH = 1000

  const addHeader    = () => headers.value.push({ key: '', value: '' })
  const removeHeader = (i) => headers.value.splice(i, 1)

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
        abiFns.value = (res.data.instructions || []).map(ix => ({
          name: ix.name,
          abiTypes: JSON.stringify(ix.args?.map(a => a.type) || []),
          returnTypes: '[]',
          inputs: ix.args || [],
          outputs: [],
          isInstruction: true,
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
    if (!connected.value) { error.value = 'Please connect your wallet'; return }
    if (pohBalance.value < LISTING_FEE_POH) {
      error.value = `Insufficient POH — need ${LISTING_FEE_POH} POH, you have ${pohBalance.value.toFixed(2)}`
      return
    }
    if (!listing.value.description?.trim()) { error.value = 'Description is required'; return }

    // loading.value = true
    // try {
    //   const validation = await axios.post('/methods/listing/validate-description', { description: listing.value.description })
    //   if (!validation.data.valid) {
    //     error.value = `Description rejected: ${validation.data.reason}`
    //     loading.value = false
    //     return
    //   }
    // } catch {
    //   // If validation service is down, proceed
    // }

    try {
      const methodId = crypto.randomUUID().replace(/-/g, '')
      const global = await getGlobalState(SOLANA_RPC.value)
      const methodIndex = global?.totalMethods ?? 0

      const txHash = await registerMethod(
        walletProvider.value, walletAddress.value, POH_MINT.value, SOLANA_RPC.value,
        methodId, methodIndex
      )

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

  return {
    listing,
    headers,
    abiFns,
    abiLoading,
    abiError,
    loading,
    error,
    LISTING_FEE_POH,
    addHeader,
    removeHeader,
    fetchAbi,
    pickMethod,
    submitListing,
  }
}
