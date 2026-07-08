# FDB Scan-to-Ship — Codebase Guide

This document is the primary reference for AI agents working on this codebase.
Read it fully before making any changes.

---

## What This App Does

The Scan-to-Ship app is a kitchen operations tool for Five Daughters Bakery. The kitchen
scans QR-coded tray tickets as items ship to each storefront, and storefront staff scan
again when items arrive. The system tracks what was shipped vs. received, prevents
duplicate scans, and sends daily Slack summaries to each store.

---

## Infrastructure

- **Server**: Mac mini at `100.111.170.29` (Tailscale IP), `openclaw-user` account
- **App directory**: `/Users/openclaw-user/.openclaw/workspace/scan-to-ship/`
- **Process manager**: pm2 — `pm2 restart scan-to-ship` to deploy changes
- **Production DB**: MySQL on Google Cloud SQL at `104.197.166.101`, database `production`
- **Offline fallback**: SQLite at `scans_local.sqlite` in the app directory
- **Network**: Storefronts connect via Tailscale VPN → Mac mini → Cloud SQL

---

## File Structure

```
scan-to-ship/
├── server.js              # Express app — all routes
├── db.js                  # Database layer (MySQL pools + SQLite)
├── daily-store-messages.js # Cron job: daily Slack messages to stores
├── .env                   # Secrets (never commit)
├── scans_local.sqlite     # SQLite offline fallback
├── logs/
│   └── daily-messages.log # Cron output log
└── public/
    ├── index.html         # Frontend — single-page PWA
    └── manifest.json      # PWA manifest for iPad home screen install
```

---

## Environment Variables (.env)

```
MYSQL_HOST=104.197.166.101
MYSQL_USER=FDB_SteveConnect          # read-only
MYSQL_PASSWORD=...
MYSQL_DB=production

MYSQL_WRITE_HOST=104.197.166.101
MYSQL_WRITE_USER=scan_app            # write user — limited DDL privileges
MYSQL_WRITE_PASSWORD=...

SLACK_BOT_TOKEN=xoxb-...             # for daily store messages
```

---

## Database

### MySQL pools (db.js)
- **readPool** (`FDB_SteveConnect`): SELECT queries against production data
- **writePool** (`scan_app`): INSERT/UPDATE to `Kitchen_Shipment_Scans`
- `scan_app` has NO DDL privileges — never run ALTER/CREATE via the app.
  Schema changes must be done manually via Google Cloud SQL console.

### Key tables
- `Kitchen_Shipment_Scans` — all scan records (shipped + received)
- `Production_Forecast_Item_Level` — daily forecast per item per location
- `Kitchen_Tray_Screen_Conversions` — tray-to-unit conversion lookup
- `shopify_open_orders_ALL_CATEGORIES` — preorders by location and pickup date
- `vw_shopify_openorder_details` — preorder detail view with order/customer info

### Kitchen_Shipment_Scans schema
```sql
id               INT AUTO_INCREMENT PRIMARY KEY
scan_timestamp   DATETIME            -- UTC, convert with CONVERT_TZ for Central
item_level_id    INT                 -- FK → Production_Forecast_Item_Level.id
forecast_date    DATE                -- delivery date from the ticket
location         VARCHAR             -- full store name e.g. "Ponce City Market"
sku              VARCHAR
planned_trays    DECIMAL
actual_trays     DECIMAL
scan_type        ENUM('shipped','received')
scanned_by       VARCHAR             -- kitchen staff name, set in app UI
device_id        VARCHAR
notes            VARCHAR
master_ticket_ref VARCHAR(20)        -- duplicate key: "{ticket_num}-{YYYY-MM-DD}"
```

---

## Barcode Format

**5-part format** (current): `{ticket_num}-{SKU}-{LocationCode}-{Qty}-{Date}`
Example: `093-01004-FRNK-1-20260623`

