/**
 * square.js — Square API helpers for FDB Scan-to-Ship
 */
const https    = require('https');
const { randomUUID } = require('crypto');

const SQUARE_HOST = 'connect.squareup.com';
const SQUARE_VER  = '2024-01-18';

function squareRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const headers = {
      'Square-Version': SQUARE_VER,
      'Authorization':  'Bearer ' + process.env.SQUARE_ACCESS_TOKEN,
      'Content-Type':   'application/json',
    };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request({ hostname: SQUARE_HOST, path, method, headers }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Set absolute IN_STOCK inventory for one SKU at one location.
 * Uses PHYSICAL_COUNT — overwrites whatever Square currently has.
 */
async function updateInventory(variationId, locationId, units, occurredAt) {
  const r = await squareRequest('POST', '/v2/inventory/changes/batch-create', {
    idempotency_key: randomUUID(),
    changes: [{
      type: 'PHYSICAL_COUNT',
      physical_count: {
        catalog_object_id: variationId,
        location_id:       locationId,
        quantity:          String(Math.max(0, Math.round(units))),
        state:             'IN_STOCK',
        occurred_at:       occurredAt || new Date().toISOString(),
      },
    }],
  });
  if (r.status !== 200) throw new Error(`Square ${r.status}: ${JSON.stringify(r.body.errors)}`);
  return r.body;
}

/**
 * Search Square orders placed between startAt and endAt across given location IDs.
 * Returns { "LocationName|SKU": totalUnits }
 */
async function getSquareOrderUnits(locationMap, varToSku, startAt, endAt) {
  const locationIdToName = {};
  for (const [name, id] of Object.entries(locationMap)) locationIdToName[id] = name;
  const result = {};
  let cursor = null;
  do {
    const body = {
      location_ids: Object.values(locationMap),
      query: {
        filter: {
          date_time_filter: { created_at: { start_at: startAt, end_at: endAt } },
          state_filter: { states: ['OPEN', 'COMPLETED'] },
        },
      },
      limit: 500,
    };
    if (cursor) body.cursor = cursor;
    const r = await squareRequest('POST', '/v2/orders/search', body);
    for (const order of (r.body.orders || [])) {
      const locName = locationIdToName[order.location_id];
      if (!locName) continue;
      for (const item of (order.line_items || [])) {
        const sku = varToSku[item.catalog_object_id];
        if (sku) {
          const key = `${locName}|${sku}`;
          result[key] = (result[key] || 0) + parseFloat(item.quantity || 0);
        }
      }
    }
    cursor = r.body.cursor;
  } while (cursor);
  return result;
}

module.exports = { updateInventory, getSquareOrderUnits };
