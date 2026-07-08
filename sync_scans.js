/**
 * sync_scans.js — 6am Square inventory push (scan-based)
 *
 * Sets inventory = shipped units × (1 - buffer%) − shopify preorders − square online orders (since 11pm)
 *
 * Usage:  node sync_scans.js [YYYY-MM-DD]
 * Default: today (Central time)
 */
'use strict';
const { query }                      = require('./db');
const { updateInventory, getSquareOrderUnits } = require('./square');

function todayCST() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }))
    .toISOString().slice(0, 10);
}

async function run() {
  const targetDate = process.argv[2] || todayCST();
  const ts = new Date().toISOString();
  console.log(`\n[sync_scans] ${ts} — pushing scans for ${targetDate}`);

  // Load reference data in parallel
  const [scans, preorderRows, bufferRows, skuMapRows, locationRows] = await Promise.all([
    query(`
      SELECT pf.Location AS location, pf.SKU AS sku, pf.Item_Category AS category,
             MAX(kss.actual_trays) AS actual_trays,
             COALESCE(cs.Units_Per_Tray, cc.Units_Per_Tray) AS units_per_tray
      FROM Kitchen_Shipment_Scans kss
      JOIN Production_Forecast_Item_Level pf ON pf.id = kss.item_level_id
      LEFT JOIN Kitchen_Tray_Screen_Conversions cs
        ON cs.Sku = pf.SKU AND cs.Mapping_Method = 'Item_Sku'
      LEFT JOIN Kitchen_Tray_Screen_Conversions cc
        ON cc.Item_Category = pf.Item_Category AND cc.Mapping_Method = 'Category'
      WHERE pf.Forecast_Date = ? AND kss.scan_type = 'shipped'
      GROUP BY pf.Location, pf.SKU, pf.Item_Category, cs.Units_Per_Tray, cc.Units_Per_Tray
    `, [targetDate]),
    query(`SELECT Location, SKU, SUM(quantity) AS units FROM shopify_open_orders_ALL_CATEGORIES
           WHERE DATE(Pickup_Date) = ? GROUP BY Location, SKU`, [targetDate]),
    query(`SELECT category, buffer_pct FROM Square_Inventory_Buffer`),
    query(`SELECT sku, square_variation_id FROM Square_SKU_Mapping`),
    query(`SELECT Location, Location_id FROM Locations WHERE Location_id IS NOT NULL AND Forecast = 1`),
  ]);

  if (!scans.length) {
    console.log(`[sync_scans] No shipped scans for ${targetDate} — nothing to push.`);
    process.exit(0);
  }

  // Build lookup maps
  const preorderMap = {};
  for (const p of preorderRows) preorderMap[`${p.Location}|${p.SKU}`] = Number(p.units);

  const bufferMap = {};
  for (const b of bufferRows) bufferMap[b.category] = parseFloat(b.buffer_pct);
  const defaultBuffer = bufferMap['DEFAULT'] ?? 0.15;

  const variationMap = {};
  for (const s of skuMapRows) variationMap[s.sku] = s.square_variation_id;

  const locationMap = {};
  for (const l of locationRows) locationMap[l.Location] = l.Location_id;

  const varToSku = {};
  for (const s of skuMapRows) varToSku[s.square_variation_id] = s.sku;

  // Get Square online orders placed since 11pm last night
  // 11pm CST/CDT = 04:00–05:00 UTC; using 04:00 UTC (safe for both)
  const [y, m, d] = targetDate.split('-').map(Number);
  const prevNight = new Date(Date.UTC(y, m - 1, d - 1, 4, 0, 0)).toISOString(); // 11pm CDT prev night
  console.log(`  Fetching Square online orders since ${prevNight}...`);
  const squareOrders = await getSquareOrderUnits(locationMap, varToSku, prevNight, ts);
  const sqTotal = Object.values(squareOrders).reduce((a, b) => a + b, 0);
  console.log(`  Found ${sqTotal} total Square online units across ${Object.keys(squareOrders).length} SKU-locations\n`);

  // Push inventory
  let pushed = 0, skipped = 0, errors = 0;

  for (const row of scans) {
    const variationId = variationMap[row.sku];
    const locationId  = locationMap[row.location];
    if (!variationId || !locationId) { skipped++; continue; }

    const bufferPct   = bufferMap[row.category] ?? defaultBuffer;
    const grossUnits  = Math.round((row.actual_trays || 0) * (row.units_per_tray || 0));
    const preorders   = preorderMap[`${row.location}|${row.sku}`] || 0;
    const squareSold  = squareOrders[`${row.location}|${row.sku}`] || 0;
    const netUnits    = Math.max(0, Math.floor(grossUnits * (1 - bufferPct)) - preorders - squareSold);

    try {
      await updateInventory(variationId, locationId, netUnits, ts);
      console.log(`  ✓ ${row.location.padEnd(22)} ${row.sku}  ${grossUnits} gross → ${netUnits} net  (buf ${(bufferPct*100).toFixed(0)}%  pre ${preorders}  sq ${squareSold})`);
      pushed++;
    } catch (e) {
      console.error(`  ✗ ${row.location} ${row.sku}: ${e.message}`);
      errors++;
    }
  }

  console.log(`\n[sync_scans] Done — ${pushed} pushed, ${skipped} skipped (no mapping), ${errors} errors\n`);
  process.exit(errors > 0 ? 1 : 0);
}

run().catch(e => { console.error(e); process.exit(1); });
