'use strict';

const express = require('express');
const router = express.Router();
const { getRpcUrl, callContract } = require('../utils/evm');
const { evaluate } = require('../eval/evaluator');

/**
 * POST /evm
 *
 * Body:
 * {
 *   "chainId":     1,                                           // EVM chain ID (required)
 *   "address":     "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // Contract address (required)
 *   "method":      "0x70a08231",                               // 4-byte hex method selector (required)
 *   "abiTypes":    ["address"],                                // Input ABI types (optional, [] if no params)
 *   "params":      ["0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045"], // Input values matching abiTypes
 *   "returnTypes": ["uint256"],                                // Output ABI types (required)
 *   "expression":  "result[0] > 0n",                          // Boolean expression (required)
 *   "lang":        "js",                                       // "js"|"go"|"rust"|"php"|"java" (default: js)
 *   "rpcUrl":      "https://..."                               // Optional: override auto-selected RPC
 * }
 *
 * Response:
 * { "result": true }   or   { "error": "..." }
 */
router.post('/', async (req, res, next) => {
  try {
    const {
      chainId,
      address,
      method,
      abiTypes = [],
      params = [],
      returnTypes = [],
      expression,
      lang = 'js',
      rpcUrl: overrideRpc,
    } = req.body;

    // Validate required fields
    const missing = [];
    if (chainId === undefined) missing.push('chainId');
    if (!address)              missing.push('address');
    if (!method)               missing.push('method');
    if (!expression)           missing.push('expression');
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    if (!method.startsWith('0x') || method.length !== 10) {
      return res.status(400).json({ error: 'method must be a 4-byte hex selector, e.g. "0x70a08231"' });
    }

    const rpcUrl = getRpcUrl(Number(chainId), overrideRpc);

    // Call the contract
    const result = await callContract(rpcUrl, address, method, abiTypes, returnTypes, params);

    // Evaluate the expression
    const outcome = evaluate(expression, { result }, lang);

    return res.json({ result: outcome });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
