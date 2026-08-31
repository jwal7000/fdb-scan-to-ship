/**
 * server.js — Scan-to-Ship Express server
 * Five Daughters Bakery kitchen ticket scanning app
 */

require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path = require('path');
const {query, insertScan, recentScans, reconciliation, reconciliationByCategory, getScannedTotal,
  backfillStore, getRackPosition, deleteScan, getStatus, cacheForecasts, queryForecastCache, queryForecastCacheById, startHealthCheck, syncOfflineScans, checkDuplicateScan} = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Location abbreviation → full name mapping
const LOCATION_MAP = {
  'PCM':  'Ponce City Market',
  'WSP':  'Westside Provisions',
  'AVLN': 'Avalon',
  'MDLY': 'Medley',
  'FRNK': 'The Factory',
  '12S':  '12th South',
  'EAST': 'East',
  'L&L':  'L&L Market',
  'GLCH': 'The Gulch',
  '5THB': '5th & Broad',
  'FNTS': 'The Fountains',
  'HPTH': 'Harpeth Kitchen',
};

/**
 * Parse barcode — supports two formats:
 *   SKU-LOCATIONABBR-TRAYS-YYYYMMDD  e.g. "01001-PCM-1-20260417" (with date)
 *   SKU-LOCATIONABBR-TRAYS           e.g. "01001-PCM-0.5"        (no date, uses server date)
 *   numeric ID                        e.g. "510278"               (legacy/fallback)
 * Returns { sku, location, trays, date } or { id } or { error }
 */
function parseBarcode(barcode) {
  const clean = String(barcode).trim().toUpperCase();

  // Format: TICKETNUM-SKU-ABBR-TRAYS-YYYYMMDD  e.g. 002-01002-PCM-1-20260522
  // The 3-digit ticket number is the daily sequential number printed on the physical ticket.
  // This is the preferred format — enables duplicate scan detection.
  const match5 = clean.match(/^(\d{3})-([A-Z0-9]+)-([A-Z0-9&]+)-([0-9.]+)-([0-9]{8})$/);
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

  // Format: SKU-ABBR-TRAYS-YYYYMMDD  e.g. 01001-PCM-1-20260417
  const matchWithDate = clean.match(/^([A-Z0-9]+)-([A-Z0-9&]+)-([0-9.]+)-([0-9]{8})$/);
  if (matchWithDate) {
    const sku      = matchWithDate[1];
    const abbr     = matchWithDate[2];
    const trays    = parseFloat(matchWithDate[3]);
    const raw      = matchWithDate[4];
    const date     = `${raw.slice(0,4)}-${raw.slice(4,6)}-${raw.slice(6,8)}`;
    const location = LOCATION_MAP[abbr];
    if (!location) return { error: `Unknown location abbreviation: ${abbr}` };
    if (isNaN(trays)) return { error: `Invalid tray quantity in barcode: ${matchWithDate[3]}` };
    return { sku, location, trays, date };
  }

  // Format: SKU-ABBR-TRAYS  e.g. 01001-PCM-0.5 (no date)
  const match = clean.match(/^([A-Z0-9]+)-([A-Z0-9&]+)-([0-9.]+)$/);
  if (match) {
    const sku      = match[1];
    const abbr     = match[2];
    const trays    = parseFloat(match[3]);
    const location = LOCATION_MAP[abbr];
    if (!location) return { error: `Unknown location abbreviation: ${abbr}` };
    if (isNaN(trays)) return { error: `Invalid tray quantity in barcode: ${match[3]}` };
    return { sku, location, trays, date: null };
  }

  // Format: numeric ID (legacy)
  const id = parseInt(clean, 10);
  if (!isNaN(id)) return { id };

  return { error: `Unrecognized barcode format: ${barcode}. Expected SKU-LOCATION-TRAYS-YYYYMMDD (e.g. 01001-PCM-1-20260417)` };
}

