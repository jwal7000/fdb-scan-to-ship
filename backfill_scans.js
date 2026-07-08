/**
 * backfill_scans.js
 *
 * Backfills shipped scan records for any June 24 forecast items that
 * were not scanned by 2nd shift due to the duplicate-key bug.
 *
 * Dry-run by default — prints what WOULD be inserted, nothing touches the DB.
 * Add --confirm to actually write the records.
 *
 * Usage (run from scan-to-ship directory on Mac mini):
 *   node backfill_scans.js                  ← dry run
 *   node backfill_scans.js --confirm         ← write to DB
 *   node backfill_scans.js 2026-06-24        ← explicit date (default = today Central)
 *   node backfill_scans.js 2026-06-24 --confirm
 */

'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mysql = require('mysql2/promise');

async function main() {
  const args    = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const dateArg = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a));
  const date    = dateArg || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  console.log(`Backfill target date : ${date}`);
  console.log(`Mode                 : ${confirm ? '*** WRITING TO DB ***' : 'DRY RUN (use --confirm to write)'}`);
  console.log('');

  // Read pool — just for the SELECT
  const readPool = mysql.createPool({
    host:     process.env.MYSQL_HOST     || '104.197.166.101',
    user:     process.env.MYSQL_USER     || 'FDB_SteveConnect',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DB       || 'production',
    waitForConnections: true,
    connectionLimit: 3,
  });

  // Write pool — for the INSERTs
  const writePool = mysql.createPool({
    host:     process.env.MYSQL_WRITE_HOST     || '104.197.166.101',
    user:     process.env.MYSQL_WRITE_USER     || 'scan_app',
    password: process.env.MYSQL_WRITE_PASSWORD || '',
    database: process.env.MYSQL_DB             || 'production',
    waitForConnections: true,
    connectionLimit: 3,
  });

  try {
    // Find all forecast items for this date that have NO shipped scan yet
    const [missing] = await readPool.execute(`
      SELECT
        pf.id                AS item_level_id,
        pf.Forecast_Date     AS forecast_date,
        pf.Location          AS location,
        pf.SKU               AS sku,
        pf.Item_Name         AS item_name,
        pf.Item_Category     AS category,
        COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays) AS planned_trays
      FROM Production_Forecast_Item_Level pf
      WHERE pf.Forecast_Date = ?
        AND NOT EXISTS (
          SELECT 1
          FROM Kitchen_Shipment_Scans s
          WHERE s.item_level_id = pf.id
            AND s.scan_type     = 'shipped'
            AND s.forecast_date = ?
        )
      ORDER BY pf.Location, pf.Item_Name
    `, [date, date]);

    if (missing.length === 0) {
      console.log('✓ No missing scans found — all forecast items for this date already have a shipped scan.');
      return;
    }

    console.log(`Found ${missing.length} item(s) with no shipped scan for ${date}:\n`);

    // Print a preview table
    const colW = [28, 20, 12, 8];
    const header = [
      'Location'.padEnd(colW[0]),
      'Item Name'.padEnd(colW[1]),
      'SKU'.padEnd(colW[2]),
      'Trays'.padStart(colW[3]),
    ].join('  ');
    console.log(header);
    console.log('─'.repeat(header.length));

    let totalTrays = 0;
    for (const row of missing) {
      const trays = parseFloat(row.planned_trays) || 0;
      totalTrays += trays;
      console.log([
        (row.location  || '').slice(0, colW[0]).padEnd(colW[0]),
        (row.item_name || row.sku || '').slice(0, colW[1]).padEnd(colW[1]),
        (row.sku       || '').slice(0, colW[2]).padEnd(colW[2]),
        String(trays).padStart(colW[3]),
      ].join('  '));
    }
    console.log('─'.repeat(header.length));
    console.log(`${'TOTAL'.padEnd(colW[0] + colW[1] + colW[2] + 4)}  ${String(totalTrays).padStart(colW[3])}`);
    console.log('');

    if (!confirm) {
      console.log('DRY RUN complete — nothing written.');
      console.log('Re-run with --confirm to insert these records.');
      return;
    }

    // Timestamp: use 10 PM Central last night (UTC = 03:00 today)
    const scanTimestamp = new Date(date + 'T03:00:00Z');

    console.log(`Inserting ${missing.length} record(s) with scan_timestamp ${scanTimestamp.toISOString()} ...`);
    console.log('');

    let inserted = 0;
    let skipped  = 0;

    for (const row of missing) {
      const trays = parseFloat(row.planned_trays) || 0;
      if (trays <= 0) { skipped++; continue; }
      await writePool.execute(`
        INSERT INTO Kitchen_Shipment_Scans
          (scan_timestamp, item_level_id, forecast_date, location, sku,
           planned_trays, actual_trays, scan_type, scanned_by, device_id,
           notes, master_ticket_ref)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'shipped', '2nd Shift Backfill', 'backfill',
                'Backfilled — missed due to duplicate scan bug 2026-06-23', NULL)
      `, [scanTimestamp, row.item_level_id, row.forecast_date, row.location, row.sku, trays, trays]);
      console.log(`  ✓ ${row.location} / ${row.item_name} — ${trays} trays`);
      inserted++;
    }
    console.log(`\nDone — inserted: ${inserted} | skipped (0 trays): ${skipped}`);

    const [check] = await readPool.execute(`
      SELECT location, COUNT(*) AS scans, SUM(actual_trays) AS trays
      FROM Kitchen_Shipment_Scans
      WHERE scan_type = 'shipped' AND forecast_date = ?
        AND scanned_by = '2nd Shift Backfill'
      GROUP BY location ORDER BY location
    `, [date]);
    if (check.length > 0) {
      console.log('\nVerification — backfill records in DB:');
      check.forEach(r => console.log(`  ${r.location}: ${r.scans} scan(s), ${r.trays} trays`));
    }
  } finally {
    await readPool.end();
    await writePool.end();
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
