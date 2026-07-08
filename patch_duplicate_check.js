/**
 * patch_duplicate_check.js  (v3 — exact anchors)
 *
 * Adds duplicate-scan prevention keyed on daily ticket number + date.
 * Only adds what's needed — does not touch any existing logic.
 *
 * QR format:  {ticket_num}-{SKU}-{Location}-{Qty}-{Date}
 *   e.g.      002-01002-PCM-1-20260522
 *
 * Duplicate key stored as master_ticket_ref = "002-2026-05-22"
 * Second scan of the same ticket number on the same day → 409 blocked.
 *
 * Run: node patch_duplicate_check.js
 * Then: pm2 restart scan-to-ship
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const BASE     = '/Users/openclaw-user/.openclaw/workspace/scan-to-ship';
const dbPath   = path.join(BASE, 'db.js');
const svrPath  = path.join(BASE, 'server.js');
const htmlPath = path.join(BASE, 'public', 'index.html');

let errors = 0;
function fail(msg) { console.error('✗', msg); errors++; }
function ok(msg)   { console.log('✓', msg); }
function skip(msg) { console.log('–', msg); }

// ─────────────────────────────────────────────────────────────────────────────
// 1. db.js
// ─────────────────────────────────────────────────────────────────────────────
let db = fs.readFileSync(dbPath, 'utf8');

// 1a. Add master_ticket_ref column to SQLite CREATE TABLE
const OLD_SCHEMA = "        synced         INTEGER NOT NULL DEFAULT 0\n      );\n      CREATE TABLE IF NOT EXISTS Forecast_Cache (";
const NEW_SCHEMA = "        synced         INTEGER NOT NULL DEFAULT 0,\n        master_ticket_ref TEXT\n      );\n      CREATE TABLE IF NOT EXISTS Forecast_Cache (";

if (db.includes('master_ticket_ref TEXT')) {
  skip('db.js schema: master_ticket_ref already present');
} else if (!db.includes(OLD_SCHEMA)) {
  fail('db.js schema: anchor not found');
} else {
  db = db.replace(OLD_SCHEMA, NEW_SCHEMA);
  ok('db.js schema: master_ticket_ref column added');
}

// 1b. Add migration for existing SQLite tables
const OLD_MIGRATE = "  // Migrate: add synced column if table was created before offline mode\n  try { sqliteDb.exec('ALTER TABLE Kitchen_Shipment_Scans ADD COLUMN synced INTEGER NOT NULL DEFAULT 0'); } catch(e) {}\n  return sqliteDb;";
const NEW_MIGRATE = "  // Migrate: add synced column if table was created before offline mode\n  try { sqliteDb.exec('ALTER TABLE Kitchen_Shipment_Scans ADD COLUMN synced INTEGER NOT NULL DEFAULT 0'); } catch(e) {}\n  // Migrate: add master_ticket_ref for duplicate scan detection\n  try { sqliteDb.exec('ALTER TABLE Kitchen_Shipment_Scans ADD COLUMN master_ticket_ref TEXT'); } catch(e) {}\n  return sqliteDb;";

if (db.includes('add master_ticket_ref for duplicate')) {
  skip('db.js migration: already present');
} else if (!db.includes(OLD_MIGRATE)) {
  fail('db.js migration: anchor not found');
} else {
  db = db.replace(OLD_MIGRATE, NEW_MIGRATE);
  ok('db.js migration: master_ticket_ref ALTER TABLE added');
}

// 1c. Add master_ticket_ref to insertScan destructure
const OLD_DESTRUCT = "  const {\n    item_level_id, forecast_date, location, sku,\n    planned_trays, actual_trays, scan_type, scanned_by, device_id, notes\n  } = record;";
const NEW_DESTRUCT = "  const {\n    item_level_id, forecast_date, location, sku,\n    planned_trays, actual_trays, scan_type, scanned_by, device_id, notes,\n    master_ticket_ref\n  } = record;";

if (db.includes(NEW_DESTRUCT)) {
  skip('db.js insertScan destructure: already updated');
} else if (!db.includes(OLD_DESTRUCT)) {
  fail('db.js insertScan destructure: anchor not found');
} else {
  db = db.replace(OLD_DESTRUCT, NEW_DESTRUCT);
  ok('db.js insertScan: master_ticket_ref added to destructure');
}

// 1d. Add master_ticket_ref to MySQL INSERT
const OLD_MYSQL_INSERT = "        'INSERT INTO Kitchen_Shipment_Scans (scan_timestamp, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by, device_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',\n        [scanTime, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by || null, device_id || null, notes || null]";
const NEW_MYSQL_INSERT = "        'INSERT INTO Kitchen_Shipment_Scans (scan_timestamp, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by, device_id, notes, master_ticket_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',\n        [scanTime, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by || null, device_id || null, notes || null, master_ticket_ref || null]";

if (db.includes(NEW_MYSQL_INSERT)) {
  skip('db.js MySQL INSERT: already updated');
} else if (!db.includes(OLD_MYSQL_INSERT)) {
  fail('db.js MySQL INSERT: anchor not found');
} else {
  db = db.replace(OLD_MYSQL_INSERT, NEW_MYSQL_INSERT);
  ok('db.js MySQL INSERT: master_ticket_ref added');
}

// 1e. Add master_ticket_ref to SQLite INSERT statement
const OLD_SQLITE_INSERT = "    'INSERT INTO Kitchen_Shipment_Scans (scan_timestamp, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by, device_id, notes, synced) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'";
const NEW_SQLITE_INSERT = "    'INSERT INTO Kitchen_Shipment_Scans (scan_timestamp, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by, device_id, notes, synced, master_ticket_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'";

if (db.includes(NEW_SQLITE_INSERT)) {
  skip('db.js SQLite INSERT: already updated');
} else if (!db.includes(OLD_SQLITE_INSERT)) {
  fail('db.js SQLite INSERT: anchor not found');
} else {
  db = db.replace(OLD_SQLITE_INSERT, NEW_SQLITE_INSERT);
  ok('db.js SQLite INSERT: master_ticket_ref added');
}

// 1f. Add master_ticket_ref to SQLite .run() params
const OLD_SQLITE_RUN = "    scanned_by || null, device_id || null, notes || null, synced\n  );";
const NEW_SQLITE_RUN = "    scanned_by || null, device_id || null, notes || null, synced, master_ticket_ref || null\n  );";

if (db.includes(NEW_SQLITE_RUN)) {
  skip('db.js SQLite .run(): already updated');
} else if (!db.includes(OLD_SQLITE_RUN)) {
  fail('db.js SQLite .run(): anchor not found');
} else {
  db = db.replace(OLD_SQLITE_RUN, NEW_SQLITE_RUN);
  ok('db.js SQLite .run(): master_ticket_ref added');
}

// 1g. Add checkDuplicateScan function + add to exports
const CHECK_FN = `
/**
 * Block duplicate scans of the same physical tray ticket on the same day.
 * @param {string} master_ticket_ref  e.g. "002-2026-05-22"
 * @param {string} scan_type          "shipped" | "received"
 * @returns existing scan row or null
 */
