'use strict';

/**
 * Multi-language expression evaluator.
 *
 * Supported lang values: "js", "go", "rust", "php", "java"
 *
 * Supported constructs across all languages:
 *   - Comparison: ==, !=, >, <, >=, <=
 *   - Logical: &&, ||, !
 *   - Ternary (JS/Java): condition ? a : b
 *   - Array/object access: result[0], data.foo.bar
 *   - PHP: $variable → variable, $arr['key'] → arr['key']
 *   - Java/Rust/Go: type casts like (int)x or x as i64 → stripped
 *   - BigInt-aware comparison for uint types
 *
 * The expression receives these sandbox globals:
 *   result  — array of ABI-decoded values (EVM endpoint)
 *   data    — parsed response body (REST endpoint)
 *
 * Returns a JS boolean.
 */

const { VM } = require('vm2');

/**
 * Normalize a foreign-syntax expression to valid JS.
 * @param {string} expr
 * @param {'js'|'go'|'rust'|'php'|'java'} lang
 * @returns {string}
 */
function normalize(expr, lang) {
  let js = expr.trim();

  switch (lang.toLowerCase()) {
    case 'php': {
      // $variable → variable
      js = js.replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, '$1');
      // PHP loose == on non-numeric → ===, loose != → !==
      // but keep >=, <= as-is
      js = js.replace(/(?<![<>!])===|(?<![<>!])!==/, (m) => m); // already strict, keep
      js = js.replace(/(?<![<>!=])={2}(?!=)/g, '===');
      js = js.replace(/!={1}(?!=)/g, '!==');
      // PHP null
      js = js.replace(/\bnull\b/g, 'null');
      break;
    }

    case 'go': {
      // nil → null
      js = js.replace(/\bnil\b/g, 'null');
      // Go has no semicolons at end of expr, nothing special needed for comparisons
      // == stays == (we'll convert below for non-numeric)
      js = js.replace(/(?<![<>!=])={2}(?!=)/g, '===');
      js = js.replace(/!={1}(?!=)/g, '!==');
      break;
    }

    case 'rust': {
      // Rust: as i32 / as u64 / as f64 / as usize → strip
      js = js.replace(/\bas\s+[a-z0-9]+/g, '');
      // Rust uses == and != natively — map to strict
      js = js.replace(/(?<![<>!=])={2}(?!=)/g, '===');
      js = js.replace(/!={1}(?!=)/g, '!==');
      // true/false already valid JS
      break;
    }

    case 'java': {
      // Java type casts: (int), (long), (double), (String), etc.
      js = js.replace(/\(\s*(?:int|long|double|float|short|byte|char|boolean|String|Object)\s*\)/g, '');
      // null is same
      js = js.replace(/(?<![<>!=])={2}(?!=)/g, '===');
      js = js.replace(/!={1}(?!=)/g, '!==');
      break;
    }

    case 'js':
    default:
      // Already JS, no transformation needed
      break;
  }

  return js;
}

/**
 * Wrap BigInt values so comparison with plain numbers works transparently.
 * vm2 runs in the same V8, so native BigInt is available.
 * We wrap the sandbox values in a Proxy that auto-coerces BigInt to Number
 * when compared with Number literals — but only for languages that don't
 * use the n suffix.
 */
function makeSandboxValue(val, lang) {
  if (typeof val !== 'bigint') return val;
  // For JS we return native BigInt; user is expected to write 1000n themselves.
  // For other languages, coerce to Number (safe for values < 2^53).
  if (lang === 'js') return val;
  return Number(val);
}

function prepareSandbox(vars, lang) {
  const sandbox = {};
  for (const [key, val] of Object.entries(vars)) {
    if (Array.isArray(val)) {
      sandbox[key] = val.map((v) => makeSandboxValue(v, lang));
    } else {
      sandbox[key] = makeSandboxValue(val, lang);
    }
  }
  return sandbox;
}

/**
 * Evaluate an expression against provided variables.
 *
 * @param {string} expression  Raw expression (in specified lang syntax)
 * @param {object} vars        Variables available in sandbox, e.g. { result, data }
 * @param {string} lang        "js" | "go" | "rust" | "php" | "java"
 * @returns {boolean}
 */
function evaluate(expression, vars, lang = 'js') {
  const jsExpr = normalize(expression, lang);
  const sandbox = prepareSandbox(vars, lang);

  const vm = new VM({
    timeout: 2000,
    allowAsync: false,
    sandbox,
  });

  let raw;
  try {
    raw = vm.run(jsExpr);
  } catch (err) {
    throw new Error(`Expression evaluation failed: ${err.message}\n  Normalized JS: ${jsExpr}`);
  }

  return Boolean(raw);
}

module.exports = { evaluate, normalize };
