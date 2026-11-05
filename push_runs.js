/**
 * push_runs.js — run log for the nightly Square inventory push
 *
 * sync_forecast.js records one row per run in Square_Forecast_Push_Runs
 * (Mini and laptop alike). The laptop fallback (check-and-sync.sh) asks
 * "has tonight's push already happened?" before pushing.
 *
 * The table is NOT created by this code — see sql/square_forecast_push_runs.sql.
 *
 * CLI (used by check-and-sync.sh):
 *   node push_runs.js --check [YYYY-MM-DD]
 *     exit 0  push done (or in progress) for that target date — do NOT push
 *     exit 1  no completed push recorded — fallback may push
 *     exit 2  check failed (DB unreachable, table missing, ...) — do NOT push
 */
'use strict';
const os = require('os');

const TABLE = 'Square_Forecast_Push_Runs';

// A 'running' row younger than this means another host is mid-push right now.
// A normal run takes ~3 min; an older 'running' row is a run that was killed.
const RUNNING_FRESH_MINUTES = 10;

// MySQL errors worth retrying: the connection dropped, not the query being wrong.
const TRANSIENT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
  'ENOTFOUND', 'EAI_AGAIN', 'PROTOCOL_CONNECTION_LOST', 'PROTOCOL_SEQUENCE_TIMEOUT',
]);

function isTransient(err) {
  return !!err && (TRANSIENT_CODES.has(err.code) || err.fatal === true);
}

function tomorrowCST(now = Date.now()) {
  return new Date(now + 24 * 60 * 60 * 1000)
    .toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

/**
 * Run fn(), retrying transient connection errors (MySQL or Square). Logs every retry.
 */
async function withRetry(label, fn, { attempts = 3, delaysMs = [2000, 5000], log = console.error, sleep } = {}) {
  sleep = sleep || (ms => new Promise(r => setTimeout(r, ms)));
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!isTransient(e) || i >= attempts) throw e;
      const wait = delaysMs[Math.min(i - 1, delaysMs.length - 1)];
      log(`[sync_forecast] ${e.code || e.message} on ${label} — retry ${i}/${attempts - 1} in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

/**
 * Is tonight's push already done (or in progress) for targetDate?
 * Throws if the DB can't be read — callers must treat that as "don't push".
 */
async function pushDoneFor(query, targetDate) {
  const rows = await query(`
    SELECT id, host, status, started_at, finished_at, pushed, zeroed, errors
    FROM ${TABLE}
    WHERE target_date = ?
      AND (status IN ('success', 'partial')
           OR (status = 'running' AND started_at >= UTC_TIMESTAMP() - INTERVAL ${RUNNING_FRESH_MINUTES} MINUTE))
    ORDER BY id DESC LIMIT 1
  `, [targetDate]);
  return rows[0] || null;
}

/** Insert a 'running' row; returns its id. */
async function recordStart(query, { targetDate, host = os.hostname(), dryRun = false }) {
  if (dryRun) return null;
  const res = await query(
    `INSERT INTO ${TABLE} (target_date, host, status, started_at) VALUES (?, ?, 'running', UTC_TIMESTAMP())`,
    [targetDate, host]
  );
  return res.insertId;
}

/** Close the row: status is success | partial | aborted | failed. */
async function recordFinish(query, id, { status, pushed = 0, zeroed = 0, skipped = 0, errors = 0, message = null }) {
  if (id == null) return;
  await query(
    `UPDATE ${TABLE} SET status = ?, finished_at = UTC_TIMESTAMP(), pushed = ?, zeroed = ?, skipped = ?, errors = ?, message = ?
     WHERE id = ?`,
    [status, pushed, zeroed, skipped, errors, message ? String(message).slice(0, 500) : null, id]
  );
}

async function checkCli(argv) {
  const targetDate = argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || tomorrowCST();
  const { query } = require('./db');
  try {
    const row = await withRetry('push-done check', () => pushDoneFor(query, targetDate));
    if (row) {
      console.log(`[push-check] ${targetDate}: push ${row.status} on ${row.host} (started ${row.started_at} UTC, ` +
        `${row.pushed ?? '-'} pushed, ${row.zeroed ?? '-'} zeroed, ${row.errors ?? '-'} errors)`);
      return 0;
    }
    console.log(`[push-check] ${targetDate}: no completed push recorded`);
    return 1;
  } catch (e) {
    console.error(`[push-check] ${targetDate}: CHECK FAILED — ${e.code || ''} ${e.message}`);
    return 2;
  }
}

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (!argv.includes('--check')) {
    console.error('usage: node push_runs.js --check [YYYY-MM-DD]');
    process.exit(2);
  }
  checkCli(argv).then(code => process.exit(code), () => process.exit(2));
}

module.exports = { TABLE, RUNNING_FRESH_MINUTES, isTransient, withRetry, tomorrowCST, pushDoneFor, recordStart, recordFinish };