- `ticket_num`: 3-digit daily sequential number, resets each day (001, 002, ...)
- `SKU`: item SKU
- `LocationCode`: abbreviation mapped to full name via `LOCATION_MAP` in server.js
- `Qty`: tray quantity (can be decimal, e.g. 0.5)
- `Date`: 8-digit YYYYMMDD — this is the **forecast/delivery date**

**4-part legacy format**: `{SKU}-{LocationCode}-{Qty}-{Date}` — still supported.

**Regex** (5-part): `/^(\d{3})-([A-Z0-9]+)-([A-Z0-9&]+)-([0-9.]+)-([0-9]{8})$/`

### LOCATION_MAP (server.js)
Maps barcode abbreviations → full location names stored in DB.
Check server.js for the current complete mapping.

---

## Duplicate Scan Prevention

**Key**: `master_ticket_ref = "{ticket_num}-{YYYY-MM-DD}"`
where the date comes from `parsed.date` (barcode) → `req.body.scan_date` → today's date.

**IMPORTANT**: The date uses the **barcode date** first, not the UI date picker.
This is critical because 2nd shift scans for next-day tickets on the same physical
day as 3rd shift scanning for the same-day tickets — both must use the barcode date
so their master_ticket_refs don't collide.

**Flow** (POST /scan in server.js):
1. Parse barcode → get `parsed.ticket_num` and `parsed.date`
2. Build `_masterRef = "{ticket_num}-{date}"`
3. Call `checkDuplicateScan(_masterRef, scan_type)` — queries MySQL first, SQLite fallback
4. If duplicate found → return 409 with details (who scanned, when, how many trays)
5. If clear → `insertScan(...)` with `master_ticket_ref` stored

**Shift workflow**:
- 3rd shift (overnight): scans for TODAY's delivery date
- 2nd shift (evening): scans for NEXT DAY's delivery date
- These produce different `master_ticket_ref` values → no collision

---

## Ticket Lookup (GET /ticket/:barcode)

Performance optimization: for 5-part barcodes, the ticket query and rack position
query fire in parallel via `Promise.all` since both inputs are known from the barcode.
For legacy ID barcodes, they run sequentially.

Fallback: if MySQL is unreachable, `queryForecastCache` serves from local SQLite.

---

## Daily Store Slack Messages

**Script**: `daily-store-messages.js`
**Cron**: `30 6 * * *` (6:30 AM Central) — see `crontab -l` for current entry
**Node path in cron**: `/opt/homebrew/opt/node@22/bin/node` (required — cron has stripped PATH)

**What it sends**: per-store message to each Slack channel with:
- Shipped items grouped by category (100 Layer → Mini → Yeast Raised → Other)
- Each category sorted by tray qty descending, with subtotal
- Preorders due that day grouped by order, at the bottom

**Scan filter**: `DATE(CONVERT_TZ(scan_timestamp, '+00:00', 'America/Chicago')) = today`
Filters by when the scan was physically made (Central time), not `forecast_date`.
This ensures both shifts are captured regardless of what delivery date is on the ticket.

**Dry run**: `node daily-store-messages.js --dry-run` — prints to terminal, no Slack posts

**Logs**: `logs/daily-messages.log`

### Store → Slack channel mapping
| Store | Channel |
|---|---|
| Ponce City Market | #fdb-pcm |
| Avalon | #fdb-avalon |
| 12th South | #fdb-12s |
| 5th & Broad | #fdb-5broad |
| East | #fdb-east |
| L&L Market | #fdb-west |
| The Factory (Franklin) | #fdb-franklin |
| The Fountains | #fdb-fountains |
| Westside Provisions | #fdb-wsp |
| The Gulch | #fdb-gulch |

---

## Frontend (public/index.html)

Single-page PWA. Key behaviors:
- **User login**: stored in localStorage, shown in header with "Change" button
  Uses `fdbPrompt()` modal (not `prompt()`) — required for iOS standalone mode
