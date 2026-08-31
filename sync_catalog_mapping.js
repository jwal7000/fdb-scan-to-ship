/**
 * sync_catalog_mapping.js — refresh Square_SKU_Mapping from the Square catalog
 *
 * Adds mappings for new Square items; updates a mapping only if its old
 * variation ID no longer exists in Square. Never deletes rows.
 *
 * Standalone:  node sync_catalog_mapping.js [--dry-run]
 * From sync_forecast.js:  await refreshCatalogMapping()
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const { query } = require('./db');

const TOKEN = process.env.SQUARE_ACCESS_TOKEN;

async function fetchCatalogSkus() {
  const skus = new Map();          // sku -> { variationId, itemName }
  const allVariationIds = new Set();
  const dupes = new Set();
  let cursor = null;
  do {
    const url = 'https://connect.squareup.com/v2/catalog/list?types=ITEM'
      + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
    const res = await fetch(url, { headers: { Authorization: 'Bearer ' + TOKEN } });
    if (!res.ok) throw new Error('Square catalog list failed: HTTP ' + res.status);
    const data = await res.json();
    for (const obj of data.objects || []) {
      if (obj.is_deleted) continue;
      const itemName = obj.item_data && obj.item_data.name;
      for (const v of (obj.item_data && obj.item_data.variations) || []) {
        const sku = v.item_variation_data && v.item_variation_data.sku;
        allVariationIds.add(v.id);
        if (!sku) continue;
        if (skus.has(sku)) {
          if (skus.get(sku).variationId !== v.id) dupes.add(sku);
          continue;
        }
        skus.set(sku, { variationId: v.id, itemName });
      }
    }
    cursor = data.cursor || null;
  } while (cursor);
  return { skus, allVariationIds, dupes };
}

async function refreshCatalogMapping(opts) {
  const dryRun = !!(opts && opts.dryRun);
  const { skus, allVariationIds, dupes } = await fetchCatalogSkus();
  const existing = await query('SELECT sku, square_variation_id FROM Square_SKU_Mapping');
  const current = new Map(existing.map(r => [r.sku, r.square_variation_id]));
  let added = 0, updated = 0, conflicts = 0;

  for (const [sku, info] of skus) {
    const cur = current.get(sku);
    if (cur === info.variationId) continue;
    if (cur && allVariationIds.has(cur)) {
      // Existing mapping still points at a live variation — leave it, just note it
      conflicts++;
      console.log('[catalog-sync] NOTE ' + sku + ' maps to a different live variation than catalog first-match (kept existing)');
      continue;
    }
    if (dryRun) {
      console.log('[catalog-sync] ' + (cur ? 'WOULD UPDATE ' : 'WOULD ADD ') + sku + ' -> ' + info.variationId + '  (' + (info.itemName || '?') + ')');
    } else {
      await query(
        'INSERT INTO Square_SKU_Mapping (sku, square_variation_id, item_name) VALUES (?, ?, ?) '
        + 'ON DUPLICATE KEY UPDATE square_variation_id = VALUES(square_variation_id), item_name = VALUES(item_name)',
        [sku, info.variationId, info.itemName || null]
      );
      console.log('[catalog-sync] ' + (cur ? 'UPDATED ' : 'ADDED ') + sku + ' -> ' + info.variationId + '  (' + (info.itemName || '?') + ')');
    }
    if (cur) updated++; else added++;
  }

  console.log('[catalog-sync] Square SKUs: ' + skus.size + ' | added: ' + added
    + ' | updated: ' + updated + ' | kept-despite-mismatch: ' + conflicts
    + (dupes.size ? ' | duplicate SKUs in Square: ' + [...dupes].join(', ') : ''));
  return { added, updated, conflicts };
}

if (require.main === module) {
  refreshCatalogMapping({ dryRun: process.argv.includes('--dry-run') })
    .then(() => process.exit(0))
    .catch(e => { console.error('[catalog-sync] Fatal:', e.message); process.exit(1); });
}

module.exports = { refreshCatalogMapping };
