/**
 * daily-store-messages.js
 *
 * Posts a daily shipment + preorder summary to each store's Slack channel.
 *
 * Usage:
 *   node daily-store-messages.js              ← today (Central time)
 *   node daily-store-messages.js 2026-06-15   ← specific date
 *   node daily-store-messages.js --dry-run    ← print messages, don't send
 */

'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const mysql = require('mysql2/promise');

// ── Category sort order and display labels ────────────────────────────────────
const CATEGORY_ORDER = [
  'Hundred Layer Donuts',
  'Mini Hundred Layer Donuts',
  'Yeast Raised Donuts',
];
const CATEGORY_LABELS = {
  'Hundred Layer Donuts':      '100 Layer',
  'Mini Hundred Layer Donuts': 'Mini',
  'Yeast Raised Donuts':       'Yeast Raised',
};
function categoryPriority(cat) {
  const i = CATEGORY_ORDER.indexOf(cat);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

// ── Store → Slack channel mapping ─────────────────────────────────────────────
const LOCATIONS = [
  { displayName: 'Ponce City Market',   scanName: 'Ponce City Market',   shopifyName: 'Ponce City Market',   slackChannel: 'fdb-pcm'       },
  { displayName: 'Avalon',              scanName: 'Avalon',               shopifyName: 'Avalon',               slackChannel: 'fdb-avalon'    },
  { displayName: '12th South',          scanName: '12th South',           shopifyName: '12th South',           slackChannel: 'fdb-12s'       },
  { displayName: '5th & Broad',         scanName: '5th & Broad',          shopifyName: '5th & Broad',          slackChannel: 'fdb-5broad'    },
  { displayName: 'East',                scanName: 'East',                 shopifyName: 'East',                 slackChannel: 'fdb-east'      },
  { displayName: 'L&L Market',          scanName: 'L&L Market',           shopifyName: 'L&L Market',           slackChannel: 'fdb-west'      },
  { displayName: 'The Factory',         scanName: 'The Factory',          shopifyName: 'The Factory',          slackChannel: 'fdb-franklin'  },
  { displayName: 'The Fountains',       scanName: 'The Fountains',        shopifyName: 'The Fountains',        slackChannel: 'fdb-fountains' },
  { displayName: 'Westside Provisions', scanName: 'Westside Provisions',  shopifyName: 'Westside Provisions',  slackChannel: 'fdb-wsp'       },
  { displayName: 'Medley',              scanName: 'Medley',               shopifyName: 'Medley',               slackChannel: 'fdb-medley'    },
  { displayName: 'The Gulch',           scanName: 'The Gulch',            shopifyName: 'The Gulch',                   slackChannel: 'fdb-gulch'     },
];

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const args   = process.argv.slice(2).filter(a => !a.startsWith('--'));
  const dryRun = process.argv.includes('--dry-run');
  const date   = args[0] || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

  if (dryRun) console.log('*** DRY RUN — messages will print here, nothing sent to Slack ***\n');

  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!SLACK_TOKEN && !dryRun) {
    console.error('ERROR: SLACK_BOT_TOKEN not set in .env');
    process.exit(1);
  }

  console.log(`[${new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' })}]`);
  console.log(`Sending daily summaries for ${date}...\n`);

  const pool = mysql.createPool({
    host:             process.env.MYSQL_HOST     || '104.197.166.101',
    user:             process.env.MYSQL_USER     || 'FDB_SteveConnect',
    password:         process.env.MYSQL_PASSWORD || '',
    database:         process.env.MYSQL_DB       || 'production',
    waitForConnections: true,
    connectionLimit:  3,
    connectTimeout:   10000,
  });

  try {
    // Scans: filter by the date the scan was physically made (Central time),
    // not forecast_date, so stores scanned at any time of day are included.
    const [scans] = await pool.execute(`
      SELECT
        s.location,
        s.sku,
        COALESCE(pf.Item_Name, s.sku)  AS item_name,
        pf.Item_Category               AS category,
        SUM(s.actual_trays)            AS total_trays
      FROM Kitchen_Shipment_Scans s
      LEFT JOIN Production_Forecast_Item_Level pf ON pf.id = s.item_level_id
      WHERE s.scan_type = 'shipped'
        AND s.forecast_date = ?
      GROUP BY s.location, s.sku, pf.Item_Name, pf.Item_Category
      ORDER BY s.location, COALESCE(pf.Item_Name, s.sku)
    `, [date]);

    // Preorders: by pickup date
    const [preorders] = await pool.execute(`
      SELECT
        order_number,
        Customer_Name,
        Location,
        Title    AS title,
        Quantity AS qty,
        price,
        SKU,
        Pickup_Time,
        Checkout_Method
      FROM vw_shopify_all_order_details
      WHERE DATE(Pickup_Date) = ?
      ORDER BY Location, order_number, Title
    `, [date]);

    console.log(`Scans found:     ${scans.length} line(s)`);
    console.log(`Preorders found: ${preorders.length} line(s)\n`);

    // Group scans by location
    const scansByLoc = groupBy(scans, 'location');

    // Group preorders by location → order
    const preordersByLoc = {};
    for (const row of preorders) {
      const loc = row.Location;
      if (!preordersByLoc[loc]) preordersByLoc[loc] = {};
      const key = `${row.order_number}||${row.Customer_Name}||${row.Pickup_Time || ''}`;
      if (!preordersByLoc[loc][key]) {
        preordersByLoc[loc][key] = {
          order_number:     row.order_number,
          customer:         row.Customer_Name,
          pickup_time:      row.Pickup_Time,
          checkout_method:  row.Checkout_Method,
          items:            [],
        };
      }
      const isSquare = row.Checkout_Method === 'Square Pickup';
      if (row.Checkout_Method === 'pickup') {  // Shopify only — ezcater etc. pass through
        // A: Shopify bundles emit an identical component row at unit price — keep the bundle row
        const dup = preorders.find(r2 => r2 !== row
          && r2.order_number === row.order_number
          && r2.title === row.title
          && Number(r2.qty) === Number(row.qty)
          && Number(r2.price) > Number(row.price));
        if (dup) continue;
        // B: box orders expand into component rows — drop non-box rows when the order has a box
        const isBundleRow = r => /box/i.test(r.title || '') || String(r.SKU || '').slice(0, 2) === '12';
        if (!isBundleRow(row) && preorders.some(r2 => r2.order_number === row.order_number && isBundleRow(r2))) continue;
        preordersByLoc[loc][key].items.push({ title: row.title, qty: Number(row.qty) });
      } else {
        // Square sends one row per unit — aggregate them
        const existingItem = preordersByLoc[loc][key].items.find(i => i.title === row.title);
        if (existingItem) {
          existingItem.qty += Number(row.qty);
        } else {
          preordersByLoc[loc][key].items.push({ title: row.title, qty: Number(row.qty) });
        }
      }
    }

    const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Chicago',
    });

    let sent = 0, failed = 0;

    for (const loc of LOCATIONS) {
      const locationScans     = scansByLoc[loc.scanName] || [];
      const locationPreorders = loc.shopifyName
        ? Object.values(preordersByLoc[loc.shopifyName] || {})
        : [];

      const messageText = buildMessage(loc.displayName, dateLabel, locationScans, locationPreorders);
      const detailText  = buildTrayDetail(locationScans);

      if (dryRun) {
        console.log(`${'═'.repeat(60)}`);
        console.log(`Channel: #${loc.slackChannel}`);
        console.log('─'.repeat(60));
        console.log(messageText);
        if (detailText) {
          console.log('--- 🧵 THREAD REPLY ---');
          console.log(detailText);
        }
        console.log('');
        sent++;
      } else {
        try {
          const ts = await postToSlack(SLACK_TOKEN, loc.slackChannel, messageText);
          if (detailText) await postToSlack(SLACK_TOKEN, loc.slackChannel, detailText, ts);
          const tag = locationScans.length === 0 && locationPreorders.length === 0 ? ' (no data)' : '';
          console.log(`✓ #${loc.slackChannel}${tag}`);
          sent++;
        } catch (err) {
          console.error(`✗ #${loc.slackChannel}: ${err.message}`);
          failed++;
        }
        await sleep(350);
      }
    }

    console.log(`\nDone — sent: ${sent} | failed: ${failed}`);
    if (failed > 0) process.exit(1);

  } finally {
    await pool.end();
  }
}

