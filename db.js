/**
 * db.js — Database connection layer
 *
 * Read queries: MySQL (FDB production DB, read-only credentials)
 * Write queries: MySQL if write credentials are configured, otherwise SQLite fallback
 *
 * Jesse: to enable MySQL writes, set MYSQL_WRITE_* env vars (see .env.example)
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mysql = require('mysql2/promise');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// ── MySQL read pool (FDB production) ──────────────────────────────────────────
const readPool = mysql.createPool({
  host: process.env.MYSQL_HOST || '104.197.166.101',
  user: process.env.MYSQL_USER || 'FDB_SteveConnect',
  password: process.env.MYSQL_PASSWORD || '',
  database: process.env.MYSQL_DB || 'production',
  waitForConnections: true,
  connectionLimit: 5,
  connectTimeout: 10000,
});

readPool.pool.on('error', (err) => { console.error('[read pool error]', err.message); });

// ── MySQL write pool (separate write-capable user, optional) ──────────────────
let writePool = null;
if (process.env.MYSQL_WRITE_USER && process.env.MYSQL_WRITE_PASSWORD) {
  writePool = mysql.createPool({
    host: process.env.MYSQL_WRITE_HOST || process.env.MYSQL_HOST || '104.197.166.101',
    user: process.env.MYSQL_WRITE_USER,
    password: process.env.MYSQL_WRITE_PASSWORD,
    database: process.env.MYSQL_WRITE_DB || process.env.MYSQL_DB || 'production',
    waitForConnections: true,
    connectionLimit: 5,
    connectTimeout: 10000,
  });
  console.log('MySQL write pool configured');
} else {
  console.log('No MySQL write credentials — using SQLite fallback for scan writes');
}


// Offline mode flag (set to true when MySQL is unreachable)
let offlineMode = false;
// ── SQLite fallback ───────────────────────────────────────────────────────────
const SQLITE_PATH = path.join(__dirname, 'scans_local.sqlite');
let sqliteDb = null;

function getSqlite() {
  if (!sqliteDb) {
    sqliteDb = new Database(SQLITE_PATH);
    sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS Kitchen_Shipment_Scans (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        scan_timestamp DATETIME NOT NULL DEFAULT (datetime('now')),
        item_level_id INTEGER NOT NULL,
        forecast_date  TEXT NOT NULL,
        location       TEXT NOT NULL,
        sku            TEXT NOT NULL,
        planned_trays  REAL,
        actual_trays   REAL NOT NULL,
        scan_type      TEXT NOT NULL CHECK(scan_type IN ('shipped','received')),
        scanned_by     TEXT,
        device_id      TEXT,
        notes          TEXT,
        synced         INTEGER NOT NULL DEFAULT 0,
        master_ticket_ref TEXT
      );
      CREATE TABLE IF NOT EXISTS Forecast_Cache (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        item_level_id INTEGER,
        forecast_date TEXT NOT NULL,
        location      TEXT NOT NULL,
        sku           TEXT NOT NULL,
        item_name     TEXT,
        category      TEXT,
        planned_trays REAL,
        cached_at     DATETIME DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_fc ON Forecast_Cache(forecast_date, location, sku);
    `);
  }

  // Migrate: add synced column if table was created before offline mode
  try { sqliteDb.exec('ALTER TABLE Kitchen_Shipment_Scans ADD COLUMN synced INTEGER NOT NULL DEFAULT 0'); } catch(e) {}
  // Migrate: add master_ticket_ref for duplicate scan detection
  try { sqliteDb.exec('ALTER TABLE Kitchen_Shipment_Scans ADD COLUMN master_ticket_ref TEXT'); } catch(e) {}
  return sqliteDb;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a SELECT against the FDB MySQL read replica.
 */
function centralNow() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Chicago' });
}

async function query(sql, params = []) {
  const [rows] = await readPool.execute(sql, params);
  return rows;
}

/**
 * Insert a scan record — MySQL if write pool configured, SQLite otherwise.
 * Returns { id, backend } where backend is 'mysql' or 'sqlite'.
 */
