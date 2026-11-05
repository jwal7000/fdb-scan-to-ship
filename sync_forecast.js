/**
 * sync_forecast.js — 11pm Square inventory push (forecast-based)
 *
 * Sets inventory at each store = forecast units × (1 - buffer%) − shopify preorders
 *
 * Usage:  node sync_forecast.js [YYYY-MM-DD] [--dry-run]
 * Default: tomorrow (Central time)
 *   --dry-run  read MySQL and print what would be pushed; no Square calls,
 *              no catalog refresh, no run-log row
 *
 * Every real run is recorded in Square_Forecast_Push_Runs (push_runs.js) so the
 * laptop fallback can tell whether tonight's push already happened.
 *
 * All MySQL reads happen BEFORE the first Square call, so a dropped DB
 * connection can't stop the run half-way through the push.
 */
'use strict';
const os = require('os');
const runs = require('./push_runs');
const { withRetry, isTransient, tomorrowCST } = runs;

// Abort the push after this many rows in a row fail with a network error
// (each row is already retried) — the network is down, stop and say so.
const MAX_CONSECUTIVE_NET_ERRORS = 3;

async function syncForecast({ targetDate, dryRun = false, deps, log = console.log, errLog = console.error }) {
  const { query, updateInventory, refreshCatalogMapping } = deps;
  const host = deps.host || os.hostname();
  const sleep = deps.sleep;
  const retry = (label, fn) => withRetry(label, fn, { log: errLog, sleep });
  const ts = new Date().toISOString();
  log(`\n[sync_forecast] ${ts} — ${dryRun ? 'DRY RUN for' : 'pushing forecast for'} ${targetDate} (host ${host})`);

  // Run-log bookkeeping must never block the push itself.
  let runId = null;
  try { runId = await retry('run-log start', () => runs.recordStart(query, { targetDate, host, dryRun })); }
  catch (e) { errLog(`[sync_forecast] WARNING could not record run start (${e.code || e.message}) — continuing`); }
  const finish = async (result) => {
    try { await retry('run-log finish', () => runs.recordFinish(query, runId, result)); }
    catch (e) { errLog(`[sync_forecast] WARNING could not record run finish (${e.code || e.message})`); }
    return result;
  };

  // Refresh SKU mapping from Square catalog so new items are never skipped
  if (!dryRun) {
    try { await refreshCatalogMapping(); }
    catch (e) { errLog('[sync_forecast] catalog mapping refresh failed:', e.message); }
  }

  // Load ALL reference data up front — nothing below the push loop touches MySQL
  let forecast, bufferRows, skuMapRows, locationRows, recentRows;
  try {
    [forecast, bufferRows, skuMapRows, locationRows, recentRows] = await Promise.all([
      retry('forecast query', () => query(`
        SELECT pf.Location AS location, pf.SKU AS sku, pf.Item_Category AS category,
               COALESCE(pf.Kitchen_Override_Units, pf.Final_Forecasted_Units) AS gross_units,
               COALESCE(pf.Shopify_Preorder_Items, 0) AS preorders
        FROM Production_Forecast_Item_Level pf
        WHERE pf.Forecast_Date = ?
          AND COALESCE(pf.Kitchen_Override_Units, pf.Final_Forecasted_Units) > 0
      `, [targetDate])),
      retry('buffer query', () => query(`SELECT category, buffer_pct FROM Square_Inventory_Buffer`)),
      retry('sku map query', () => query(`SELECT sku, square_variation_id FROM Square_SKU_Mapping`)),
      retry('locations query', () => query(`SELECT Location, Location_id FROM Locations WHERE Location_id IS NOT NULL AND Forecast = 1`)),
      // Items active in last 7 days — zeroed below if missing from the target date's forecast
      retry('recent items query', () => query(`
        SELECT DISTINCT Location AS location, SKU AS sku
        FROM Production_Forecast_Item_Level
        WHERE Forecast_Date >= DATE_SUB(?, INTERVAL 7 DAY)
          AND Forecast_Date < ?
          AND COALESCE(Kitchen_Override_Units, Final_Forecasted_Units) > 0
      `, [targetDate, targetDate])),
    ]);
  } catch (e) {
    const msg = `MySQL load failed (${e.code || e.message}) — ABORTED before any Square push; no inventory was changed`;
    errLog(`[sync_forecast] ${msg}`);
    return finish({ status: 'failed', exitCode: 1, message: msg });
  }

  if (!forecast.length) {
    log(`[sync_forecast] No forecast rows for ${targetDate} — nothing to push.`);
    return finish({ status: 'success', exitCode: 0, message: 'no forecast rows' });
  }

  // Build lookup maps
  const bufferMap = {};
  for (const b of bufferRows) bufferMap[b.category] = parseFloat(b.buffer_pct);
  const defaultBuffer = bufferMap['DEFAULT'] ?? 0.15;

  const variationMap = {};
  for (const s of skuMapRows) variationMap[s.sku] = s.square_variation_id;

  const locationMap = {};
  for (const l of locationRows) locationMap[l.Location] = l.Location_id;

  let pushed = 0, zeroed = 0, skipped = 0, errors = 0, consecutiveNet = 0;
  const planned = forecast.length;

  // Returns false when the push must stop (network down)
  async function setCount(row, variationId, locationId, units, label) {
    if (dryRun) return true;
    try {
      await withRetry(`Square ${row.location} ${row.sku}`, () => updateInventory(variationId, locationId, units, ts), { log: errLog, sleep });
      consecutiveNet = 0;
      return true;
    } catch (e) {
      errLog(`  ✗ ${row.location} ${row.sku}${label}: ${e.code ? e.code + ' ' : ''}${e.message}`);
      errors++;
      if (isTransient(e) && ++consecutiveNet >= MAX_CONSECUTIVE_NET_ERRORS) return false;
      return null;
    }
  }

  let aborted = false;

  // Push inventory
  for (const row of forecast) {
    const variationId = variationMap[row.sku];
    const locationId  = locationMap[row.location];
    if (!variationId || !locationId) { skipped++; continue; }

    const bufferPct  = bufferMap[row.category] ?? defaultBuffer;
    const grossUnits = row.gross_units || 0;
    const preorders  = row.preorders || 0;
    const netUnits   = Math.max(0, Math.floor(grossUnits * (1 - bufferPct)) - preorders);

    const ok = await setCount(row, variationId, locationId, netUnits, '');
    if (ok === false) { aborted = true; break; }
    if (ok) {
      log(`  ✓ ${row.location.padEnd(22)} ${row.sku}  ${grossUnits} gross → ${netUnits} net  (buf ${(bufferPct*100).toFixed(0)}%  pre ${preorders})`);
      pushed++;
    }
  }

  // Zero out items active in last 7 days but missing from the target date's forecast
  if (!aborted) {
    const forecastedPairs = new Set(forecast.map(r => r.location + '|||' + r.sku));
    for (const row of recentRows) {
      if (forecastedPairs.has(row.location + '|||' + row.sku)) continue;
      const variationId = variationMap[row.sku];
      const locationId  = locationMap[row.location];
      if (!variationId || !locationId) continue;
      const ok = await setCount(row, variationId, locationId, 0, ' zero');
      if (ok === false) { aborted = true; break; }
      if (ok) {
        log(`  ○ ${row.location.padEnd(22)} ${row.sku}  → 0 (not in forecast)`);
        zeroed++;
      }
    }
  }

  const counts = { pushed, zeroed, skipped, errors };
  if (aborted) {
    const msg = `ABORTED — network down after ${MAX_CONSECUTIVE_NET_ERRORS} consecutive Square failures; ` +
      `${pushed} of ${planned} forecast rows pushed, ${zeroed} zeroed. Square inventory is PARTIALLY updated — ` +
      `re-run \`node sync_forecast.js ${targetDate}\` to finish (counts are absolute, re-running is safe)`;
    errLog(`\n[sync_forecast] ${msg}\n`);
    return finish({ status: 'aborted', exitCode: 1, ...counts, message: msg });
  }

  const verb = dryRun ? 'DRY RUN done (nothing sent to Square) — would push' : 'Done —';
  log(`\n[sync_forecast] ${verb} ${pushed} pushed, ${zeroed} zeroed, ${skipped} skipped (no mapping), ${errors} errors\n`);
  return finish({ status: errors > 0 ? 'partial' : 'success', exitCode: errors > 0 ? 1 : 0, ...counts });
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const targetDate = args.find(a => !a.startsWith('--')) || tomorrowCST();
  const { query } = require('./db');
  const deps = {
    query,
    updateInventory: dryRun ? null : require('./square').updateInventory,
    refreshCatalogMapping: require('./sync_catalog_mapping').refreshCatalogMapping,
  };
  const result = await syncForecast({ targetDate, dryRun, deps });
  process.exit(result.exitCode);
}

if (require.main === module) {
  main().catch(e => { console.error('[sync_forecast] FATAL:', e); process.exit(1); });
}

module.exports = { syncForecast, MAX_CONSECUTIVE_NET_ERRORS };
