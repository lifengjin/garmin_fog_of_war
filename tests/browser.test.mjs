// End-to-end test in headless Chromium: loads the app, adds the sample files,
// checks the fog is cleared along walks (and only there), and runs a full
// Google Drive sync against a fake Google (no real account is involved).
//
//   npm install            (installs playwright)
//   npx playwright install chromium
//   npm run test:browser
//
// Set CHROMIUM_PATH to use a Chromium you already have. Map tiles are
// replaced with a plain colour so the test needs no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const samples = path.join(root, 'samples');
const shots = process.env.SCREENSHOT_DIR;

let pw;
try { pw = require('playwright'); } catch { pw = require('playwright-core'); }

// A plain 256x256 tile (pale green with a faint grid), so the test needs no network.
function makeTile() {
  const size = 256;
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x++) {
      const grid = x % 64 === 0 || y % 64 === 0;
      const o = y * (size * 3 + 1) + 1 + x * 3;
      raw[o] = grid ? 190 : 214; raw[o + 1] = grid ? 210 : 232; raw[o + 2] = grid ? 180 : 200;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const TILE = makeTile();

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) { res.writeHead(404).end(); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Polls with page.evaluate (page.waitForFunction needs eval, which the app's
// Content-Security-Policy rightly forbids, and the CSP stays on in tests).
async function waitFor(page, fn, arg, timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    if (await page.evaluate(fn, arg)) return;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${fn}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function launch() {
  const executablePath = process.env.CHROMIUM_PATH || undefined;
  return pw.chromium.launch({ executablePath, args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader'] });
}

async function newPage(browser, base, viewport = { width: 1200, height: 800 }) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.route(/tile\.(opentopomap|openstreetmap)\.org|basemap\.nationalmap\.gov/, (r) => r.fulfill({ body: TILE, contentType: 'image/png' }));
  // Tests run as a fresh copy would: no Google client ID set in js/config.js.
  await page.route(/\/js\/config\.js$/, (r) => r.fulfill({
    contentType: 'text/javascript',
    body: fs.readFileSync(path.join(root, 'js/config.js'), 'utf8').replace(/GOOGLE_CLIENT_ID = '[^']*'/, "GOOGLE_CLIENT_ID = ''"),
  }));
  await page.goto(base);
  await waitFor(page, () => !!window.__fogMap);
  return { ctx, page, errors };
}

// Share of fog-canvas pixels that are cleared (alpha 0), and alpha at given lat/lons.
async function fogInfo(page, probes = []) {
  return page.evaluate((probes) => {
    const { map, fog } = window.__fogMap;
    const c = document.querySelector('.fog-canvas');
    const ctx = c.getContext('2d');
    const img = ctx.getImageData(0, 0, c.width, c.height).data;
    let clear = 0;
    for (let i = 3; i < img.length; i += 4) if (img[i] === 0) clear++;
    const dpr = c.width / parseFloat(c.style.width);
    const alphaAt = ([lat, lon]) => {
      const p = map.latLngToLayerPoint([lat, lon]).subtract(fog._bounds.min);
      const x = Math.round(p.x * dpr), y = Math.round(p.y * dpr);
      return ctx.getImageData(x, y, 1, 1).data[3];
    };
    return { clearShare: clear / (img.length / 4), alphas: probes.map(alphaAt) };
  }, probes);
}

test('browser: local files, fog, spots, filters, persistence', async (t) => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await launch();
  t.after(async () => { await browser.close(); server.close(); });

  const { page, errors } = await newPage(browser, base);
  assert.equal(await page.locator('#btn-drive').isDisabled(), true, 'Drive is off without a client ID');

  await page.setInputFiles('#file-input', ['walks-2023.gpx', 'walks-2024.gpx', 'walks-2025.kml', 'spots.gpx', 'export-sample.zip'].map((f) => path.join(samples, f)));
  await waitFor(page, () => document.body.dataset.walks === '8');
  assert.equal(await page.evaluate(() => document.body.dataset.spots), '7');
  await page.waitForTimeout(400); // fit-to-data animation

  // Zoom in on one walk and probe the fog on and off it.
  const probe = await page.evaluate(() => {
    const { map, data } = window.__fogMap;
    const tr = data.tracks[0];
    const mid = Math.floor(tr.points.length / 4) * 2;
    const on = [tr.points[mid], tr.points[mid + 1]];
    map.setView(on, 16, { animate: false });
    return on;
  });
  await page.waitForTimeout(200);
  const far = [probe[0] + 0.02, probe[1] + 0.03]; // ~3 km away, beyond every sample walk
  const z16 = await fogInfo(page, [probe, far]);
  // Fog is drawn; check the far point by asking the map whether it's on screen first.
  assert.equal(z16.alphas[0], 0, 'fog is fully cleared on the walk');
  assert.ok(z16.clearShare > 0.01 && z16.clearShare < 0.6, `cleared share at z16: ${z16.clearShare}`);

  // Off-walk point in view: just north of the canvas centre is very unlikely to be
  // cleared everywhere; use the top-left corner of the visible map instead.
  const corner = await page.evaluate(() => {
    const { map } = window.__fogMap;
    const ll = map.containerPointToLatLng([5, 5]);
    return [ll.lat, ll.lng];
  });
  const cornerInfo = await fogInfo(page, [corner]);
  assert.ok(cornerInfo.alphas[0] > 150, `fog present away from walks (alpha ${cornerInfo.alphas[0]})`);
  if (shots) await page.screenshot({ path: path.join(shots, 'desktop-z16.png') });

  // Units: miles and feet by default, kilometres and metres when chosen.
  await page.click('#btn-menu');
  assert.equal(await page.locator('#stat-km-unit').innerText(), 'mi walked');
  assert.equal(await page.locator('#out-width').innerText(), '100 ft');
  const miles = Number(await page.locator('#stat-km').innerText());
  // The base map follows the units until one is picked: USGS topo (feet) here.
  const tileHosts = () => page.evaluate(() => [...document.querySelectorAll('.leaflet-tile-pane img')].map((i) => new URL(i.src).host));
  assert.equal(await page.locator('#in-base').inputValue(), 'usgs');
  assert.ok((await tileHosts()).includes('basemap.nationalmap.gov'), 'USGS tiles shown');
  await page.selectOption('#in-units', 'metric');
  assert.equal(await page.locator('#stat-km-unit').innerText(), 'km walked');
  assert.equal(await page.locator('#out-width').innerText(), '30 m');
  assert.equal(await page.locator('#in-base').inputValue(), 'topo');
  await waitFor(page, () => [...document.querySelectorAll('.leaflet-tile-pane img')].some((i) => i.src.includes('opentopomap')));
  const km = Number(await page.locator('#stat-km').innerText());
  assert.ok(Math.abs(km / miles - 1.609) < 0.05, `${miles} mi vs ${km} km`);

  // Wider strip clears more.
  await page.locator('#in-width').fill('120');
  await page.locator('#in-width').dispatchEvent('input');
  const wide = await fogInfo(page);
  assert.ok(wide.clearShare > z16.clearShare * 2, `wider strip: ${z16.clearShare} -> ${wide.clearShare}`);
  await page.locator('#in-width').fill('30');
  await page.locator('#in-width').dispatchEvent('input');

  // Darkness slider changes the fog alpha.
  await page.locator('#in-fog').fill('40');
  await page.locator('#in-fog').dispatchEvent('input');
  const light = await fogInfo(page, [corner]);
  assert.ok(Math.abs(light.alphas[0] - 102) <= 2, `fog alpha at 40%: ${light.alphas[0]}`);
  await page.locator('#in-fog').fill('78');
  await page.locator('#in-fog').dispatchEvent('input');

  // Hide location: no base map, no scale, no spot names; fog unchanged.
  const titles = () => page.evaluate(() => [...document.querySelectorAll('.leaflet-marker-icon[title]')].map((m) => m.title));
  assert.ok((await titles()).some((t) => t !== 'Spot'), 'spot names shown normally');
  assert.equal(await page.locator('.hide-badge').isVisible(), false);
  await page.check('#in-hide');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.leaflet-tile-pane')).visibility), 'hidden', 'base map hidden');
  assert.equal(await page.locator('.leaflet-control-scale').isVisible(), false, 'scale hidden');
  assert.equal(await page.locator('.hide-badge').isVisible(), true, 'badge shown');
  assert.ok((await titles()).every((t) => t === 'Spot'), 'spot names hidden');
  await page.evaluate(() => document.querySelector('.leaflet-marker-icon[title]').click());
  const hiddenPopup = await page.locator(".leaflet-popup-content").innerText();
  assert.match(hiddenPopup, /Details hidden/);
  assert.doesNotMatch(hiddenPopup, /\d+\.\d{4,}/, 'no coordinates in the popup');
  assert.equal((await fogInfo(page, [probe])).alphas[0], 0, 'walk still clears fog while hidden');
  await page.click('#btn-unhide');
  assert.equal(await page.isChecked('#in-hide'), false);
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.leaflet-tile-pane')).visibility), 'visible');
  assert.ok((await titles()).some((t) => t !== 'Spot'), 'spot names back');

  // Spots are coloured by icon, and the menu lists the icons with counts.
  const iconRows = () => page.evaluate(() => [...document.querySelectorAll('#icon-list li')].map((li) => li.innerText.replace(/\s+/g, ' ').trim()));
  const rows = await iconRows();
  assert.equal(rows[0], 'Flag, Green 2');
  for (const r of ['Flag, Red 1', 'Pin, Blue 1', 'Car 1']) assert.ok(rows.includes(r), `icon row ${r} in ${rows}`);
  const fills = await page.evaluate(() => [...new Set([...document.querySelectorAll('.spot-pin svg path:first-child')].map((p) => p.getAttribute('fill')))]);
  for (const c of ['#2e9d48', '#d63a2a', '#2f6fd6']) assert.ok(fills.includes(c), `pin colour ${c} in ${fills}`);
  await page.locator('#icon-list input[data-sym="Flag, Green"]').uncheck();
  assert.equal(await page.evaluate(() => document.body.dataset.spots), '5');
  await page.locator('#icon-list input[data-sym="Flag, Green"]').check();
  assert.equal(await page.evaluate(() => document.body.dataset.spots), '7');

  // Panning and zooming keep the fog aligned with the walk.
  await page.evaluate(() => window.__fogMap.map.panBy([300, 200], { animate: false }));
  await page.waitForTimeout(150);
  assert.equal((await fogInfo(page, [probe])).alphas[0], 0, 'still clear after pan');
  await page.evaluate((p) => window.__fogMap.map.setView(p, 13), probe);
  await page.waitForTimeout(600);
  assert.equal((await fogInfo(page, [probe])).alphas[0], 0, 'still clear after animated zoom out');

  // Year filter
  await page.selectOption('#in-from', '2025');
  assert.equal(await page.evaluate(() => document.body.dataset.walks), '2');
  await page.selectOption('#in-from', '');
  assert.equal(await page.evaluate(() => document.body.dataset.walks), '8');

  // Spot filter and popup (text is shown as text, never as HTML)
  await page.fill('#in-filter', 'hedgehog');
  assert.equal(await page.evaluate(() => document.body.dataset.spots), '1');
  await page.click('#btn-close');
  const hedgehog = await page.evaluate(() => {
    const w = window.__fogMap.data.waypoints.find((x) => /hedgehog/i.test(x.name));
    window.__fogMap.map.setView([w.lat, w.lon], 15, { animate: false });
    return w;
  });
  await page.waitForTimeout(150);
  await page.locator('.spot-pin').first().click();
  const popup = await page.locator('.spot-popup').innerText();
  assert.match(popup, /Sample spot: hedgehogs/);
  assert.match(popup, /Mossy bank <north side>\./);
  assert.ok(hedgehog);
  await page.click('#btn-menu');
  await page.fill('#in-filter', '');
  await page.click('#btn-close');

  // Data survives a reload (IndexedDB).
  await page.reload();
  await waitFor(page, () => document.body.dataset.walks === '8');
  assert.deepEqual(errors, []);

  // Phone-sized screenshot with the menu open.
  if (shots) {
    const phone = await newPage(browser, base, { width: 390, height: 844 });
    await phone.page.setInputFiles('#file-input', ['walks-2023.gpx', 'walks-2024.gpx', 'walks-2025.kml', 'spots.gpx'].map((f) => path.join(samples, f)));
    await waitFor(phone.page, () => document.body.dataset.walks === '8');
    await phone.page.waitForTimeout(500);
    await phone.page.screenshot({ path: path.join(shots, 'phone-map.png') });
    await phone.page.click('#btn-menu');
    await phone.page.screenshot({ path: path.join(shots, 'phone-menu.png') });
    assert.deepEqual(phone.errors, []);
  }
});

test('browser: Google Drive sync against a fake Google', async (t) => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await launch();
  t.after(async () => { await browser.close(); server.close(); });
  const { page, errors } = await newPage(browser, base);

  // Fake Google Identity Services: hands back a token without a real sign-in.
  const tokenRequests = [];
  await page.route('https://accounts.google.com/gsi/client', (r) => r.fulfill({
    contentType: 'text/javascript',
    body: `window.google = { accounts: { oauth2: {
      initTokenClient: (cfg) => ({ requestAccessToken: () => { window.__tokenCfg = cfg; setTimeout(() => cfg.callback({ access_token: 'fake-token', expires_in: 3600 }), 10); } }),
      revoke: (tok, cb) => cb && cb(),
    } } };`,
  }));

  // Fake Drive: a folder with two files and a subfolder holding a third.
  let listing = [
    { id: 'f1', name: 'walks-2023.gpx', mimeType: 'application/gpx+xml', modifiedTime: '2025-01-01T00:00:00Z', md5Checksum: 'aaa' },
    { id: 'f2', name: 'spots.gpx', mimeType: 'application/gpx+xml', modifiedTime: '2025-01-01T00:00:00Z', md5Checksum: 'bbb' },
    { id: 'f9', name: 'notes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modifiedTime: '2025-01-01T00:00:00Z' },
    { id: 'sub', name: '2025', mimeType: 'application/vnd.google-apps.folder' },
  ];
  const subListing = [{ id: 'f3', name: 'walks-2025.kml', mimeType: 'application/vnd.google-earth.kml+xml', modifiedTime: '2025-01-01T00:00:00Z', md5Checksum: 'ccc' }];
  const content = { f1: 'walks-2023.gpx', f2: 'spots.gpx', f3: 'walks-2025.kml' };
  const downloads = [];
  const authHeaders = new Set();
  await page.route('https://www.googleapis.com/drive/v3/**', async (r) => {
    const url = new URL(r.request().url());
    authHeaders.add(r.request().headers().authorization);
    const q = url.searchParams.get('q') || '';
    const json = (body) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/drive/v3/files' && q.includes("mimeType='application/vnd.google-apps.folder'")) {
      assert.match(q, /name='Foraging map data'/);
      return json({ files: [{ id: 'root-folder', name: 'Foraging map data' }] });
    }
    if (url.pathname === '/drive/v3/files' && q.startsWith("'root-folder' in parents")) return json({ files: listing });
    if (url.pathname === '/drive/v3/files' && q.startsWith("'sub' in parents")) return json({ files: subListing });
    const m = /^\/drive\/v3\/files\/(\w+)$/.exec(url.pathname);
    if (m && url.searchParams.get('alt') === 'media') {
      downloads.push(m[1]);
      return r.fulfill({ body: fs.readFileSync(path.join(samples, content[m[1]])) });
    }
    return r.fulfill({ status: 404, body: '{}' });
  });

  await page.click('#btn-menu');
  await page.locator('details summary').click();
  await page.fill('#in-client', 'test-client.apps.googleusercontent.com');
  await page.locator('#in-client').dispatchEvent('change');
  assert.equal(await page.locator('#btn-drive').isDisabled(), false);
  assert.equal(await page.locator('#btn-sync').isHidden(), false);

  await page.click('#btn-drive');
  await waitFor(page, () => document.body.dataset.walks === '5');
  assert.equal(await page.evaluate(() => document.body.dataset.spots), '7');
  assert.deepEqual(downloads.sort(), ['f1', 'f2', 'f3']);
  assert.deepEqual([...authHeaders], ['Bearer fake-token']);
  const cfg = await page.evaluate(() => ({ id: window.__tokenCfg.client_id, scope: window.__tokenCfg.scope }));
  assert.deepEqual(cfg, { id: 'test-client.apps.googleusercontent.com', scope: 'https://www.googleapis.com/auth/drive.readonly' });

  // Second sync: nothing changed, nothing downloaded.
  await waitFor(page, () => !document.querySelector('#btn-sync').classList.contains('spinning'));
  await page.click('#btn-sync');
  await waitFor(page, () => /Up to date/.test(document.querySelector('#toast').textContent));
  assert.equal(downloads.length, 3);

  // A file removed from Drive disappears from the map on the next sync.
  listing = listing.filter((f) => f.id !== 'f1');
  await page.click('#btn-sync');
  await waitFor(page, () => document.body.dataset.walks === '2');
  assert.match(await page.locator('#toast').innerText(), /1 removed/);
  assert.deepEqual(errors, []);
});

test('browser: works offline after the first visit (service worker)', async (t) => {
  const server = await serve();
  const base = `http://localhost:${server.address().port}/`; // service workers need https or localhost
  const browser = await launch();
  t.after(async () => { await browser.close(); server.close(); });
  const { ctx, page, errors } = await newPage(browser, base);
  await page.setInputFiles('#file-input', ['walks-2024.gpx', 'spots.gpx'].map((f) => path.join(samples, f)));
  await waitFor(page, () => document.body.dataset.walks === '3');
  await waitFor(page, async () => !!(await navigator.serviceWorker.getRegistration())?.active);

  await ctx.setOffline(true);
  await page.reload();
  await waitFor(page, () => document.body.dataset.walks === '3' && document.body.dataset.spots === '5');
  await ctx.setOffline(false);
  // Tile requests fail while offline; anything else would be an app error.
  assert.deepEqual(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to load resource/.test(e)), []);
});

test('browser: Garmin FIT files and a Garmin-style export ZIP', async (t) => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await launch();
  t.after(async () => { await browser.close(); server.close(); });
  const { page, errors } = await newPage(browser, base);
  // The export repeats the hike and holds a ride and a course, which are skipped.
  await page.setInputFiles('#file-input', ['hike-2025.fit', 'garmin-export-sample.zip'].map((f) => path.join(samples, f)));
  await waitFor(page, () => document.body.dataset.walks === '2');
  const info = await fogInfo(page);
  assert.ok(info.clearShare > 0.001, `fog cleared along the FIT walks (${info.clearShare})`);
  const notes = await page.locator('.file-note').allInnerTexts();
  assert.ok(notes.includes('Garmin activities: 2 of 3 read (1 not on foot)'), JSON.stringify(notes));
  assert.deepEqual(errors, []);
});

