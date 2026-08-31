'use strict';
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const mysql = require('mysql2/promise');
const Database = require('better-sqlite3');

const SQLITE_PATH = path.join(__dirname, 'scans_local.sqlite');

const CONN_CONFIG = {
  host:                 process.env.MYSQL_WRITE_HOST || '127.0.0.1',
  port:                 parseInt(process.env.MYSQL_WRITE_PORT || '3307'),
  user:                 process.env.MYSQL_WRITE_USER || 'scan_app',
  password:             process.env.MYSQL_WRITE_PASSWORD || '',
  database:             process.env.MYSQL_WRITE_DB || 'production',
  ssl:                  false,
  enableCleartextPlugin: true,
  connectTimeout:       10000,
};

async function main() {
  const db = new Database(SQLITE_PATH);
  const rows = db.prepare(
    'SELECT * FROM Kitchen_Shipment_Scans WHERE synced = 0 ORDER BY scan_timestamp'
  ).all();

  console.log(`Unsynced rows in SQLite: ${rows.length}`);
  if (rows.length === 0) { console.log('Nothing to sync.'); db.close(); return; }
  console.log(`  First: ${rows[0].scan_timestamp}`);
  console.log(`  Last:  ${rows[rows.length-1].scan_timestamp}\n`);

  // Test connection first
  let conn;
  try {
    conn = await mysql.createConnection(CONN_CONFIG);
    await conn.execute('SELECT 1');
    console.log('MySQL connected OK\n');
  } catch (err) {
    console.error('MySQL connection failed:', err.message);
    if (conn) await conn.end();
    db.close();
    process.exit(1);
  }

  let synced = 0, skipped = 0, failed = 0;
  const markSynced = db.prepare('UPDATE Kitchen_Shipment_Scans SET synced = 1 WHERE id = ?');

  for (const row of rows) {
    try {
      await conn.execute(
        `INSERT INTO Kitchen_Shipment_Scans
           (scan_timestamp,item_level_id,forecast_date,location,sku,
            planned_trays,actual_trays,scan_type,scanned_by,device_id,notes,master_ticket_ref)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          row.scan_timestamp, String(row.item_level_id), row.forecast_date,
          row.location, row.sku, row.planned_trays ?? null, row.actual_trays,
          row.scan_type, row.scanned_by ?? null, row.device_id ?? null,
          row.notes ?? null, row.master_ticket_ref ?? null,
        ]
      );
      markSynced.run(row.id);
      synced++;
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') { markSynced.run(row.id); skipped++; }
      else { console.error(`  x id=${row.id} (${row.location} ${row.scan_timestamp}): ${err.message}`); failed++; }
    }
  }

  await conn.end();
  db.close();
  console.log(`Done: synced=${synced}  skipped=${skipped}  failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
