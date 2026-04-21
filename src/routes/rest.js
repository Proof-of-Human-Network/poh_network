'use strict';

const express = require('express');
const router = express.Router();
const axios = require('axios');
const { evaluate } = require('../eval/evaluator');

/**
 * POST /rest
 *
 * Body:
 * {
 *   "url":        "https://api.example.com/endpoint",  // Full URL (required)
 *   "method":     "GET",                               // HTTP method (default: "GET")
 *   "params":     { "key": "value" },                  // Query params (optional, for GET)
 *   "headers":    { "Authorization": "Bearer ..." },   // Request headers (optional)
 *   "body":       { "foo": "bar" },                    // Request body (optional, for POST/PUT/PATCH)
 *   "expression": "data.status === 'active'",           // Boolean expression (required)
 *   "lang":       "js",                                // "js"|"go"|"rust"|"php"|"java" (default: js)
 *   "timeout":    5000                                 // Request timeout ms (default: 10000)
 * }
 *
 * In the expression, `data` refers to the parsed JSON response body.
 * `status` is the HTTP status code (number).
 * `headers` are the response headers (object).
 *
 * Response:
 * { "result": true }   or   { "error": "..." }
 */
router.post('/', async (req, res, next) => {
  try {
    const {
      url,
      method = 'GET',
      params,
      headers,
      body: requestBody,
      expression,
      lang = 'js',
      timeout = 10000,
    } = req.body;

    // Validate required fields
    const missing = [];
    if (!url)        missing.push('url');
    if (!expression) missing.push('expression');
    if (missing.length) {
      return res.status(400).json({ error: `Missing required fields: ${missing.join(', ')}` });
    }

    // Make the HTTP request
    let response;
    try {
      response = await axios({
        url,
        method: method.toUpperCase(),
        params,
        headers,
        data: requestBody,
        timeout,
        // Always try to parse JSON, but don't blow up if not JSON
        responseType: 'json',
        validateStatus: () => true, // Don't throw on 4xx/5xx — let expression decide
      });
    } catch (axiosErr) {
      return res.status(502).json({ error: `HTTP request failed: ${axiosErr.message}` });
    }

    const sandboxVars = {
      data: response.data,
      status: response.status,
      headers: response.headers,
    };

    // Evaluate the expression
    const outcome = evaluate(expression, sandboxVars, lang);

    return res.json({ result: outcome });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
