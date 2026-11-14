import { parseFile, SUPPORTED, PARSER_VERSION } from './parse.js';
import { prepare, combine, filterByYears, stats, years, yearOf } from './data.js';
import { FogLayer } from './fog.js';
import * as store from './store.js';
import * as drive from './drive.js';
import { GOOGLE_CLIENT_ID, DEFAULT_DRIVE_FOLDER } from './config.js';

const L = window.L;
const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------ settings

const SETTINGS_KEY = 'foraging-fog-map:settings';
const defaults = {
  width: 30, units: 'imperial', fog: 78, base: 'usgs', baseChosen: false, hide: false, hiddenIcons: [], spots: true, lines: false, filter: '',
  from: '', to: '', folder: DEFAULT_DRIVE_FOLDER, clientId: '', view: null,
};
let settings = { ...defaults };
try { Object.assign(settings, JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}')); } catch { /* private mode */ }
function save() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}
const clientId = () => (GOOGLE_CLIENT_ID || settings.clientId || '').trim();

// ------------------------------------------------------------ map

const map = L.map('map', { zoomControl: false, worldCopyJump: true, attributionControl: true });
L.control.zoom({ position: 'bottomleft' }).addTo(map);
// Strip width is kept in metres; the units setting only changes what's shown.
const FOOT = 0.3048;
const MILE = 1609.344;
const imperial = () => settings.units !== 'metric';
let scale = null;
function setScale() {
  scale?.remove();
  scale = L.control.scale({ position: 'bottomleft', imperial: imperial(), metric: !imperial() }).addTo(map);
}
setScale();

const bases = {
  topo: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
    maxZoom: 17, maxNativeZoom: 17, subdomains: 'abc',
    attribution: 'Map data © <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors, SRTM | Style © <a href="https://opentopomap.org">OpenTopoMap</a> (CC-BY-SA)',
  }),
  // USGS topo: contours and elevations in feet, United States only.
  usgs: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 18, maxNativeZoom: 16,
    attribution: 'Tiles courtesy of the <a href="https://www.usgs.gov/">U.S. Geological Survey</a> (The National Map)',
  }),
  osm: L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }),
};
// Until a base map is picked by hand, it follows the units: USGS topo (feet)
// for miles and feet, OpenTopoMap (metres) for kilometres and metres.
const baseName = () => (settings.baseChosen ? settings.base : (imperial() ? 'usgs' : 'topo'));
let base = null;
function setBase(name) {
  if (base) map.removeLayer(base);
  base = bases[name] || bases.topo;
  map.setMaxZoom(name === 'osm' ? 19 : 18);
  base.addTo(map);
}

map.createPane('fogPane').style.zIndex = 350; // above tiles, below pins
const fog = new FogLayer({ widthMetres: settings.width, fogOpacity: settings.fog / 100, showLines: settings.lines }).addTo(map);
const spotLayer = L.layerGroup();

if (settings.view) map.setView(settings.view.center, settings.view.zoom);
else map.setView([47.6, -122.0], 9);
setBase(baseName());
map.on('moveend', () => {
  settings.view = { center: map.getCenter(), zoom: map.getZoom() };
  save();
});

// ------------------------------------------------------------ data

let files = [];
let all = { tracks: [], waypoints: [] };