async function insertScan(record) {
  const {
    item_level_id, forecast_date, location, sku,
    planned_trays, actual_trays, scan_type, scanned_by, device_id, notes,
    master_ticket_ref
  } = record;

  const scanTime = centralNow();

  if (writePool && !offlineMode) {
    try {
      const [result] = await writePool.execute(
        'INSERT INTO Kitchen_Shipment_Scans (scan_timestamp, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by, device_id, notes, master_ticket_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [scanTime, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by || null, device_id || null, notes || null, master_ticket_ref || null]
      );
      return { id: result.insertId, backend: 'mysql' };
    } catch (e) {
      console.error('[insertScan] MySQL failed, switching to offline mode:', e.message);
      offlineMode = true;
    }
  }

  // SQLite fallback (synced=0 means needs sync to MySQL, synced=1 means permanent SQLite storage)
  const db = getSqlite();
  const synced = writePool ? 0 : 1;
  const stmt = db.prepare(
    'INSERT INTO Kitchen_Shipment_Scans (scan_timestamp, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by, device_id, notes, synced, master_ticket_ref) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const info = stmt.run(
    scanTime, item_level_id, forecast_date, location, sku,
    planned_trays !== null && planned_trays !== undefined ? planned_trays : null,
    actual_trays, scan_type,
    scanned_by || null, device_id || null, notes || null, synced, master_ticket_ref || null
  );
  return { id: info.lastInsertRowid, backend: 'sqlite' };
}

/**
 * Fetch recent scans for display — from SQLite if no write pool, else MySQL.
 */
async function recentScans(limit = 20) {
  if (writePool) {
    const [rows] = await writePool.query(
      `SELECT s.*, pf.Item_Name AS item_name,
              COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays, s.planned_trays) AS planned_trays
       FROM Kitchen_Shipment_Scans s
       LEFT JOIN Production_Forecast_Item_Level pf
         ON pf.SKU = s.sku
         AND pf.Location = s.location
         AND DATE(pf.Forecast_Date) = DATE(s.forecast_date)
       ORDER BY s.scan_timestamp DESC
       LIMIT ${parseInt(limit)}`
    );
    return rows;
  }
  const db = getSqlite();
  return db.prepare(
    `SELECT * FROM Kitchen_Shipment_Scans ORDER BY scan_timestamp DESC LIMIT ?`
  ).all(limit);
}

/**
 * Reconciliation query for a given date — from SQLite if no write pool, else MySQL.
 */
async function reconciliation(date) {
  if (writePool) {
    const [rows] = await writePool.execute(
      `SELECT
         agg.location,
         SUM(COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays)) AS planned_trays,
         SUM(agg.shipped_trays)  AS shipped_trays,
         SUM(agg.received_trays) AS received_trays,
         SUM(agg.shipped_trays) - COALESCE(SUM(agg.received_trays), 0) AS transit_gap
       FROM (
         SELECT sh.location, sh.sku, sh.forecast_date,
           SUM(sh.actual_trays) AS shipped_trays,
           SUM(rc_agg.actual_trays) AS received_trays
         FROM Kitchen_Shipment_Scans sh
         LEFT JOIN (
           SELECT sku, location, forecast_date, SUM(actual_trays) AS actual_trays
           FROM Kitchen_Shipment_Scans WHERE scan_type = 'received'
           GROUP BY sku, location, forecast_date
         ) rc_agg ON rc_agg.sku = sh.sku AND rc_agg.location = sh.location AND rc_agg.forecast_date = sh.forecast_date
         WHERE sh.scan_type = 'shipped' AND sh.forecast_date = ?
         GROUP BY sh.location, sh.sku, sh.forecast_date
       ) agg
       LEFT JOIN Production_Forecast_Item_Level pf
         ON pf.SKU = agg.sku AND pf.Location = agg.location AND DATE(pf.Forecast_Date) = DATE(agg.forecast_date)
       GROUP BY agg.location
       ORDER BY agg.location`,
      [date]
    );
    return rows;
  }
  const db = getSqlite();
  return db.prepare(
    `SELECT
       sh.location,
       SUM(sh.planned_trays)  AS planned_trays,
       SUM(sh.actual_trays)   AS shipped_trays,
       SUM(rc.actual_trays)   AS received_trays,
       SUM(sh.actual_trays) - COALESCE(SUM(rc.actual_trays), 0) AS transit_gap
     FROM Kitchen_Shipment_Scans sh
     LEFT JOIN Kitchen_Shipment_Scans rc
       ON rc.item_level_id = sh.item_level_id AND rc.scan_type = 'received'
     WHERE sh.scan_type = 'shipped' AND sh.forecast_date = ?
     GROUP BY sh.location
     ORDER BY sh.location`
  ).all(date);
}