// ── Message builder ───────────────────────────────────────────────────────────
function buildMessage(locationName, dateLabel, scans, preorders) {
  const lines = [];

  lines.push(`📦 *${locationName}*`);
  lines.push(`*${dateLabel}*`);
  lines.push('');

  if (scans.length > 0) {
    const totalTrays = scans.reduce((sum, r) => sum + parseFloat(r.total_trays), 0);

    // Group by category
    const byCat = {};
    scans.forEach(r => {
      const cat = r.category || 'Other';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(r);
    });

    // Sort categories by priority, items within each by trays descending
    const sortedCats = Object.keys(byCat).sort((a, b) => categoryPriority(a) - categoryPriority(b));

    const catParts = sortedCats.map(cat => {
      const t = byCat[cat].reduce((sum, r) => sum + parseFloat(r.total_trays), 0);
      return (CATEGORY_LABELS[cat] || cat) + ': ' + fmt(t);
    });
    lines.push('🚚 *Shipped: ' + fmt(totalTrays) + ' trays*');
    catParts.forEach(p => lines.push('  • ' + p));
    lines.push('_Full tray breakdown in thread_ 🧵');
  } else {
    lines.push('_No shipments recorded for this date_');
  }

  lines.push('');
  lines.push('─────────────────────────────');
  lines.push('');

  lines.push('*Preorders Due Today:*');
  if (preorders.length > 0) {
    let totalUnits = 0;
    preorders.forEach(order => {
      const timeStr = order.pickup_time ? ` · ${order.pickup_time}` : '';
      const sourceMap = { 'pickup': 'Shopify Preorder', 'Square Pickup': 'Square Preorder' };
      const source = sourceMap[order.checkout_method] || order.checkout_method || 'Preorder';
      lines.push(`*Order #${order.order_number} — ${order.customer || 'No name on order'}${timeStr}*`);
      lines.push(`  _Source: ${source}_`);
      order.items.forEach(item => {
        lines.push(`  • ${item.title} — ${item.qty}`);
        totalUnits += item.qty;
      });
      lines.push('');
    });
    lines.push(`_${totalUnits} item${totalUnits !== 1 ? 's' : ''} across ${preorders.length} order${preorders.length !== 1 ? 's' : ''}_`);
  } else {
    lines.push('_No preorders scheduled_');
  }

  return lines.join('\n');
}

