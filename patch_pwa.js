/**
 * patch_pwa.js
 *
 * Makes the scan app installable as a standalone web app on iPad.
 *
 * Changes:
 *   1. Creates public/manifest.json  (makes it installable via Safari Share menu)
 *   2. Adds PWA + Apple meta tags to <head>
 *   3. Adds a custom modal overlay (iOS standalone blocks prompt/confirm)
 *   4. Replaces prompt() in initUser() and changeUser() with modal
 *   5. Replaces confirm() in location-mismatch check with modal
 *
 * After running:
 *   pm2 restart scan-to-ship
 *   On iPad: open in Safari → Share → Add to Home Screen
 */

'use strict';
const fs   = require('fs');
const path = require('path');

const BASE     = '/Users/openclaw-user/.openclaw/workspace/scan-to-ship';
const htmlPath = path.join(BASE, 'public', 'index.html');
const manPath  = path.join(BASE, 'public', 'manifest.json');

let errors = 0;
const ok   = msg => console.log('✓', msg);
const skip = msg => console.log('–', msg);
const fail = msg => { console.error('✗', msg); errors++; };

// ─────────────────────────────────────────────────────────────────────────────
// 1. manifest.json
// ─────────────────────────────────────────────────────────────────────────────
const manifest = {
  name: 'FDB Scan-to-Ship',
  short_name: 'FDB Scan',
  description: 'Five Daughters Bakery kitchen ticket scanning',
  display: 'standalone',
  orientation: 'any',
  background_color: '#fdf5f7',
  theme_color: '#f0a0b0',
  start_url: '/',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
    { src: '/icon-512.png', sizes: '512x512', type: 'image/png' }
  ]
};
fs.writeFileSync(manPath, JSON.stringify(manifest, null, 2));
ok('manifest.json written to public/');

// ─────────────────────────────────────────────────────────────────────────────
// 2. index.html
// ─────────────────────────────────────────────────────────────────────────────
let html = fs.readFileSync(htmlPath, 'utf8');

// 2a. PWA meta tags in <head>
const OLD_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0">';
const NEW_VIEWPORT = `<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, viewport-fit=cover">
  <link rel="manifest" href="/manifest.json">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="apple-mobile-web-app-title" content="FDB Scan">
  <meta name="theme-color" content="#f0a0b0">`;

if (html.includes('apple-mobile-web-app-capable')) {
  skip('PWA meta tags already present');
} else if (!html.includes(OLD_VIEWPORT)) {
  fail('viewport meta anchor not found');
} else {
  html = html.replace(OLD_VIEWPORT, NEW_VIEWPORT);
  ok('PWA + Apple meta tags added to <head>');
}

// 2b. Modal overlay HTML (before </body>)
const MODAL_HTML = `
<!-- ── Custom modal — replaces prompt/confirm for iOS standalone ── -->
<div id="fdbModal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.45);z-index:9999;align-items:center;justify-content:center;padding:20px;-webkit-overflow-scrolling:touch;">
  <div style="background:#fff;border-radius:16px;padding:24px;width:100%;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,0.2);">
    <p id="fdbModalMsg" style="font-size:0.95rem;font-weight:600;color:#2a1a1f;margin-bottom:16px;white-space:pre-line;line-height:1.5;"></p>
    <input id="fdbModalInput" type="text" autocorrect="off" autocapitalize="words"
      style="display:none;width:100%;padding:11px 14px;border:2px solid #f0dde2;border-radius:10px;
             font-size:1rem;margin-bottom:16px;box-sizing:border-box;outline:none;" />
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button id="fdbModalCancel"
        style="padding:12px 22px;border:2px solid #f0dde2;border-radius:8px;background:#fff;
               font-size:0.9rem;font-weight:600;color:#9a7a82;cursor:pointer;">Cancel</button>
      <button id="fdbModalOk"
        style="padding:12px 22px;border:none;border-radius:8px;background:#e07888;
               color:#fff;font-size:0.9rem;font-weight:600;cursor:pointer;">OK</button>
    </div>
  </div>
</div>
</body>`;

if (html.includes('id="fdbModal"')) {
  skip('modal HTML already present');
} else if (!html.includes('</body>')) {
  fail('</body> anchor not found');
} else {
  html = html.replace('</body>', MODAL_HTML);
  ok('modal overlay HTML added');
}