async function reconciliationByCategory(date) {
  if (writePool) {
    const [rows] = await writePool.execute(
      `SELECT
         agg.location,
         COALESCE(pf.Item_Category, 'Unknown') AS category,
         SUM(COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays)) AS planned_trays,
         SUM(agg.shipped_trays)  AS shipped_trays,
         SUM(agg.received_trays) AS received_trays,
         SUM(agg.shipped_trays) - COALESCE(SUM(agg.received_trays), 0) AS transit_gap
       FROM (
         SELECT sh.location, sh.sku, sh.forecast_date,
           SUM(sh.actual_trays) AS shipped_trays,
           SUM(rc_agg.actual_trays) AS received_trays
         FROM Kitchen_Shipment_Scans sh
         LEFT JOIN (
           SELECT sku, location, forecast_date, SUM(actual_trays) AS actual_trays
           FROM Kitchen_Shipment_Scans WHERE scan_type = 'received'
           GROUP BY sku, location, forecast_date
         ) rc_agg ON rc_agg.sku = sh.sku AND rc_agg.location = sh.location AND rc_agg.forecast_date = sh.forecast_date
         WHERE sh.scan_type = 'shipped' AND sh.forecast_date = ?
         GROUP BY sh.location, sh.sku, sh.forecast_date
       ) agg
       LEFT JOIN Production_Forecast_Item_Level pf
         ON pf.SKU = agg.sku AND pf.Location = agg.location AND DATE(pf.Forecast_Date) = DATE(agg.forecast_date)
       GROUP BY agg.location, COALESCE(pf.Item_Category, 'Unknown')
       ORDER BY agg.location, COALESCE(pf.Item_Category, 'Unknown')`,
      [date]
    );
    return rows;
  }
  return [];
}

async function getScannedTotal(item_level_id, scan_type) {
  if (writePool) {
    const [rows] = await writePool.query(
      `SELECT COALESCE(SUM(actual_trays), 0) AS total FROM Kitchen_Shipment_Scans WHERE item_level_id = ? AND scan_type = ?`,
      [item_level_id, scan_type]
    );
    return parseFloat(rows[0].total);
  }
  const db = getSqlite();
  const row = db.prepare(
    `SELECT COALESCE(SUM(actual_trays), 0) AS total FROM Kitchen_Shipment_Scans WHERE item_level_id = ? AND scan_type = ?`
  ).get(item_level_id, scan_type);
  return parseFloat(row ? row.total : 0);
}

async function deleteScan(id) {
  if (writePool) {
    const [result] = await writePool.query(
      `DELETE FROM Kitchen_Shipment_Scans WHERE id = ?`, [id]
    );
    return result.affectedRows > 0;
  }
  const db = getSqlite();
  const result = db.prepare(`DELETE FROM Kitchen_Shipment_Scans WHERE id = ?`).run(id);
  return result.changes > 0;
}


// ── Offline mode state ────────────────────────────────────────────────────────
function getOfflineMode() { return offlineMode; }

function getPendingSync() {
  try {
    return getSqlite().prepare('SELECT COUNT(*) as n FROM Kitchen_Shipment_Scans WHERE synced = 0').get().n;
  } catch (e) { return 0; }
}

function getStatus() {
  return { online: !offlineMode, pendingSync: getPendingSync() };
}

