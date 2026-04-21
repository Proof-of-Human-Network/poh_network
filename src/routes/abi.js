'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');

const ETHERSCAN_BASES = {
  1:      'https://api.etherscan.io/api',
  10:     'https://api-optimistic.etherscan.io/api',
  56:     'https://api.bscscan.com/api',
  100:    'https://api.gnosisscan.io/api',
  137:    'https://api.polygonscan.com/api',
  8453:   'https://api.basescan.org/api',
  42161:  'https://api.arbiscan.io/api',
  43114:  'https://api.snowtrace.io/api',
  59144:  'https://api.lineascan.build/api',
  534352: 'https://api.scrollscan.com/api',
  80094:  'https://api.berascan.com/api',
};

async function fetchFromEtherscan(chainId, address) {
  const base = ETHERSCAN_BASES[Number(chainId)];
  if (!base) return null;
  const res = await axios.get(base, {
    params: { module: 'contract', action: 'getabi', address },
    timeout: 6000
  });
  if (res.data.status !== '1') return null;
  return JSON.parse(res.data.result);
}

async function fetchFromSourcify(chainId, address) {
  // Try full match first, then partial
  for (const type of ['full_match', 'partial_match']) {
    try {
      const url = `https://repo.sourcify.dev/contracts/${type}/${chainId}/${address}/metadata.json`;
      const res = await axios.get(url, { timeout: 6000 });
      return res.data?.output?.abi || null;
    } catch {}
  }
  return null;
}

/**
 * GET /abi/evm?address=0x...&chainId=1
 * Returns array of view/pure functions with their input/output types.
 */
router.get('/evm', async (req, res) => {
  const { address, chainId = 1 } = req.query;
  if (!address) return res.status(400).json({ error: 'address required' });

  let abi = null;
  try { abi = await fetchFromEtherscan(chainId, address); } catch {}
  if (!abi) {
    try { abi = await fetchFromSourcify(chainId, address); } catch {}
  }
  if (!abi) return res.status(404).json({ error: 'ABI not found. Contract may not be verified.' });

  // Extract only callable functions (view/pure preferred, all functions allowed)
  const fns = abi
    .filter(item => item.type === 'function')
    .map(fn => ({
      name: fn.name,
      stateMutability: fn.stateMutability,
      inputs: fn.inputs.map(i => ({ name: i.name, type: i.type })),
      outputs: fn.outputs.map(o => ({ name: o.name, type: o.type })),
      abiTypes: JSON.stringify(fn.inputs.map(i => i.type)),
      returnTypes: JSON.stringify(fn.outputs.map(o => o.type)),
    }))
    .sort((a, b) => {
      // Prioritize view/pure (read-only), non-address-arg functions first
      const score = f => (f.stateMutability === 'view' || f.stateMutability === 'pure') ? 0 : 1;
      return score(a) - score(b);
    });

  res.json({ abi: fns, total: fns.length });
});

/**
 * GET /abi/solana?programId=...
 * Fetches Anchor IDL from the on-chain IDL account or apr.dev registry.
 */
router.get('/solana', async (req, res) => {
  const { programId } = req.query;
  if (!programId) return res.status(400).json({ error: 'programId required' });

  let idl = null;

  // Try apr.dev Anchor IDL registry
  try {
    const r = await axios.get(`https://api.apr.dev/api/idl?programId=${programId}`, { timeout: 6000 });
    idl = r.data?.idl || r.data;
  } catch {}

  // Try anchor-lang IDL via Solana RPC (on-chain IDL account)
  if (!idl) {
    try {
      const rpc = process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com';
      const r = await axios.post(rpc, {
        jsonrpc: '2.0', id: 1, method: 'getAccountInfo',
        params: [programId, { encoding: 'base64' }]
      }, { timeout: 6000 });
      // If account exists it's a program — we can at least confirm it
      const exists = !!r.data?.result?.value;
      if (exists && !idl) {
        return res.json({ idl: null, programExists: true, note: 'Program exists but IDL not publicly available (not an Anchor program or IDL not published)' });
      }
    } catch {}
  }

  if (!idl) return res.status(404).json({ error: 'IDL not found for this program.' });

  // Map instructions to a picker-friendly format
  const instructions = (idl.instructions || []).map(ix => ({
    name: ix.name,
    accounts: ix.accounts?.map(a => ({ name: a.name, isSigner: a.isSigner, isWritable: a.isWritable })) || [],
    args: ix.args?.map(a => ({ name: a.name, type: typeof a.type === 'object' ? JSON.stringify(a.type) : a.type })) || [],
  }));

  res.json({ idl: { name: idl.name, version: idl.version }, instructions, total: instructions.length });
});

module.exports = router;
