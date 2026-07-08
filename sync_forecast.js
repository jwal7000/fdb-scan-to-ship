/**
 * sync_forecast.js — 11pm Square inventory push (forecast-based)
 *
 * Sets inventory at each store = forecast units × (1 - buffer%) − shopify preorders
 *
 * Usage:  node sync_forecast.js [YYYY-MM-DD]
 * Default: tomorrow (Central time)
 */
'use strict';
const { query }        = require('./db');
const { updateInventory } = require('./square');

function tomorrowCST() {
  const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000);
  return tomorrow.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

async function run() {
  const targetDate = process.argv[2] || tomorrowCST();
  const ts = new Date().toISOString();
  console.log(`\n[sync_forecast] ${ts} — pushing forecast for ${targetDate}`);

  // Load reference data in parallel
  const [forecast, bufferRows, skuMapRows, locationRows] = await Promise.all([
    query(`
      SELECT pf.Location AS location, pf.SKU AS sku, pf.Item_Category AS category,
             COALESCE(pf.Kitchen_Override_Units, pf.Final_Forecasted_Units) AS gross_units,
             COALESCE(pf.Shopify_Preorder_Items, 0) AS preorders
      FROM Production_Forecast_Item_Level pf
      WHERE pf.Forecast_Date = ?
        AND COALESCE(pf.Kitchen_Override_Units, pf.Final_Forecasted_Units) > 0
    `, [targetDate]),
    query(`SELECT category, buffer_pct FROM Square_Inventory_Buffer`),
    query(`SELECT sku, square_variation_id FROM Square_SKU_Mapping`),
    query(`SELECT Location, Location_id FROM Locations WHERE Location_id IS NOT NULL AND Forecast = 1`),
  ]);

  if (!forecast.length) {
    console.log(`[sync_forecast] No forecast rows for ${targetDate} — nothing to push.`);
    process.exit(0);
  }

  // Build lookup maps
  const bufferMap = {};
  for (const b of bufferRows) bufferMap[b.category] = parseFloat(b.buffer_pct);
  const defaultBuffer = bufferMap['DEFAULT'] ?? 0.15;

  const variationMap = {};
  for (const s of skuMapRows) variationMap[s.sku] = s.square_variation_id;

  const locationMap = {};
  for (const l of locationRows) locationMap[l.Location] = l.Location_id;

  // Push inventory
  let pushed = 0, skipped = 0, errors = 0;

  for (const row of forecast) {
    const variationId = variationMap[row.sku];
    const locationId  = locationMap[row.location];
    if (!variationId || !locationId) { skipped++; continue; }

    const bufferPct  = bufferMap[row.category] ?? defaultBuffer;
    const grossUnits = row.gross_units || 0;
    const preorders  = row.preorders || 0;
    const netUnits   = Math.max(0, Math.floor(grossUnits * (1 - bufferPct)) - preorders);

    try {
      await updateInventory(variationId, locationId, netUnits, ts);
      console.log(`  ✓ ${row.location.padEnd(22)} ${row.sku}  ${grossUnits} gross → ${netUnits} net  (buf ${(bufferPct*100).toFixed(0)}%  pre ${preorders})`);
      pushed++;
    } catch (e) {
      console.error(`  ✗ ${row.location} ${row.sku}: ${e.message}`);
      errors++;
    }
  }

  // Zero out items active in last 7 days but missing from tomorrow's forecast
  const forecastedPairs = new Set(forecast.map(r => r.location + '|||' + r.sku));
  const recentRows = await query(`
    SELECT DISTINCT Location AS location, SKU AS sku
    FROM Production_Forecast_Item_Level
    WHERE Forecast_Date >= DATE_SUB(?, INTERVAL 7 DAY)
      AND Forecast_Date < ?
      AND COALESCE(Kitchen_Override_Units, Final_Forecasted_Units) > 0
  `, [targetDate, targetDate]);

  let zeroed = 0;
  for (const row of recentRows) {
    if (forecastedPairs.has(row.location + '|||' + row.sku)) continue;
    const variationId = variationMap[row.sku];
    const locationId  = locationMap[row.location];
    if (!variationId || !locationId) continue;
    try {
      await updateInventory(variationId, locationId, 0, ts);
      console.log(`  ○ ${row.location.padEnd(22)} ${row.sku}  → 0 (not in forecast)`);
      zeroed++;
    } catch (e) {
      console.error(`  ✗ ${row.location} ${row.sku} zero: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n[sync_forecast] Done — ${pushed} pushed, ${zeroed} zeroed, ${skipped} skipped (no mapping), ${errors} errors\n`);
  process.exit(errors > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