// ── GET /ticket/:barcode ───────────────────────────────────────────────────────
// Look up a ticket by barcode (SKU-LOCATIONABBR or numeric ID)
// Returns ticket details for display before confirmation
app.get('/ticket/:barcode', async (req, res) => {
  const { barcode } = req.params;
  const scanDate = req.query.date || null; // optional date override from client
  const parsed = parseBarcode(barcode);

  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }

  // Cache-first: instant, immune to slow internet
  {
    const d = parsed.date || scanDate || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const cached = parsed.id ? queryForecastCacheById(parsed.id) : queryForecastCache(parsed.sku, parsed.location, d);
    if (cached) {
      const ticket = {
        id: cached.item_level_id, forecast_date: cached.forecast_date,
        location: cached.location, sku: cached.sku, item_name: cached.item_name,
        item_category: cached.category, planned_trays: cached.planned_trays,
        forecasted_trays: cached.planned_trays, override_trays: null,
        units_per_tray: cached.units_per_tray || null,
        planned_units: cached.units_per_tray ? Math.round(cached.planned_trays * cached.units_per_tray) : null,
      };
      const rackPos = await getRackPosition(String(cached.forecast_date).slice(0, 10), cached.location, cached.sku);
      return res.json({ ticket, rackPosition: rackPos || null, cached: true });
    }
  }

  try {
    let rows;

    if (parsed.id) {
      // Legacy numeric ID lookup
      rows = await query(
        `SELECT
           pf.id,
           pf.Forecast_Date      AS forecast_date,
           pf.Location           AS location,
           pf.SKU                AS sku,
           pf.Item_Name          AS item_name,
           pf.Item_Category      AS item_category,
           COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays) AS planned_trays,
           pf.Final_Forecasted_Trays  AS forecasted_trays,
           pf.Kitchen_Override_Trays  AS override_trays,
           COALESCE(cs.Units_Per_Tray, cc.Units_Per_Tray) AS units_per_tray
         FROM Production_Forecast_Item_Level pf
         LEFT JOIN Kitchen_Tray_Screen_Conversions cs
           ON cs.Sku = pf.SKU AND cs.Mapping_Method = 'Item_Sku'
         LEFT JOIN Kitchen_Tray_Screen_Conversions cc
           ON cc.Item_Category = pf.Item_Category AND cc.Mapping_Method = 'Category'
         WHERE pf.id = ?
         LIMIT 1`,
        [parsed.id]
      );
    } else {
      // SKU + location + trays lookup
      // Checks today AND tomorrow since kitchen prints tickets a day ahead
      rows = await query(
        `SELECT
           pf.id,
           pf.Forecast_Date      AS forecast_date,
           pf.Location           AS location,
           pf.SKU                AS sku,
           pf.Item_Name          AS item_name,
           pf.Item_Category      AS item_category,
           COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays) AS planned_trays,
           pf.Final_Forecasted_Trays  AS forecasted_trays,
           pf.Kitchen_Override_Trays  AS override_trays,
           COALESCE(cs.Units_Per_Tray, cc.Units_Per_Tray) AS units_per_tray
         FROM Production_Forecast_Item_Level pf
         LEFT JOIN Kitchen_Tray_Screen_Conversions cs
           ON cs.Sku = pf.SKU AND cs.Mapping_Method = 'Item_Sku'
         LEFT JOIN Kitchen_Tray_Screen_Conversions cc
           ON cc.Item_Category = pf.Item_Category AND cc.Mapping_Method = 'Category'
         WHERE pf.SKU = ?
           AND pf.Location = ?
           AND pf.Forecast_Date = ?
         ORDER BY pf.Forecast_Date ASC
         LIMIT 1`,
        [parsed.sku, parsed.location, parsed.date || scanDate || new Date().toISOString().slice(0,10)]
      );
    }

    if (!rows.length) {
      const usedDate = parsed.date || scanDate || new Date().toISOString().slice(0,10);
      return res.status(404).json({ error: `No ticket found for ${barcode} on ${usedDate} — check the date or location` });
    }

    const ticket = rows[0];
    ticket.planned_units = ticket.units_per_tray
      ? Math.round(ticket.planned_trays * ticket.units_per_tray)
      : null;

    // Rack position lookup
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const forecastDate = ticket.forecast_date
      ? String(ticket.forecast_date).slice(0, 10)
      : today;
    const rackPos = await getRackPosition(forecastDate, ticket.location, ticket.sku);
    res.json({ ticket, rackPosition: rackPos || null });
  } catch (err) {
    console.error('Ticket lookup error:', err.message);
    // Try forecast cache if MySQL is unreachable
    const parsed2 = parseBarcode(req.params.barcode);
    const scanDate2 = req.query.date || null;
    let cached = null;
    if (parsed2.id) {
      cached = queryForecastCacheById(parsed2.id);
    } else if (parsed2.sku) {
      const d = parsed2.date || scanDate2 || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      cached = queryForecastCache(parsed2.sku, parsed2.location, d);
    }
    if (cached) {
      return res.json({ ticket: { id: cached.item_level_id, forecast_date: cached.forecast_date, location: cached.location, sku: cached.sku, item_name: cached.item_name, item_category: cached.category, planned_trays: cached.planned_trays, planned_units: null }, rackPosition: null, offline: true });
    }
    res.status(503).json({ error: 'Database unavailable and no cached data for this ticket', offline: true });
  }
});