async function checkDuplicateScan(master_ticket_ref, scan_type) {
  if (!master_ticket_ref) return null;
  const sql = 'SELECT id, scan_timestamp, actual_trays, scanned_by ' +
              'FROM Kitchen_Shipment_Scans ' +
              'WHERE master_ticket_ref = ? AND scan_type = ? LIMIT 1';
  if (writePool) {
    try {
      const [rows] = await writePool.execute(sql, [master_ticket_ref, scan_type]);
      return rows.length ? rows[0] : null;
    } catch (e) {
      console.error('[checkDuplicateScan] MySQL error:', e.message);
    }
  }
  try {
    const row = getSqlite().prepare(sql).get(master_ticket_ref, scan_type);
    return row || null;
  } catch (e) {
    console.error('[checkDuplicateScan] SQLite error:', e.message);
    return null;
  }
}

`;

const OLD_EXPORTS = "module.exports = {getRackPosition, query, insertScan, recentScans, reconciliation, reconciliationByCategory, getScannedTotal, deleteScan, getStatus, cacheForecasts, queryForecastCache, queryForecastCacheById, startHealthCheck, syncOfflineScans };";
const NEW_EXPORTS = "module.exports = {getRackPosition, query, insertScan, recentScans, reconciliation, reconciliationByCategory, getScannedTotal, deleteScan, getStatus, cacheForecasts, queryForecastCache, queryForecastCacheById, startHealthCheck, syncOfflineScans, checkDuplicateScan };";

if (db.includes('checkDuplicateScan')) {
  skip('db.js checkDuplicateScan: already present');
} else if (!db.includes(OLD_EXPORTS)) {
  fail('db.js exports: anchor not found');
} else {
  db = db.replace(OLD_EXPORTS, CHECK_FN + NEW_EXPORTS);
  ok('db.js: checkDuplicateScan function added + exported');
}

fs.writeFileSync(dbPath, db);
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
// 2. server.js
// ─────────────────────────────────────────────────────────────────────────────
let svr = fs.readFileSync(svrPath, 'utf8');

// 2a. Add checkDuplicateScan to require
const OLD_REQUIRE = "const {query, insertScan, recentScans, reconciliation, reconciliationByCategory, getScannedTotal,\n  getRackPosition, deleteScan, getStatus, cacheForecasts, queryForecastCache, queryForecastCacheById, startHealthCheck, syncOfflineScans} = require('./db');";
const NEW_REQUIRE = "const {query, insertScan, recentScans, reconciliation, reconciliationByCategory, getScannedTotal,\n  getRackPosition, deleteScan, getStatus, cacheForecasts, queryForecastCache, queryForecastCacheById, startHealthCheck, syncOfflineScans, checkDuplicateScan} = require('./db');";

if (svr.includes('checkDuplicateScan')) {
  skip('server.js require: checkDuplicateScan already imported');
} else if (!svr.includes(OLD_REQUIRE)) {
  fail('server.js require: anchor not found');
} else {
  svr = svr.replace(OLD_REQUIRE, NEW_REQUIRE);
  ok('server.js: checkDuplicateScan imported');
}

// 2b. Add 5-part QR format to parseBarcode (insert before existing 4-part match)
const OLD_PARSE_ANCHOR = "  // Format: SKU-ABBR-TRAYS-YYYYMMDD  e.g. 01001-PCM-1-20260417\n  const matchWithDate = clean.match(";
const NEW_PARSE_BLOCK  = `  // Format: TICKETNUM-SKU-ABBR-TRAYS-YYYYMMDD  e.g. 002-01002-PCM-1-20260522
  // The 3-digit ticket number is the daily sequential number printed on the physical ticket.
  // This is the preferred format — enables duplicate scan detection.
  const match5 = clean.match(/^(\\d{3})-([A-Z0-9]+)-([A-Z0-9&]+)-([0-9.]+)-([0-9]{8})$/);
  if (match5) {
    const ticketNum = match5[1];
    const sku       = match5[2];
    const abbr      = match5[3];
    const trays     = parseFloat(match5[4]);
    const raw       = match5[5];
    const date      = raw.slice(0,4) + '-' + raw.slice(4,6) + '-' + raw.slice(6,8);
    const location  = LOCATION_MAP[abbr];
    if (!location) return { error: 'Unknown location abbreviation: ' + abbr };
    if (isNaN(trays)) return { error: 'Invalid tray quantity in barcode: ' + match5[4] };
    return { ticket_num: ticketNum, sku, location, trays, date };
  }

  // Format: SKU-ABBR-TRAYS-YYYYMMDD  e.g. 01001-PCM-1-20260417\n  const matchWithDate = clean.match(`;