// Spots are coloured by their icon. Garmin icon names often name a colour
// ("Flag, Blue"), which is used as is; other icons get colours in turn.
const NAMED_COLOURS = [
  ['red', '#d63a2a'], ['green', '#2e9d48'], ['blue', '#2f6fd6'], ['yellow', '#e0b416'],
  ['orange', '#ee7a16'], ['purple', '#8a4fd1'], ['pink', '#e0559a'], ['brown', '#8a5a2b'],
  ['black', '#26292b'], ['white', '#d9d9d9'],
];
const PALETTE = ['#0f9fa8', '#8a4fd1', '#e0b416', '#e0559a', '#8a5a2b', '#ee7a16', '#2f6fd6', '#2e9d48', '#26292b', '#d63a2a'];
const NO_ICON = '#7d8a84'; // grey, so it isn't mistaken for a red flag
let iconColours = new Map();
function assignColours(waypoints) {
  const counts = new Map();
  for (const w of waypoints) counts.set(w.sym || '', (counts.get(w.sym || '') || 0) + 1);
  const syms = [...counts.keys()].sort((a, b) => (!a - !b) || counts.get(b) - counts.get(a) || a.localeCompare(b)); // most used first, "No icon" last
  iconColours = new Map();
  const used = new Set();
  for (const sym of syms) {
    const named = sym && NAMED_COLOURS.find(([word]) => new RegExp(`\\b${word}\\b`, 'i').test(sym));
    const colour = !sym ? NO_ICON : named ? named[1] : null;
    if (colour) { iconColours.set(sym, colour); used.add(colour); }
  }
  let i = 0;
  for (const sym of syms) {
    if (iconColours.has(sym)) continue;
    while (used.has(PALETTE[i % PALETTE.length]) && i < PALETTE.length) i++;
    const colour = PALETTE[i % PALETTE.length];
    iconColours.set(sym, colour); used.add(colour); i++;
  }
  return { syms, counts };
}
const iconName = (sym) => sym || 'No icon';

const pinIcons = new Map();
function pinIcon(colour) {
  if (!pinIcons.has(colour)) {
    const html = `<svg viewBox="0 0 28 28" aria-hidden="true">
  <path d="M14 27s-9-8.2-9-14.2A9 9 0 0 1 23 12.8C23 18.8 14 27 14 27z" fill="${colour}" stroke="#fff" stroke-width="1.6"/>
  <path d="M8.6 12.6a5.4 4 0 0 1 10.8 0z" fill="#fff"/><rect x="12.6" y="12.6" width="2.8" height="4.2" rx="1" fill="#fff"/>
</svg>`;
    pinIcons.set(colour, L.divIcon({ className: 'spot-pin', html, iconSize: [28, 28], iconAnchor: [14, 27], popupAnchor: [0, -24] }));
  }
  return pinIcons.get(colour);
}

function fmtDate(ms) {
  return ms == null ? '' : new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// Built with textContent only: names and notes come from files and are never
// treated as HTML.
function spotPopup(w) {
  const el = document.createElement('div');
  el.className = 'spot-popup';
  if (settings.hide) {
    // Hide location: no name, notes or coordinates, which could give the place away.
    const h = document.createElement('h3');
    h.textContent = 'Spot';
    el.appendChild(h);
    const p = document.createElement('p');
    p.className = 'meta';
    p.textContent = 'Details hidden while Hide location is on.';
    el.appendChild(p);
    return el;
  }
  const h = document.createElement('h3');
  h.textContent = w.name || 'Unnamed spot';
  el.appendChild(h);
  if (w.desc) {
    const p = document.createElement('p');
    p.textContent = w.desc;
    el.appendChild(p);
  }
  const meta = document.createElement('p');
  meta.className = 'meta';
  meta.textContent = [w.sym, fmtDate(w.time), `${w.lat.toFixed(5)}, ${w.lon.toFixed(5)}`].filter(Boolean).join(' · ');
  el.appendChild(meta);
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy coordinates';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(`${w.lat.toFixed(6)}, ${w.lon.toFixed(6)}`);
      copy.textContent = 'Copied';
    } catch {
      copy.textContent = 'Could not copy';
    }
  });
  el.appendChild(copy);
  return el;
}