// ── POST /scan ─────────────────────────────────────────────────────────────────
// Confirm a scan. Body: { barcode, actual_trays, scan_type, scanned_by, notes }
app.post('/scan', async (req, res) => {
  const { barcode, actual_trays, scan_type, scanned_by, device_id, notes } = req.body;

  // Validate
  if (!barcode) return res.status(400).json({ error: 'barcode is required' });
  if (actual_trays === undefined || actual_trays === null) return res.status(400).json({ error: 'actual_trays is required' });
  if (!['shipped', 'received'].includes(scan_type)) return res.status(400).json({ error: 'scan_type must be "shipped" or "received"' });

  const parsed = parseBarcode(barcode);
  if (parsed.error) return res.status(400).json({ error: parsed.error });

  try {
    // Look up the ticket
    let rows = [];
    {
      const _cd = parsed.date || req.body.scan_date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
      const _cached = parsed.id ? queryForecastCacheById(parsed.id) : queryForecastCache(parsed.sku, parsed.location, _cd);
      if (_cached) rows = [{ id: _cached.item_level_id, forecast_date: _cached.forecast_date, location: _cached.location, sku: _cached.sku, item_name: _cached.item_name, planned_trays: _cached.planned_trays }];
    }
    try {
      if (!rows.length && parsed.id) {
        rows = await query(
        `SELECT pf.id, pf.Forecast_Date AS forecast_date, pf.Location AS location,
                pf.SKU AS sku, pf.Item_Name AS item_name,
                COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays) AS planned_trays
         FROM Production_Forecast_Item_Level pf WHERE pf.id = ? LIMIT 1`,
        [parsed.id]
      );
    } else if (!rows.length) {
      rows = await query(
        `SELECT pf.id, pf.Forecast_Date AS forecast_date, pf.Location AS location,
                pf.SKU AS sku, pf.Item_Name AS item_name,
                COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays) AS planned_trays
         FROM Production_Forecast_Item_Level pf
         WHERE pf.SKU = ? AND pf.Location = ?
           AND pf.Forecast_Date = ?
         ORDER BY pf.Forecast_Date ASC LIMIT 1`,
          [parsed.sku, parsed.location, parsed.date || req.body.scan_date || new Date().toISOString().slice(0,10)]
        );
      }
    } catch (dbErr) {
      console.error('[scan] MySQL lookup failed:', dbErr.message);
      // rows stays empty, will try cache below
    }

    if (!rows.length) {
      // Try cache before giving up
      const cachedTicket = parsed.id ? queryForecastCacheById(parsed.id) : queryForecastCache(parsed.sku, parsed.location, parsed.date || req.body.scan_date || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }));
      if (!cachedTicket) return res.status(404).json({ error: 'No ticket found for barcode ' + barcode });
      rows = [{ id: cachedTicket.item_level_id, forecast_date: cachedTicket.forecast_date, location: cachedTicket.location, sku: cachedTicket.sku, item_name: cachedTicket.item_name, planned_trays: cachedTicket.planned_trays }];
    }

    const ticket = rows[0];

    // ── Duplicate scan check ────────────────────────────────────────────────────
    // master_ticket_ref = "ticket_num-YYYY-MM-DD"  e.g. "002-2026-05-22"
    // Only active when the new 5-part QR format is used (parsed.ticket_num exists).
    const _scanDate  = parsed.date
      || req.body.scan_date
      || new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const _masterRef = parsed.ticket_num ? (parsed.ticket_num + '-' + _scanDate) : null;
    if (_masterRef && !req.body.force) {
    const _dup = await checkDuplicateScan(_masterRef, scan_type);
      if (_dup) {
        return res.status(409).json({
          error: 'Ticket #' + parsed.ticket_num + ' (' + (ticket.item_name || ticket.sku) + ')' +
                 ' has already been ' + scan_type + ' today' +
                 ' — scanned at ' + _dup.scan_timestamp +
                 ' by ' + (_dup.scanned_by || 'unknown') +
                 ' (' + _dup.actual_trays + ' trays).' +
                 ' If this is a mistake, void the original scan.',
          duplicate: true,
          master_ticket_ref: _masterRef,
          existing: _dup,
        });
      }
    }

    // Guard: reject phantom scans with stale forecast dates
    const forecastDate = String(ticket.forecast_date).slice(0, 10);
    const todayCT = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const staleDays = Math.floor((Date.parse(todayCT) - Date.parse(forecastDate)) / 86400000);
    if (staleDays > 3) {
      return res.status(400).json({
        error: 'Scan blocked — ticket date is ' + forecastDate + ' (' + staleDays + ' days ago). Please rescan the correct label.',
        stale: true,
      });
    }

    // Write the scan record
    const result = await insertScan({
      item_level_id: ticket.id,
      forecast_date: forecastDate,
      location: ticket.location,
      sku: ticket.sku,
      planned_trays: ticket.planned_trays,
      actual_trays: parseFloat(actual_trays),
      scan_type,
      scanned_by: scanned_by || null,
      device_id: device_id || null,
      notes: notes || null,
      master_ticket_ref: _masterRef || null,
    });

    res.json({
      success: true,
      scan_id: result.id,
      backend: result.backend,
      ticket: {
        ...ticket,
        actual_trays: parseFloat(actual_trays),
        scan_type,
      },
    });
  } catch (err) {
    console.error('Scan write error:', err);
    res.status(500).json({ error: 'Failed to record scan', detail: err.message });
  }
});