test('browser: driving left on the watch is left out', async (t) => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await launch();
  t.after(async () => { await browser.close(); server.close(); });
  const { page, errors } = await newPage(browser, base);
  // A made-up walk of about 0.4 mi at 2.6 mph, then about 3 mi of driving.
  const start = Date.UTC(2025, 5, 1, 15);
  const pts = [];
  let lat = 47.6;
  for (let i = 0; i < 320; i++) {
    lat += (i < 200 ? 3.5 : 40) / 111320;
    pts.push(`<trkpt lat="${lat.toFixed(7)}" lon="-121.9"><time>${new Date(start + i * 3000).toISOString()}</time></trkpt>`);
  }
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>Walk then drive</name><trkseg>${pts.join('')}</trkseg></trk></gpx>`;
  await page.setInputFiles('#file-input', { name: 'walk-then-drive.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) });
  await waitFor(page, () => document.body.dataset.walks === '1');
  const miles = async () => Number((await page.locator('#stat-km').innerText()).replace(/,/g, ''));
  const walked = await miles();
  assert.ok(walked > 0.3 && walked < 0.6, `only the walk counts (${walked} mi)`);
  await page.click('#btn-menu');
  assert.equal(await page.isChecked('#in-fast'), true);
  await page.uncheck('#in-fast');
  const all = await miles();
  assert.ok(all > 3, `the drive counts once the switch is off (${all} mi)`);
  await page.check('#in-fast');
  assert.equal(await miles(), walked);
  assert.deepEqual(errors, []);
});