- **Scan flow**: scan barcode → `lookupTicket()` → confirm → `confirmScan()`
- **`currentBarcode`**: set in `lookupTicket()`, passed to `confirmScan()` as the
  raw scanned string. Critical for duplicate check — do not use `currentTicket.id`.
- **Tray pre-selection**: from barcode position [3] for 5-part, [2] for 4-part
- **Location mismatch**: uses `fdbConfirm()` modal (not `confirm()`)
- **`scan_date`**: sent from the UI date picker ("Delivering on" field)
  Server overrides with `parsed.date` from barcode for duplicate key purposes.

### PWA / iPad
- Installed via Safari → Share → Add to Home Screen
- `manifest.json` in public/ enables standalone mode
- Apple meta tags in `<head>` for iOS compatibility
- All `prompt()`/`confirm()` replaced with custom modal (`#fdbModal`) —
  iOS standalone mode blocks native dialogs

---

## Deploy Workflow

**Making changes to server.js or db.js:**
```bash
# Edit files directly on Mac mini, then:
pm2 restart scan-to-ship
pm2 logs scan-to-ship   # verify no errors
```

**Making changes to public/index.html:**
No restart needed — static files are served directly.

**Making changes to daily-store-messages.js:**
No restart needed — cron executes it as a fresh process each time.

**Applying patches from Claude sessions:**
Patches are written as Node.js scripts that use `fs.readFileSync`/`writeFileSync`
with exact string anchors. Run with `node patch_name.js` from the app directory.
Always verify with `grep` after applying.

---

## Known Issues & History

### scan_app user has no DDL privileges
`ALTER TABLE` must be run manually via Google Cloud SQL console.
If you need to add a column, write the SQL and tell the user to run it as admin.

### SQLite cache binding errors
`queryForecastCache` / `cacheForecasts` occasionally fail with
"SQLite3 can only bind numbers, strings, bigints, buffers, and null"
when MySQL returns Date objects or Decimals. Cache falls back to MySQL gracefully.
Fix: coerce MySQL result values before SQLite insert (not yet implemented).

### Debug logging still in server.js
`[DUP DEBUG]` console.log lines are still in POST /scan. Low priority to remove.

### syncOfflineScans missing master_ticket_ref
Offline scans synced to MySQL will have `master_ticket_ref = NULL`.
Duplicate check won't work for those records. Low priority.

### Cron requires full node path
macOS cron runs with stripped PATH. Always use `/opt/homebrew/opt/node@22/bin/node`
not just `node` in crontab entries.

---

## Common Troubleshooting

**"Already scanned" false positives between shifts**
Check what date is stored in `master_ticket_ref`. Should be the barcode date.
If it's the UI date (today), the `parsed.date ||` prefix in `_scanDate` is missing.

**Scans not appearing in Recent tab**
Recent tab reads from MySQL. If scans are going to SQLite (MySQL write failing),
they won't show. Check: is `MYSQL_WRITE_USER` set in .env? Is the column present?
```sql
SHOW COLUMNS FROM Kitchen_Shipment_Scans LIKE 'master_ticket_ref';
```

**Daily messages show no data for some stores**
Check `forecast_date` vs scan date for those stores. Some stores may not get
daily deliveries. Confirm by querying:
```sql
SELECT location, forecast_date, COUNT(*) 
FROM Kitchen_Shipment_Scans 
WHERE scan_type = 'shipped' AND location = 'Store Name'
GROUP BY location, forecast_date 
ORDER BY forecast_date DESC LIMIT 10;
```

**Storefront scanning slower than kitchen**
Tailscale VPN adds latency per request. Ticket lookup and rack position queries
run in parallel (already optimized). Main bottleneck is VPN + Cloud SQL round-trips.

**pm2 process not starting**
```bash
pm2 logs scan-to-ship --lines 50
```
Common causes: syntax error in server.js, missing .env, port already in use.

