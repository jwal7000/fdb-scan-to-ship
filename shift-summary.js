/**
 * shift-summary.js — overnight 2nd/3rd shift production summary → #kitchenlead
 *
 * Usage:
 *   node shift-summary.js               ← today's delivery date (run in the morning)
 *   node shift-summary.js 2026-08-20    ← specific delivery date
 *   node shift-summary.js --dry-run     ← print, don't send
 *
 * 2nd shift = scans before midnight Central; 3rd shift = midnight onward.
 * Expected tickets = sum of CEIL(planned trays) per forecast item (one ticket
 * per full tray plus one for any partial).
 */
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mysql = require('mysql2/promise');

const CHANNEL = 'kitchenlead';
const CATEGORY_ORDER = ['Hundred Layer Donuts', 'Mini Hundred Layer Donuts', 'Yeast Raised Donuts'];
const CATEGORY_LABELS = {
  'Hundred Layer Donuts': '100 Layer',
  'Mini Hundred Layer Donuts': 'Mini',
  'Yeast Raised Donuts': 'Yeast Raised',
};
function catPriority(c) { const i = CATEGORY_ORDER.indexOf(c); return i === -1 ? CATEGORY_ORDER.length : i; }
function fmt(n) { return n % 1 === 0 ? String(n) : parseFloat(n.toFixed(2)).toString(); }
function fmtTime(ts) {
  const t = ts.split(' ')[1] || '';
  let h = parseInt(t.slice(0, 2), 10);
  const m = t.slice(3, 5);
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return h + ':' + m + ' ' + ap;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  const date = args[0] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!SLACK_TOKEN && !dryRun) { console.error('SLACK_BOT_TOKEN not set'); process.exit(1); }

  const pool = mysql.createPool({
    host: process.env.MYSQL_HOST || '104.197.166.101',
    user: process.env.MYSQL_USER || 'FDB_SteveConnect',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DB || 'production',
    dateStrings: true,
    waitForConnections: true, connectionLimit: 3, connectTimeout: 10000,
  });

  try {
    const [forecast] = await pool.execute(`
      SELECT Location AS location, SKU AS sku, Item_Name AS item_name, Item_Category AS category,
             COALESCE(Kitchen_Override_Trays, Final_Forecasted_Trays) AS planned_trays
      FROM Production_Forecast_Item_Level
      WHERE Forecast_Date = ?
        AND COALESCE(Kitchen_Override_Trays, Final_Forecasted_Trays) > 0
    `, [date]);

    const [scans] = await pool.execute(`
      SELECT s.location, s.sku, s.actual_trays, s.scan_timestamp, s.scanned_by,
             COALESCE(pf.Item_Name, s.sku) AS item_name, pf.Item_Category AS category
      FROM Kitchen_Shipment_Scans s
      LEFT JOIN Production_Forecast_Item_Level pf ON pf.id = s.item_level_id
      WHERE s.forecast_date = ? AND s.scan_type = 'shipped'
      ORDER BY s.scan_timestamp
    `, [date]);

    const midnight = date + ' 00:00:00';
    const shifts = {
      '2nd': { tickets: 0, trays: 0, byCat: {}, first: null, last: null },
      '3rd': { tickets: 0, trays: 0, byCat: {}, first: null, last: null },
    };
    const scannedByItem = {};
    let manualCount = 0, manualTrays = 0;

    for (const s of scans) {
      const trays = parseFloat(s.actual_trays);
      const key = s.location + '|' + s.sku;
      scannedByItem[key] = (scannedByItem[key] || 0) + trays;
      if (s.scanned_by === 'MANUAL') { manualCount++; manualTrays += trays; continue; }
      const sh = s.scan_timestamp < midnight ? shifts['2nd'] : shifts['3rd'];
      sh.tickets++;
      sh.trays += trays;
      const cat = s.category || 'Other';
      sh.byCat[cat] = (sh.byCat[cat] || 0) + trays;
      if (!sh.first) sh.first = s.scan_timestamp;
      sh.last = s.scan_timestamp;
    }

    const expectedTickets = forecast.reduce((n, f) => n + Math.ceil(parseFloat(f.planned_trays)), 0);
    const expectedTrays   = forecast.reduce((n, f) => n + parseFloat(f.planned_trays), 0);
    const scannedTickets  = scans.filter(s => s.scanned_by !== 'MANUAL').length;
    const scannedTrays    = scans.reduce((n, s) => n + parseFloat(s.actual_trays), 0);
    const unscanned = forecast.filter(f => !scannedByItem[f.location + '|' + f.sku]);
    const shorts = [], overs = [];
    for (const f of forecast) {
      const got = scannedByItem[f.location + '|' + f.sku];
      if (got === undefined) continue;
      const d = got - parseFloat(f.planned_trays);
      if (d < -0.001) shorts.push({ f, got, d });
      else if (d > 0.001) overs.push({ f, got, d });
    }

    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US',
      { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago' });
    const totalDelta = scannedTrays - expectedTrays;
    const pct = expectedTickets ? Math.round(scannedTickets / expectedTickets * 100) : 0;

    const L = [];
    L.push('🌙 *Overnight Production — ' + dateLabel + '*');
    L.push('');
    L.push('*Tickets:* ' + scannedTickets + ' scanned / ~' + expectedTickets + ' expected (' + pct + '%)');
    L.push('*Trays:* ' + fmt(scannedTrays) + ' scanned / ' + fmt(expectedTrays) + ' planned (Δ ' + (totalDelta >= 0 ? '+' : '') + fmt(totalDelta) + ')');
    if (manualCount) L.push('✋ ' + manualCount + ' manual entries (' + fmt(manualTrays) + ' trays) — backfilled, not scanned');
    L.push('');
    let cumTickets = 0, cumTrays = 0;
    for (const name of ['2nd', '3rd']) {
      const sh = shifts[name];
      cumTickets += sh.tickets;
      cumTrays += sh.trays;
      const cumPct = expectedTickets ? Math.round(cumTickets / expectedTickets * 100) : 0;
      const cumDelta = cumTrays - expectedTrays;
      L.push('*' + name + ' Shift* — ' + sh.tickets + ' tickets · ' + fmt(sh.trays) + ' trays');
      L.push('  _Cumulative: ' + cumTickets + ' / ~' + expectedTickets + ' tickets (' + cumPct + '%) · ' + fmt(cumTrays) + ' / ' + fmt(expectedTrays) + ' trays' + (name === '3rd' ? ' (Δ ' + (cumDelta >= 0 ? '+' : '') + fmt(cumDelta) + ')' : '') + '_');
      const cats = Object.keys(sh.byCat).sort((a, b) => catPriority(a) - catPriority(b));
      if (!cats.length) L.push('  _no scans_');
      cats.forEach(c => L.push('  • ' + (CATEGORY_LABELS[c] || c) + ': ' + fmt(sh.byCat[c])));
      if (sh.first) L.push('  ⏱ ' + fmtTime(sh.first) + ' → ' + fmtTime(sh.last));
      L.push('');
    }
    if (unscanned.length) {
      const unTrays = unscanned.reduce((n, f) => n + parseFloat(f.planned_trays), 0);
      L.push('⚠️ *Not scanned (' + unscanned.length + ' items · ' + fmt(unTrays) + ' trays):*');
      unscanned.slice(0, 12).forEach(f => L.push('  • ' + f.location + ' — ' + f.item_name + ' (' + fmt(parseFloat(f.planned_trays)) + ')'));
      if (unscanned.length > 12) L.push('  _…' + (unscanned.length - 12) + ' more in thread_');
    } else {
      L.push('✅ Every expected item was scanned');
    }
    L.push('');
    L.push('_Delta detail + full breakdown in thread_ 🧵');

    const T = [];
    T.push('*Delta Detail — ' + dateLabel + '*');
    const groupByStore = (rows, getLoc) => {
      const g = {};
      rows.forEach(r => { const l = getLoc(r); (g[l] = g[l] || []).push(r); });
      return g;
    };
    if (shorts.length) {
      T.push('');
      T.push('*Short vs plan (' + shorts.length + ') — scanned/planned:*');
      const g = groupByStore(shorts, x => x.f.location);
      Object.keys(g).sort().forEach(loc =>
        T.push('• *' + loc + ':* ' + g[loc].map(x => x.f.item_name + ' ' + fmt(x.got) + '/' + fmt(parseFloat(x.f.planned_trays))).join(' · ')));
    }
    if (overs.length) {
      T.push('');
      T.push('*Over plan (' + overs.length + ') — scanned/planned:*');
      const g = groupByStore(overs, x => x.f.location);
      Object.keys(g).sort().forEach(loc =>
        T.push('• *' + loc + ':* ' + g[loc].map(x => x.f.item_name + ' ' + fmt(x.got) + '/' + fmt(parseFloat(x.f.planned_trays))).join(' · ')));
    }
    if (unscanned.length) {
      T.push('');
      T.push('*Never scanned (' + unscanned.length + ') — planned trays:*');
      const g = groupByStore(unscanned, f => f.location);
      Object.keys(g).sort().forEach(loc =>
        T.push('• *' + loc + ':* ' + g[loc].map(f => f.item_name + ' (' + fmt(parseFloat(f.planned_trays)) + ')').join(' · ')));
    }
    if (!shorts.length && !overs.length && !unscanned.length) {
      T.push('');
      T.push('✅ Zero deltas — every item matched plan exactly.');
    }
    T.push('');
    T.push('*Full breakdown by store (scanned / planned):*');
    const byStore = {};
    forecast.forEach(f => {
      if (!byStore[f.location]) byStore[f.location] = [];
      byStore[f.location].push(f);
    });
    Object.keys(byStore).sort().forEach(loc => {
      const items = byStore[loc];
      const p = items.reduce((n, f) => n + parseFloat(f.planned_trays), 0);
      const g = items.reduce((n, f) => n + (scannedByItem[loc + '|' + f.sku] || 0), 0);
      T.push('');
      T.push('*' + loc + '* — ' + fmt(g) + ' / ' + fmt(p));
      items.sort((a, b) => catPriority(a.category) - catPriority(b.category)).forEach(f => {
        const got = scannedByItem[loc + '|' + f.sku] || 0;
        const pl = parseFloat(f.planned_trays);
        const flag = got === 0 ? ' ⚠️' : Math.abs(got - pl) > 0.001 ? ' Δ' : '';
        T.push('  • ' + f.item_name + ': ' + fmt(got) + ' / ' + fmt(pl) + flag);
      });
    });

    const mainText = L.join('\n');
    const threadText = T.join('\n');

    if (dryRun) {
      console.log('*** DRY RUN ***\n');
      console.log(mainText);
      console.log('\n--- 🧵 THREAD REPLY ---\n');
      console.log(threadText);
    } else {
      const ts = await postToSlack(SLACK_TOKEN, CHANNEL, mainText);
      await sleep(350);
      await postToSlack(SLACK_TOKEN, CHANNEL, threadText, ts);
      console.log('✓ Posted to #' + CHANNEL);
    }
  } finally {
    await pool.end();
  }
}

async function postToSlack(token, channel, text, thread_ts) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify(Object.assign({ channel: '#' + channel, text, mrkdwn: true }, thread_ts ? { thread_ts } : {})),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error);
  return json.ts;
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