// The menu's list of spot icons: a colour swatch, the icon's name, how many
// spots use it, and a checkbox to show or hide them.
function renderIconList(syms, counts) {
  const list = $('icon-list');
  list.replaceChildren();
  $('icon-list-wrap').hidden = !syms.length;
  const hidden = new Set(settings.hiddenIcons);
  for (const sym of syms) {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !hidden.has(sym);
    box.dataset.sym = sym;
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    swatch.style.background = iconColours.get(sym);
    const name = document.createElement('span');
    name.className = 'icon-name';
    name.textContent = iconName(sym);
    const n = document.createElement('small');
    n.textContent = counts.get(sym).toLocaleString();
    label.append(box, swatch, name, n);
    li.appendChild(label);
    list.appendChild(li);
  }
}

function render() {
  const from = Number(settings.from) || null;
  const to = Number(settings.to) || null;
  const tracks = filterByYears(all.tracks, from, to);
  fog.setTracks(tracks);

  spotLayer.clearLayers();
  const needle = settings.filter.trim().toLowerCase();
  const { syms, counts } = assignColours(all.waypoints);
  renderIconList(syms, counts);
  const hiddenIcons = new Set(settings.hiddenIcons);
  const spots = all.waypoints.filter((w) => !hiddenIcons.has(w.sym || '') &&
    (!needle || `${w.name} ${w.desc} ${w.sym}`.toLowerCase().includes(needle)));
  for (const w of spots) {
    L.marker([w.lat, w.lon], { icon: pinIcon(iconColours.get(w.sym || '')), title: settings.hide ? 'Spot' : (w.name || 'Spot'), keyboard: true })
      .bindPopup(() => spotPopup(w))
      .addTo(spotLayer);
  }
  if (settings.spots) spotLayer.addTo(map);
  else map.removeLayer(spotLayer);

  const s = stats(tracks, spots);
  $('stat-walks').textContent = s.walks.toLocaleString();
  const dist = imperial() ? (s.km * 1000) / MILE : s.km;
  $('stat-km').textContent = dist.toLocaleString(undefined, { maximumFractionDigits: dist < 100 ? 1 : 0 });
  $('stat-km-unit').textContent = imperial() ? 'mi walked' : 'km walked';
  $('stat-spots').textContent = s.spots.toLocaleString();
  $('stat-range').textContent = s.first ? `Walks from ${fmtDate(s.first)} to ${fmtDate(s.last)}` : '';
  document.body.dataset.walks = String(s.walks);
  document.body.dataset.spots = String(s.spots);

  // Year pickers
  const ys = years(all.tracks);
  for (const [id, key] of [['in-from', 'from'], ['in-to', 'to']]) {
    const sel = $(id);
    const want = ['', ...ys.map(String)];
    if ([...sel.options].map((o) => o.value).join() !== want.join()) {
      sel.replaceChildren(...want.map((v) => new Option(v || 'All years', v)));
    }
    sel.value = want.includes(String(settings[key])) ? String(settings[key]) : '';
  }

  // File list
  $('file-list').replaceChildren(...files.map((f) => {
    const li = document.createElement('li');
    const a = document.createElement('span');
    a.textContent = f.name;
    a.title = f.name;
    const b = document.createElement('span');
    b.textContent = `${f.tracks.length} ${f.tracks.length === 1 ? 'track' : 'tracks'}, ${f.waypoints.length} ${f.waypoints.length === 1 ? 'spot' : 'spots'}${f.source === 'drive' ? ' · Drive' : ''}`;
    li.append(a, b);
    if (f.fit) {
      // Say what happened to the Garmin activities, so an empty map can be explained.
      const n = f.fit;
      const skipped = [
        n.notOnFoot && `${n.notOnFoot} not on foot`,
        n.noGps && `${n.noGps} without GPS`,
      ].filter(Boolean).join(', ');
      const c = document.createElement('small');
      c.className = 'file-note';
      c.textContent = n.activities
        ? `Garmin activities: ${n.read} of ${n.activities} read${skipped ? ` (${skipped})` : ''}`
        : 'No Garmin activity (FIT) files inside';
      li.append(c);
    }
    return li;
  }));
}

