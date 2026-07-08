# Scan-to-Ship — Five Daughters Bakery

A lightweight web app for kitchen staff to scan production ticket barcodes and confirm actual tray quantities shipped to each store. Also supports store-side delivery receipt scanning.

---

## The Problem

Kitchen_Actuals shipping records currently show a 97–99% exact match between Actual_Yield and Planned_Yield — strong evidence that staff are defaulting to planned quantities rather than counting actual trays. This makes it impossible to independently verify:

- Whether the kitchen shipped what was planned
- Whether stores received what was shipped
- Which side of the chain is responsible for the ~5–10% unaccounted units per location per day

This app adds a scan-based confirmation layer using the barcodes already on each production ticket.

---

## Quick Start

```bash
cd scan-to-ship
cp .env.example .env
# Edit .env with your MySQL read password (and write credentials when available)

npm install
npm start
# → http://localhost:3000
```

Open on a phone or tablet in the kitchen. Scan a ticket barcode and confirm the tray count.

---

## How It Works

Each production ticket has a barcode. The app assumes this barcode encodes the `Production_Forecast_Item_Level.id` integer (see open questions below).

**Kitchen workflow (scan-to-ship):**
1. Staff scans ticket barcode as trays are loaded for delivery
2. App fetches ticket info: flavor, store, planned trays
3. Staff confirms or overrides the tray count
4. Scan record saved to `Kitchen_Shipment_Scans`

**Store workflow (scan-to-receive):**
1. Driver or store staff toggles to "Received" mode
2. Scans each ticket on delivery arrival
3. No quantity entry needed — confirms receipt of what was shipped
4. App flags any tickets that were shipped but not received

---

## Data Architecture

### Read source
All ticket lookups hit the existing `production` DB via the read-only `FDB_SteveConnect` user.

### Write destination
Scan records are written to `Kitchen_Shipment_Scans`. Two modes:

- **MySQL (preferred):** Requires a write-capable DB user (see Jesse section below)
- **SQLite fallback:** If no write credentials are configured, scans are saved locally to `scans_local.sqlite`. Useful for testing; not suitable for multi-device production use.

### New table — Jesse needs to create this

```sql
CREATE TABLE Kitchen_Shipment_Scans (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  scan_timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  item_level_id  INT NOT NULL,
  forecast_date  DATE NOT NULL,
  location       VARCHAR(100) NOT NULL,
  sku            VARCHAR(5) NOT NULL,
  planned_trays  DECIMAL(10,4),
  actual_trays   DECIMAL(10,4) NOT NULL,
  scan_type      ENUM('shipped','received') NOT NULL,
  scanned_by     VARCHAR(100),
  device_id      VARCHAR(100),
  notes          TEXT,
  INDEX idx_forecast_date (forecast_date),
  INDEX idx_location (location),
  INDEX idx_item_level_id (item_level_id)
);
```

### Reconciliation query

Once scans are flowing, this query shows shipped vs. received gaps per location:

```sql
SELECT
  sh.forecast_date,
  sh.location,
  sh.sku,
  sh.planned_trays,
  sh.actual_trays       AS kitchen_shipped,
  rc.actual_trays       AS store_received,
  sh.actual_trays - COALESCE(rc.actual_trays, 0) AS transit_gap
FROM Kitchen_Shipment_Scans sh
LEFT JOIN Kitchen_Shipment_Scans rc
  ON rc.item_level_id = sh.item_level_id
 AND rc.scan_type = 'received'
WHERE sh.scan_type = 'shipped'
ORDER BY sh.forecast_date DESC, sh.location;
```

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Health check + ticket count for today |
| GET | `/ticket/:barcode` | Look up a ticket by barcode ID |
| POST | `/scan` | Record a scan (see body below) |
| GET | `/scans/recent` | Last 20 scans |
| GET | `/reconciliation?date=YYYY-MM-DD` | Per-location shipped vs. received summary |
| GET | `/tickets?date=YYYY-MM-DD&location=...` | List all tickets for a date/location |

**POST /scan body:**
```json
{
  "barcode":      "510326",
  "actual_trays": 1.0,
  "scan_type":    "shipped",
  "scanned_by":   "pos1",
  "notes":        "optional"
}
```

---

## For Jesse — Open Questions

**1. What does the barcode encode?**

The app currently assumes the barcode is the integer `Production_Forecast_Item_Level.id`. If it encodes the composite `Item_Level_id` string (format: `DATE_SKU_LocationID_LocationName`, e.g. `2026-04-13_01001_7_Ponce City Market`), the lookup in `db.js` and `server.js` needs to change from `WHERE pf.id = ?` to a composite key lookup.

**2. Replace or supplement Kitchen_Actuals?**

Option A (safer): Keep the existing kitchen app flow untouched. The scan table is a parallel record — queries join against it to get the verified quantity instead of relying on Kitchen_Actuals.Actual_Yield.

Option B (cleaner long-term): The scan confirmation *replaces* the kitchen app's "confirm as planned" step. Actual_Yield in Kitchen_Actuals gets written from the scan record. Requires coordinating with the kitchen app's write flow.

Recommend starting with Option A and migrating to B once scan compliance is established.

**3. Write user**

`FDB_SteveConnect` is read-only. Please create a write-capable user with INSERT on `Kitchen_Shipment_Scans` only and provide credentials for `.env`:

```
MYSQL_WRITE_USER=...
MYSQL_WRITE_PASSWORD=...
```

**4. Multi-device coordination**

SQLite fallback is single-device only. For production use (multiple tablets in kitchen + store phones), MySQL writes are required so all devices share the same scan log.

**5. Barcode format confirmation**

Can you confirm what the barcode on the ticket prints? A quick test: scan any ticket barcode and see what string a generic scanner outputs. If it's a 6-digit number like `510326`, that's the `id`. If it's a longer string, it's likely the composite key.

---

## Hardware

- **Kitchen:** Any Bluetooth barcode scanner (~$35–50, e.g. Inateck BCST-70 or Tera HW0002). Pairs to existing tablet. Scans auto-populate the barcode input field.
- **Stores:** iPhone/Android with camera — any free barcode scanning app that can paste the result into a browser field, or just use the browser's keyboard input if barcodes are numeric.

---

## Files

```
scan-to-ship/
├── server.js          Express app + all API routes
├── db.js              DB layer (MySQL read + MySQL/SQLite write)
├── public/
│   └── index.html     Mobile-friendly scan UI
├── .env               Local config (not committed)
├── .env.example       Template
├── package.json
└── README.md
```