// ── Forecast cache ────────────────────────────────────────────────────────────
async function cacheForecasts(dates) {
  const sqlite = getSqlite();
  for (const date of dates) {
    try {
      const rows = await query(
        'SELECT pf.id AS item_level_id, DATE(pf.Forecast_Date) AS forecast_date, pf.Location AS location, pf.SKU AS sku, pf.Item_Name AS item_name, pf.Item_Category AS category, COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays) AS planned_trays FROM Production_Forecast_Item_Level pf WHERE DATE(pf.Forecast_Date) = ?',
        [date]
      );
      sqlite.prepare('DELETE FROM Forecast_Cache WHERE forecast_date = ?').run(date);
      const ins = sqlite.prepare('INSERT INTO Forecast_Cache (item_level_id, forecast_date, location, sku, item_name, category, planned_trays) VALUES (?, ?, ?, ?, ?, ?, ?)');
      sqlite.transaction(function(rs) { rs.forEach(function(r) { ins.run(r.item_level_id, r.forecast_date, r.location, r.sku, r.item_name, r.category, r.planned_trays); }); })(rows);
      console.log('[cache] Cached ' + rows.length + ' forecast rows for ' + date);
    } catch (e) {
      console.error('[cache] Failed for ' + date + ':', e.message);
    }
  }
}

function queryForecastCache(sku, location, date) {
  try {
    return getSqlite().prepare('SELECT * FROM Forecast_Cache WHERE sku = ? AND location = ? AND forecast_date = ? LIMIT 1').get(sku, location, date) || null;
  } catch (e) { return null; }
}

function queryForecastCacheById(id) {
  try {
    return getSqlite().prepare('SELECT * FROM Forecast_Cache WHERE item_level_id = ? LIMIT 1').get(id) || null;
  } catch (e) { return null; }
}

// ── Sync offline scans back to MySQL ─────────────────────────────────────────
async function syncOfflineScans() {
  if (!writePool) return 0;
  const sqlite = getSqlite();
  const rows = sqlite.prepare('SELECT * FROM Kitchen_Shipment_Scans WHERE synced = 0').all();
  if (!rows.length) return 0;
  let synced = 0;
  for (const row of rows) {
    try {
      await writePool.execute(
        'INSERT IGNORE INTO Kitchen_Shipment_Scans (scan_timestamp, item_level_id, forecast_date, location, sku, planned_trays, actual_trays, scan_type, scanned_by, device_id, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [row.scan_timestamp, row.item_level_id, row.forecast_date, row.location, row.sku, row.planned_trays, row.actual_trays, row.scan_type, row.scanned_by, row.device_id, row.notes]
      );
      sqlite.prepare('UPDATE Kitchen_Shipment_Scans SET synced = 1 WHERE id = ?').run(row.id);
      synced++;
    } catch (e) {
      console.error('[sync] Failed on scan id=' + row.id + ':', e.message);
      break;
    }
  }
  console.log('[sync] Synced ' + synced + '/' + rows.length + ' offline scans to MySQL');
  return synced;
}

// ── Health check (runs every 30s) ─────────────────────────────────────────────
function startHealthCheck() {
  setInterval(async function() {
    if (!writePool) return;
    try {
      await writePool.query('SELECT 1');
      if (offlineMode) {
        console.log('[health] MySQL back online — syncing and refreshing cache');
        offlineMode = false;
        await syncOfflineScans();
        var today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        var tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
        await cacheForecasts([today, tomorrow]);
      }
    } catch (e) {
      if (!offlineMode) {
        console.log('[health] MySQL unreachable — entering offline mode');
        offlineMode = true;
      }
    }
  }, 30000);
}


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

module.exports = {getRackPosition, query, insertScan, recentScans, reconciliation, reconciliationByCategory, getScannedTotal, deleteScan, getStatus, cacheForecasts, queryForecastCache, queryForecastCacheById, startHealthCheck, syncOfflineScans, checkDuplicateScan };

async function getRackPosition(forecast_date, location, sku) {
  try {
    const rows = await query(
      `SELECT rack_number, rung_label, is_allergen, color, category
       FROM Rack_Assignments
       WHERE forecast_date = ? AND location = ? AND sku = ?
       LIMIT 1`,
      [forecast_date, location, sku]
    );
    return rows[0] || null;
  } catch (e) {
    console.warn('[getRackPosition] error:', e.message);
    return null;
  }
}