async function reload({ fit = false } = {}) {
  files = await store.allFiles();
  files.sort((a, b) => (a.name > b.name ? 1 : -1));
  all = combine(files);
  render();
  if (fit) fitToData();
}

function fitToData() {
  const b = L.latLngBounds([]);
  for (const t of all.tracks) {
    for (let i = 0; i < t.points.length; i += 2) b.extend([t.points[i], t.points[i + 1]]);
  }
  for (const w of all.waypoints) b.extend([w.lat, w.lon]);
  if (b.isValid()) map.fitBounds(b, { padding: [30, 30], maxZoom: 15 });
}

// ------------------------------------------------------------ toasts

let toastTimer;
function toast(msg, { error = false, sticky = false } = {}) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.toggle('error', error);
  t.hidden = false;
  clearTimeout(toastTimer);
  if (!sticky) toastTimer = setTimeout(() => { t.hidden = true; }, error ? 7000 : 3500);
}

// ------------------------------------------------------------ local files

async function addLocalFiles(list) {
  const chosen = [...list].filter((f) => SUPPORTED.test(f.name));
  if (!chosen.length) {
    toast('Those files are not GPX, KML, KMZ, FIT or ZIP.', { error: true });
    return;
  }
  let added = 0;
  const hadData = files.length > 0;
  for (const [i, f] of chosen.entries()) {
    toast(`Reading ${f.name} (${i + 1} of ${chosen.length})…`, { sticky: true });
    try {
      const parsed = prepare(await parseFile(f.name, await f.arrayBuffer()));
      if (!parsed.tracks.length && !parsed.waypoints.length) {
        toast(`No tracks or waypoints found in ${f.name}.`, { error: true });
        continue;
      }
      await store.putFile({
        id: `local:${f.name}:${f.size}:${f.lastModified}`,
        source: 'local', name: f.name, modified: f.lastModified, ...parsed,
      });
      added++;
    } catch (err) {
      console.error(err);
      toast(`Couldn't read ${f.name}: ${err.message}`, { error: true });
    }
  }
  if (added) {
    await reload({ fit: !hadData });
    toast(`Added ${added} ${added === 1 ? 'file' : 'files'}.`);
  }
}

$('file-input').addEventListener('change', (e) => {
  addLocalFiles(e.target.files);
  e.target.value = '';
});

// Drag and drop anywhere
let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('drop').hidden = false;
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('drop').hidden = true;
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('drop').hidden = true;
  if (e.dataTransfer?.files?.length) addLocalFiles(e.dataTransfer.files);
});

// ------------------------------------------------------------ Google Drive

function updateDriveUi() {
  const has = !!clientId();
  $('btn-sync').hidden = !has;
  $('btn-drive').disabled = !has;
  $('btn-signout').disabled = !drive.isSignedIn();
  const last = settings.lastSync ? `Last synced ${new Date(settings.lastSync).toLocaleString()}.` : '';
  $('drive-status').textContent = has
    ? `Drive folder: ${settings.folder || 'not set'}. ${last}`
    : 'Google Drive is off until a client ID is set (see README).';
}