// ── Thread detail builder ─────────────────────────────────────────────────────
function buildTrayDetail(scans) {
  if (!scans.length) return null;
  const lines = ['*Tray Breakdown*', ''];
  const byCat = {};
  scans.forEach(r => {
    const cat = r.category || 'Other';
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(r);
  });
  const sortedCats = Object.keys(byCat).sort((a, b) => categoryPriority(a) - categoryPriority(b));
  sortedCats.forEach(cat => {
    const sorted = byCat[cat].sort((a, b) => parseFloat(b.total_trays) - parseFloat(a.total_trays));
    const catTotal = sorted.reduce((sum, r) => sum + parseFloat(r.total_trays), 0);
    lines.push('*' + (CATEGORY_LABELS[cat] || cat) + '*');
    sorted.forEach(r => {
      const trays = parseFloat(r.total_trays);
      lines.push('  • ' + r.item_name + ' — ' + fmt(trays) + ' tray' + (trays !== 1 ? 's' : ''));
    });
    lines.push('  _Subtotal: ' + fmt(catTotal) + '_');
    lines.push('');
  });
  const total = scans.reduce((sum, r) => sum + parseFloat(r.total_trays), 0);
  lines.push('_Total shipped: ' + fmt(total) + ' trays_');
  return lines.join('\n');
}

// ── Slack ─────────────────────────────────────────────────────────────────────
async function postToSlack(token, channel, text, thread_ts) {
  const res = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(Object.assign({ channel: '#' + channel, text, mrkdwn: true }, thread_ts ? { thread_ts } : {})),
  });
  const json = await res.json();
  if (!json.ok) {
    const hint = json.error === 'channel_not_found' ? ` (run /invite @FDB Daily Shipments in #${channel})` : '';
    throw new Error(json.error + hint);
  }
  return json.ts;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function groupBy(arr, key) {
  return arr.reduce((acc, row) => {
    const k = row[key];
    if (!acc[k]) acc[k] = [];
    acc[k].push(row);
    return acc;
  }, {});
}
function fmt(n) { return n % 1 === 0 ? String(n) : parseFloat(n.toFixed(2)).toString(); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