if (svr.includes('match5')) {
  skip('server.js parseBarcode: 5-part format already present');
} else if (!svr.includes(OLD_PARSE_ANCHOR)) {
  fail('server.js parseBarcode: anchor not found');
} else {
  svr = svr.replace(OLD_PARSE_ANCHOR, NEW_PARSE_BLOCK);
  ok('server.js parseBarcode: 5-part QR format added');
}

// 2c. Add duplicate gate + master_ticket_ref before insertScan call
const OLD_INSERT_SCAN = "    // Write the scan record\n    const result = await insertScan({";
const NEW_INSERT_SCAN = `    // ── Duplicate scan check ────────────────────────────────────────────────────
    // master_ticket_ref = "ticket_num-YYYY-MM-DD"  e.g. "002-2026-05-22"
    // Only active when the new 5-part QR format is used (parsed.ticket_num exists).
    const _scanDate  = req.body.scan_date
      || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const _masterRef = parsed.ticket_num ? (parsed.ticket_num + '-' + _scanDate) : null;
    if (_masterRef) {
      const _dup = await checkDuplicateScan(_masterRef, scan_type);
      if (_dup) {
        return res.status(409).json({
          error: 'Ticket #' + parsed.ticket_num + ' (' + (ticket.item_name || ticket.sku) + ')' +
                 ' has already been ' + scan_type + ' today' +
                 ' — scanned at ' + _dup.scan_timestamp +
                 ' by ' + (_dup.scanned_by || 'unknown') +
                 ' (' + _dup.actual_trays + ' trays).' +
                 ' If this is a mistake, ask a manager to void the original scan.',
          duplicate: true,
          master_ticket_ref: _masterRef,
          existing: _dup,
        });
      }
    }

    // Write the scan record
    const result = await insertScan({`;