let syncing = false;
async function syncDrive() {
  if (syncing) return;
  syncing = true;
  $('btn-sync').classList.add('spinning');
  try {
    if (!drive.isSignedIn()) {
      toast('Signing in to Google…', { sticky: true });
      await drive.signIn(clientId());
    }
    toast('Looking in your Drive folder…', { sticky: true });
    const folder = await drive.resolveFolder(settings.folder);
    const remote = await drive.listFiles(folder.id);
    const cached = new Map(files.filter((f) => f.source === 'drive').map((f) => [f.id, f]));
    const hadData = files.length > 0;
    let changed = 0;
    for (const [i, f] of remote.entries()) {
      const id = `drive:${f.id}`;
      const stamp = `${PARSER_VERSION}:${f.md5Checksum || f.modifiedTime}`;
      if (cached.get(id)?.modified === stamp) continue;
      toast(`Downloading ${f.name} (${i + 1} of ${remote.length})…`, { sticky: true });
      const bytes = await drive.download(f.id);
      const parsed = prepare(await parseFile(f.name, bytes));
      await store.putFile({ id, source: 'drive', name: f.path, modified: stamp, ...parsed });
      changed++;
    }
    const keep = new Set(remote.map((f) => `drive:${f.id}`));
    const gone = [...cached.keys()].filter((id) => !keep.has(id));
    if (gone.length) await store.deleteFiles(gone);
    settings.lastSync = Date.now();
    save();
    await reload({ fit: !hadData && (changed > 0) });
    toast(changed || gone.length
      ? `Synced: ${changed} new or changed, ${gone.length} removed.`
      : `Up to date (${remote.length} ${remote.length === 1 ? 'file' : 'files'} in the folder).`);
  } catch (err) {
    console.error(err);
    toast(err.message, { error: true });
  } finally {
    syncing = false;
    $('btn-sync').classList.remove('spinning');
    updateDriveUi();
  }
}

$('btn-sync').addEventListener('click', syncDrive);
$('btn-drive').addEventListener('click', syncDrive);
$('btn-signout').addEventListener('click', () => {
  drive.signOut();
  updateDriveUi();
  toast('Signed out of Google.');
});

// ------------------------------------------------------------ location

let watchId = null;
let meMarker = null;
let meCircle = null;
let firstFix = false;
$('btn-locate').addEventListener('click', () => {
  const btn = $('btn-locate');
  if (watchId != null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (meMarker) map.removeLayer(meMarker);
    if (meCircle) map.removeLayer(meCircle);
    meMarker = meCircle = null;
    btn.setAttribute('aria-pressed', 'false');
    return;
  }
  if (!navigator.geolocation) {
    toast('This browser cannot share your location.', { error: true });
    return;
  }
  btn.setAttribute('aria-pressed', 'true');
  firstFix = true;
  watchId = navigator.geolocation.watchPosition((pos) => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (!meMarker) {
      meMarker = L.marker(ll, { icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [18, 18] }), interactive: false, zIndexOffset: 1000 }).addTo(map);
      meCircle = L.circle(ll, { radius: pos.coords.accuracy, color: '#2b7bff', weight: 1, fillOpacity: 0.1, interactive: false }).addTo(map);
    } else {
      meMarker.setLatLng(ll);
      meCircle.setLatLng(ll).setRadius(pos.coords.accuracy);
    }
    if (firstFix) {
      map.setView(ll, Math.max(map.getZoom(), 15));
      firstFix = false;
    }
  }, (err) => {
    toast(`Location unavailable: ${err.message}`, { error: true });
    btn.click();
  }, { enableHighAccuracy: true, maximumAge: 10000, timeout: 30000 });
});

// ------------------------------------------------------------ panel & controls

function openPanel(open) {
  $('panel').hidden = !open;
  document.body.classList.toggle('panel-open', open);
  $('btn-menu').setAttribute('aria-expanded', String(open));
  if (open) $('btn-close').focus();
}
$('btn-menu').addEventListener('click', () => openPanel($('panel').hidden));
$('btn-close').addEventListener('click', () => { openPanel(false); $('btn-menu').focus(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('panel').hidden) openPanel(false); });

