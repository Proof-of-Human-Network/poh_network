'use strict';

/**
 * Built-in chain registry: chainId → public RPC URL
 * Callers can override per-request with { rpcUrl: "..." }
 * or via env vars RPC_<chainId>=<url>
 */
const CHAIN_REGISTRY = {
  1:        'https://eth.llamarpc.com',                    // Ethereum Mainnet
  5:        'https://rpc.ankr.com/eth_goerli',             // Goerli (deprecated but kept)
  11155111: 'https://rpc.sepolia.org',                     // Sepolia
  137:      'https://polygon-rpc.com',                     // Polygon
  80001:    'https://rpc-mumbai.maticvigil.com',           // Mumbai
  56:       'https://bsc-dataseed.binance.org',            // BSC
  97:       'https://data-seed-prebsc-1-s1.binance.org:8545', // BSC Testnet
  43114:    'https://api.avax.network/ext/bc/C/rpc',       // Avalanche C-Chain
  43113:    'https://api.avax-test.network/ext/bc/C/rpc',  // Fuji Testnet
  42161:    'https://arb1.arbitrum.io/rpc',                // Arbitrum One
  421614:   'https://sepolia-rollup.arbitrum.io/rpc',      // Arbitrum Sepolia
  10:       'https://mainnet.optimism.io',                 // Optimism
  11155420: 'https://sepolia.optimism.io',                 // Optimism Sepolia
  8453:     'https://mainnet.base.org',                    // Base
  84532:    'https://sepolia.base.org',                    // Base Sepolia
  100:      'https://rpc.gnosischain.com',                 // Gnosis
  250:      'https://rpc.ftm.tools',                       // Fantom Opera
  1284:     'https://rpc.api.moonbeam.network',            // Moonbeam
  1285:     'https://rpc.api.moonriver.moonbeam.network',  // Moonriver
  324:      'https://mainnet.era.zksync.io',               // zkSync Era
  1101:     'https://zkevm-rpc.com',                       // Polygon zkEVM
  59144:    'https://rpc.linea.build',                     // Linea
  534352:   'https://rpc.scroll.io',                       // Scroll
  25:       'https://evm.cronos.org',                      // Cronos
  1666600000: 'https://api.harmony.one',                   // Harmony
  9001:     'https://eth.bd.evmos.org:8545',               // Evmos
};

/**
 * Resolve RPC URL for a given chainId.
 * Priority: request-level rpcUrl > env var RPC_<chainId> > built-in registry
 */
function getRpcUrl(chainId, overrideUrl) {
  if (overrideUrl) return overrideUrl;
  const envKey = `RPC_${chainId}`;
  if (process.env[envKey]) return process.env[envKey];
  const url = CHAIN_REGISTRY[chainId];
  if (!url) throw new Error(`No RPC URL found for chainId ${chainId}. Pass rpcUrl in the request body.`);
  return url;
}

/**
 * Call a smart contract method via eth_call.
 *
 * @param {string}   rpcUrl      JSON-RPC endpoint
 * @param {string}   address     Contract address (checksummed or not)
 * @param {string}   hexMethod   4-byte selector, e.g. "0x70a08231"
 * @param {string[]} abiTypes    Input ABI types, e.g. ["address", "uint256"]
 * @param {string[]} returnTypes Output ABI types, e.g. ["uint256"]
 * @param {any[]}    params      Input values matching abiTypes
 * @returns {any[]} Decoded return values
 */
/**
 * Convert a human-readable function name/signature to its 4-byte hex selector.
 * Accepts: "0x70a08231" (passthrough), "balanceOf(address)", "balanceOf"
 * For bare names without signature, abiTypes are used to build the signature.
 */
function toHexSelector(method, abiTypes = []) {
  const { ethers } = require('ethers');
  if (!method) throw new Error('method is required');
  if (/^0x[0-9a-fA-F]{8}$/.test(method)) return method; // already a 4-byte selector
  // Build full signature if not already present
  const sig = method.includes('(') ? method : `${method}(${abiTypes.join(',')})`;
  return ethers.id(sig).slice(0, 10); // keccak256, take first 4 bytes
}

async function callContract(rpcUrl, address, hexMethod, abiTypes, returnTypes, params) {
  const { ethers } = require('ethers');
  hexMethod = toHexSelector(hexMethod, abiTypes);

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  // ABI-encode input params (empty if no params)
  let calldata = hexMethod;
  if (abiTypes && abiTypes.length > 0) {
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(abiTypes, params);
    // encoded starts with 0x, strip it and append to method selector
    calldata = hexMethod + encoded.slice(2);
  }

  const raw = await provider.call({ to: address, data: calldata });

  if (!raw || raw === '0x') {
    return [];
  }

  // ABI-decode output
  if (returnTypes && returnTypes.length > 0) {
    const decoded = ethers.AbiCoder.defaultAbiCoder().decode(returnTypes, raw);
    // Convert Result object to plain array, preserving BigInt values
    return Array.from(decoded);
  }

  return [raw];
}

module.exports = { getRpcUrl, callContract };