if (svr.includes('_masterRef')) {
  skip('server.js duplicate gate: already present');
} else if (!svr.includes(OLD_INSERT_SCAN)) {
  fail('server.js insertScan: anchor not found');
} else {
  svr = svr.replace(OLD_INSERT_SCAN, NEW_INSERT_SCAN);
  ok('server.js: duplicate gate inserted before insertScan');
}

// 2d. Pass master_ticket_ref into insertScan call
const OLD_NOTES_LINE = "      notes: notes || null,\n    });";
const NEW_NOTES_LINE = "      notes: notes || null,\n      master_ticket_ref: _masterRef || null,\n    });";

if (svr.includes('master_ticket_ref: _masterRef')) {
  skip('server.js insertScan call: master_ticket_ref already passed');
} else if (!svr.includes(OLD_NOTES_LINE)) {
  fail('server.js insertScan call: notes anchor not found');
} else {
  svr = svr.replace(OLD_NOTES_LINE, NEW_NOTES_LINE);
  ok('server.js insertScan call: master_ticket_ref added');
}

fs.writeFileSync(svrPath, svr);
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
// 3. index.html — fix tray auto-select for 5-part barcode
// ─────────────────────────────────────────────────────────────────────────────
// The 5-part barcode has trays at index [3], not [2].
// Old 4-part: SKU-LOC-TRAYS-DATE  → trays at [2]
// New 5-part: NUM-SKU-LOC-TRAYS-DATE → trays at [3]

const htmlFile = fs.existsSync(htmlPath) ? htmlPath : path.join(BASE, 'index.html');
if (!fs.existsSync(htmlFile)) {
  skip('index.html: file not found at public/ or root — skipping tray fix');
} else {
  let html = fs.readFileSync(htmlFile, 'utf8');

  const OLD_TRAY = "      const barcodeParts = String(barcode).split('-');\n      const barcodeTrays = barcodeParts.length >= 3 ? parseFloat(barcodeParts[2]) : NaN;";
  const NEW_TRAY = "      const barcodeParts = String(barcode).split('-');\n      // 5-part: NUM-SKU-LOC-TRAYS-DATE → trays at [3] | 4-part: SKU-LOC-TRAYS-DATE → trays at [2]\n      const barcodeTrays = barcodeParts.length === 5 ? parseFloat(barcodeParts[3])\n                         : barcodeParts.length >= 3   ? parseFloat(barcodeParts[2])\n                         : NaN;";

  if (html.includes('5-part: NUM-SKU-LOC-TRAYS')) {
    skip('index.html tray select: already updated');
  } else if (!html.includes(OLD_TRAY)) {
    skip('index.html tray select: anchor not found (may already be updated)');
  } else {
    html = html.replace(OLD_TRAY, NEW_TRAY);
    fs.writeFileSync(htmlFile, html);
    ok('index.html: tray auto-select updated for 5-part barcode');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
console.log('');
if (errors > 0) {
  console.error(`⚠  ${errors} error(s) above — review before restarting the server.`);
  process.exit(1);
} else {
  console.log('✓ All patches applied cleanly.');
  console.log('');
  console.log('  pm2 restart scan-to-ship');
  console.log('  pm2 logs scan-to-ship --lines 20');
}