function bindRange(id, outId, key, fmt, apply) {
  const el = $(id);
  el.value = settings[key];
  $(outId).textContent = fmt(settings[key]);
  el.addEventListener('input', () => {
    settings[key] = Number(el.value);
    $(outId).textContent = fmt(settings[key]);
    apply(settings[key]);
    save();
  });
}
// The width slider counts in feet or metres, depending on the units setting.
function setWidthSlider() {
  const el = $('in-width');
  if (imperial()) {
    Object.assign(el, { min: 15, max: 500, step: 5 });
    el.value = Math.round(settings.width / FOOT / 5) * 5;
    $('out-width').textContent = `${el.value} ft`;
  } else {
    Object.assign(el, { min: 5, max: 150, step: 5 });
    el.value = Math.round(settings.width / 5) * 5;
    $('out-width').textContent = `${el.value} m`;
  }
}
setWidthSlider();
$('in-width').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  settings.width = imperial() ? v * FOOT : v;
  $('out-width').textContent = `${v} ${imperial() ? 'ft' : 'm'}`;
  fog.setOptions({ widthMetres: settings.width });
  save();
});
$('in-units').value = imperial() ? 'imperial' : 'metric';
$('in-units').addEventListener('change', (e) => {
  settings.units = e.target.value;
  save();
  setWidthSlider();
  setScale();
  if (!settings.baseChosen) { $('in-base').value = baseName(); setBase(baseName()); }
  render();
});
bindRange('in-fog', 'out-fog', 'fog', (v) => `${v}%`, (v) => fog.setOptions({ fogOpacity: v / 100 }));

$('in-base').value = baseName();
$('in-base').addEventListener('change', (e) => {
  settings.base = e.target.value;
  settings.baseChosen = true;
  setBase(settings.base);
  save();
});

// Hide location: hides the base map, spot names and the scale, so a
// screenshot doesn't show where the walks are.
function setHide() {
  document.body.classList.toggle('hide-location', settings.hide);
  map.closePopup();
}
setHide();
$('in-hide').checked = settings.hide;
$('in-hide').addEventListener('change', (e) => { settings.hide = e.target.checked; save(); setHide(); render(); });
$('btn-unhide').addEventListener('click', () => {
  settings.hide = false;
  $('in-hide').checked = false;
  save(); setHide(); render();
});

$('in-spots').checked = settings.spots;
$('in-spots').addEventListener('change', (e) => { settings.spots = e.target.checked; save(); render(); });

$('in-lines').checked = settings.lines;
$('in-lines').addEventListener('change', (e) => { settings.lines = e.target.checked; fog.setOptions({ showLines: settings.lines }); save(); });

$('icon-list').addEventListener('change', (e) => {
  const sym = e.target.dataset.sym;
  if (sym == null) return;
  const hidden = new Set(settings.hiddenIcons);
  if (e.target.checked) hidden.delete(sym); else hidden.add(sym);
  settings.hiddenIcons = [...hidden];
  save();
  render();
});

$('in-filter').value = settings.filter;
$('in-filter').addEventListener('input', (e) => { settings.filter = e.target.value; save(); render(); });

for (const [id, key] of [['in-from', 'from'], ['in-to', 'to']]) {
  $(id).addEventListener('change', (e) => { settings[key] = e.target.value; save(); render(); });
}

$('in-folder').value = settings.folder;
$('in-folder').addEventListener('change', (e) => { settings.folder = e.target.value.trim(); save(); updateDriveUi(); });

$('in-client').value = settings.clientId;
$('in-client').disabled = !!GOOGLE_CLIENT_ID;
if (GOOGLE_CLIENT_ID) $('in-client').placeholder = 'Set in js/config.js';
$('in-client').addEventListener('change', (e) => { settings.clientId = e.target.value.trim(); save(); updateDriveUi(); });

$('btn-clear').addEventListener('click', async () => {
  if (!confirm('Remove all tracks and spots stored in this browser? Files in your Drive are not touched.')) return;
  await store.clearAll();
  delete settings.lastSync;
  save();
  await reload();
  toast('Removed all data from this device.');
});

// ------------------------------------------------------------ start

updateDriveUi();
reload({ fit: !settings.view }).catch((err) => {
  console.error(err);
  toast(`Couldn't open saved data: ${err.message}`, { error: true });
});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Exposed for automated tests only.
window.__fogMap = { map, fog, reload, get data() { return all; }, yearOf };