// ── DELETE /scan/:id ──────────────────────────────────────────────────────────
app.delete('/scan/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'Invalid scan ID' });
  try {
    const deleted = await deleteScan(id);
    if (!deleted) return res.status(404).json({ error: 'Scan not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete scan error:', err);
    res.status(500).json({ error: 'Failed to delete scan', detail: err.message });
  }
});

// ── GET /scans/recent ──────────────────────────────────────────────────────────
// Last N scans for display
app.get('/scans/recent', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  try {
    const scans = await recentScans(limit);
    res.json({ scans });
  } catch (err) {
    console.error('Recent scans error:', err);
    res.status(500).json({ error: 'Failed to fetch recent scans', detail: err.message });
  }
});

// ── GET /reconciliation ────────────────────────────────────────────────────────
// Per-location reconciliation for a given date
// Query: ?date=2026-04-15  (defaults to today)
app.get('/reconciliation', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  try {
    const [rows, byCategory] = await Promise.all([reconciliation(date), reconciliationByCategory(date)]);
    res.json({ date, rows, byCategory });
  } catch (err) {
    console.error('Reconciliation error:', err);
    res.status(500).json({ error: 'Failed to run reconciliation', detail: err.message });
  }
});

// ── GET /tickets ───────────────────────────────────────────────────────────────
// List all tickets for a given date (for manual lookup / testing)
app.get('/tickets', async (req, res) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  const location = req.query.location || null;

  try {
    let sql = `
      SELECT
        pf.id,
        pf.Forecast_Date AS forecast_date,
        pf.Location      AS location,
        pf.SKU           AS sku,
        pf.Item_Name     AS item_name,
        COALESCE(pf.Kitchen_Override_Trays, pf.Final_Forecasted_Trays) AS planned_trays,
        COALESCE(cs.Units_Per_Tray, cc.Units_Per_Tray) AS units_per_tray
      FROM Production_Forecast_Item_Level pf
      LEFT JOIN Kitchen_Tray_Screen_Conversions cs
        ON cs.Sku = pf.SKU AND cs.Mapping_Method = 'Item_Sku'
      LEFT JOIN Kitchen_Tray_Screen_Conversions cc
        ON cc.Item_Category = pf.Item_Category AND cc.Mapping_Method = 'Category'
      WHERE pf.Forecast_Date = ?
    `;
    const params = [date];

    if (location) {
      sql += ' AND pf.Location = ?';
      params.push(location);
    }

    sql += ' ORDER BY pf.Location, pf.SKU';

    const rows = await query(sql, params);
    res.json({ date, count: rows.length, tickets: rows });
  } catch (err) {
    console.error('Tickets list error:', err);
    res.status(500).json({ error: 'Failed to fetch tickets', detail: err.message });
  }
});