// 2c. Modal JS helper functions (insert before last </script>)
const MODAL_JS = `
  // ── iOS-safe modal helpers (replaces prompt / confirm) ────────────────────
  function _fdbModal(msg, inputDefault) {
    return new Promise(resolve => {
      const overlay   = document.getElementById('fdbModal');
      const msgEl     = document.getElementById('fdbModalMsg');
      const input     = document.getElementById('fdbModalInput');
      const okBtn     = document.getElementById('fdbModalOk');
      const cancelBtn = document.getElementById('fdbModalCancel');

      msgEl.textContent    = msg;
      const hasInput       = inputDefault !== undefined;
      input.style.display  = hasInput ? 'block' : 'none';
      if (hasInput) input.value = inputDefault || '';
      overlay.style.display = 'flex';
      if (hasInput) setTimeout(() => input.focus(), 150);

      const finish = val => { overlay.style.display = 'none'; resolve(val); };
      okBtn.onclick     = () => finish(hasInput ? input.value : true);
      cancelBtn.onclick = () => finish(hasInput ? null : false);

      // Allow Enter key to confirm
      input.onkeydown = e => { if (e.key === 'Enter') okBtn.click(); };
    });
  }
  const fdbPrompt  = (msg, def) => _fdbModal(msg, def === undefined ? '' : def);
  const fdbConfirm = msg        => _fdbModal(msg);

`;

if (html.includes('_fdbModal')) {
  skip('modal JS already present');
} else {
  const lastScript = html.lastIndexOf('</script>');
  if (lastScript === -1) { fail('closing </script> not found'); }
  else {
    html = html.slice(0, lastScript) + MODAL_JS + html.slice(lastScript);
    ok('modal JS helper functions added');
  }
}

// 2d. Replace prompt() in initUser — make it async
const OLD_INIT_FN   = 'function initUser() {';
const NEW_INIT_FN   = 'async function initUser() {';
const OLD_INIT_PROMPT = "      name = prompt('Your name or ID (for scan records):');";
const NEW_INIT_PROMPT = "      name = await fdbPrompt('Your name or ID (for scan records):');";

if (html.includes('await fdbPrompt')) {
  skip('initUser already uses fdbPrompt');
} else if (!html.includes(OLD_INIT_PROMPT)) {
  fail('initUser prompt anchor not found');
} else {
  html = html.replace(OLD_INIT_FN, NEW_INIT_FN);
  html = html.replace(OLD_INIT_PROMPT, NEW_INIT_PROMPT);
  ok('initUser: prompt() → fdbPrompt() (async)');
}

// 2e. Replace prompt() in changeUser — make it async
const OLD_CHANGE_FN     = 'function changeUser() {';
const NEW_CHANGE_FN     = 'async function changeUser() {';
const OLD_CHANGE_PROMPT = "    const name = prompt('Enter your name or ID:', current);";
const NEW_CHANGE_PROMPT = "    const name = await fdbPrompt('Enter your name or ID:', current);";

if (html.includes(OLD_CHANGE_PROMPT)) {
  html = html.replace(OLD_CHANGE_FN, NEW_CHANGE_FN);
  html = html.replace(OLD_CHANGE_PROMPT, NEW_CHANGE_PROMPT);
  ok('changeUser: prompt() → fdbPrompt() (async)');
} else {
  skip('changeUser prompt already replaced or not found');
}

// 2f. Replace confirm() in location-mismatch check
const OLD_CONFIRM = '        const proceed = confirm(';
const NEW_CONFIRM = '        const proceed = await fdbConfirm(';

if (html.includes(OLD_CONFIRM)) {
  html = html.replace(OLD_CONFIRM, NEW_CONFIRM);
  ok('location-mismatch: confirm() → fdbConfirm()');
} else {
  skip('location-mismatch confirm already replaced or not found');
}

fs.writeFileSync(htmlPath, html);
console.log('');

// ─────────────────────────────────────────────────────────────────────────────
if (errors > 0) {
  console.error(`⚠  ${errors} error(s) — review before restarting.`);
  process.exit(1);
}

console.log('✓ All patches applied.');
console.log('');
console.log('  pm2 restart scan-to-ship');
console.log('');
console.log('To install on iPad:');
console.log('  1. Open Safari and go to the app URL');
console.log('  2. Tap the Share button (box with arrow)');
console.log('  3. Tap "Add to Home Screen"');
console.log('  4. Name it "FDB Scan" and tap Add');
console.log('');
console.log('Optional: add your bakery logo as public/icon-192.png and public/icon-512.png');
console.log('for a custom home screen icon (192×192 and 512×512 PNG).');