// ── GET /status ────────────────────────────────────────────────────────────────
// Returns online/offline state and pending sync count
app.get('/status', (req, res) => {
  res.json(getStatus());
});

// ── Health check ───────────────────────────────────────────────────────────────


// Admin: PIN verification
app.post('/admin/verify-pin', (req, res) => {
  const { pin } = req.body || {};
  res.json({ ok: !!(pin && pin === process.env.ADMIN_PIN) });
});

// Admin: backfill via UI (PIN-authenticated)
app.post('/admin/backfill-ui', async (req, res) => {
  const { date, location, pin } = req.body || {};
  if (!pin || pin !== process.env.ADMIN_PIN)
    return res.status(403).json({ error: 'Unauthorized' });
  if (!date || !location)
    return res.status(400).json({ error: 'date and location are required' });
  try {
    const result = await backfillStore(date, location);
    console.log('[backfill-ui]', location, date, result);
    res.json({ ok: true, date, location, ...result });
  } catch (err) {
    console.error('[backfill-ui]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Hidden admin endpoint — not linked in UI
app.post('/admin/backfill', async (req, res) => {
  const { date, location, secret } = req.body || {};
  if (!secret || secret !== process.env.ADMIN_SECRET)
    return res.status(403).json({ error: 'Unauthorized' });
  if (!date || !location)
    return res.status(400).json({ error: 'date and location are required' });
  try {
    const result = await backfillStore(date, location);
    console.log(`[backfill] ${location} ${date}:`, result);
    res.json({ ok: true, date, location, ...result });
  } catch (err) {
    console.error('[backfill]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', async (req, res) => {
  const st = getStatus();
  let read = 'ok', tickets = null;
  try {
    const rows = await query('SELECT COUNT(*) AS cnt FROM Production_Forecast_Item_Level WHERE Forecast_Date = CURDATE()');
    tickets = rows[0].cnt;
  } catch (err) { read = err.message; }
  const ok = read === 'ok' && st.online;
  res.status(ok ? 200 : 500).json({
    status: ok ? 'ok' : 'degraded',
    read_db: read,
    write_db: st.online ? 'ok' : 'offline (SQLite fallback)',
    pending_sync: st.pendingSync,
    tickets_today: tickets,
  });
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', async () => {
  console.log('Scan-to-Ship running on http://localhost:' + PORT);
  console.log('Health check: http://localhost:' + PORT + '/health');
  // Cache today + tomorrow forecast for offline use
  var today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  var tomorrow = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
  await syncOfflineScans();
  await cacheForecasts([today, tomorrow]);
  startHealthCheck();
  setInterval(async () => {
    const t  = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const tm = new Date(Date.now() + 86400000).toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    await cacheForecasts([t, tm]);
  }, 30 * 60 * 1000);
  console.log('Offline fallback ready — forecast cached, health check running');
});
