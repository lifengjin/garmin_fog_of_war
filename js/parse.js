// Parsing for GPX, KML, KMZ and ZIP files.
//
// This module has no DOM dependency so it runs in the browser and in Node
// (for tests). It turns a file into:
//   { tracks: [{ name, time, endTime, segments: [Float64Array [lat, lon, lat, lon, ...]] }],
//     waypoints: [{ name, desc, time, sym, lat, lon }] }
//
// Routes (planned paths, GPX <rte>) are ignored on purpose: the fog should
// only clear where you actually walked.

const TEXT = new TextDecoder('utf-8');

// ---------------------------------------------------------------- helpers

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeText(s) {
  if (s == null) return '';
  let out = '';
  // Pull CDATA sections out verbatim, decode entities everywhere else.
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>/g;
  let last = 0;
  let m;
  while ((m = re.exec(s))) {
    out += decodeEntities(s.slice(last, m.index)) + m[1];
    last = re.lastIndex;
  }
  out += decodeEntities(s.slice(last));
  return out.trim();
}

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (all, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES[e] ?? all;
  });
}

// Tag name pattern that tolerates a namespace prefix, e.g. <gpx:trkpt> or <gx:Track>.
const P = '(?:[A-Za-z_][\\w.-]*:)?';

function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(attrs);
  return m ? (m[2] ?? m[3]) : null;
}

// First direct-ish child text of a tag inside a chunk of XML.
function childText(xml, tag) {
  const m = new RegExp(`<${P}${tag}\\b[^>]*>([\\s\\S]*?)</${P}${tag}>`).exec(xml);
  return m ? decodeText(m[1]) : '';
}

// Iterate over every <tag ...>...</tag> (or self-closing) block, without
// nesting support for the same tag (GPX/KML never nest these).
function* blocks(xml, tag) {
  const re = new RegExp(`<${P}${tag}\\b([^>]*?)(/?)>`, 'g');
  const close = new RegExp(`</${P}${tag}\\s*>`, 'g');
  let m;
  while ((m = re.exec(xml))) {
    const attrs = m[1];
    if (m[2] === '/') {
      yield { attrs, inner: '' };
      continue;
    }
    close.lastIndex = re.lastIndex;
    const c = close.exec(xml);
    if (!c) break;
    yield { attrs, inner: xml.slice(re.lastIndex, c.index) };
    re.lastIndex = close.lastIndex;
  }
}

function parseTime(s) {
  if (!s) return null;
  const t = Date.parse(s.trim());
  return Number.isFinite(t) ? t : null;
}

function validLatLon(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 &&
    !(lat === 0 && lon === 0);
}

// ---------------------------------------------------------------- GPX

export function parseGPX(xml) {
  const tracks = [];
  const waypoints = [];

  for (const trk of blocks(xml, 'trk')) {
    // The track name sits before the first segment.
    const head = trk.inner.split(new RegExp(`<${P}trkseg\\b`))[0];
    const name = childText(head, 'name');
    const segments = [];
    let time = null;
    let endTime = null;
    for (const seg of blocks(trk.inner, 'trkseg')) {
      const pts = [];
      for (const pt of blocks(seg.inner, 'trkpt')) {
        const lat = parseFloat(attr(pt.attrs, 'lat'));
        const lon = parseFloat(attr(pt.attrs, 'lon'));
        if (!validLatLon(lat, lon)) continue;
        pts.push(lat, lon);
        if (pt.inner) {
          const tm = /<(?:[\w.-]+:)?time>([^<]*)</.exec(pt.inner);
          if (tm) {
            const t = parseTime(tm[1]);
            if (t != null) {
              if (time == null) time = t;
              endTime = t;
            }
          }
        }
      }
      if (pts.length >= 4) segments.push(Float64Array.from(pts));
    }
    if (segments.length) tracks.push({ name, time, endTime, segments });
  }

  for (const w of blocks(xml, 'wpt')) {
    const lat = parseFloat(attr(w.attrs, 'lat'));
    const lon = parseFloat(attr(w.attrs, 'lon'));
    if (!validLatLon(lat, lon)) continue;
    waypoints.push({
      name: childText(w.inner, 'name'),
      desc: childText(w.inner, 'desc') || childText(w.inner, 'cmt'),
      time: parseTime(childText(w.inner, 'time')),
      sym: childText(w.inner, 'sym') || childText(w.inner, 'type'),
      lat, lon,
    });
  }
  return { tracks, waypoints };
}

// ---------------------------------------------------------------- KML

function parseCoordList(text) {
  // "lon,lat[,alt] lon,lat[,alt] ..."
  const out = [];
  for (const tuple of text.trim().split(/\s+/)) {
    if (!tuple) continue;
    const [lon, lat] = tuple.split(',').map(Number);
    if (validLatLon(lat, lon)) out.push(lat, lon);
  }
  return out;
}

export function parseKML(xml) {
  const tracks = [];
  const waypoints = [];

  for (const pm of blocks(xml, 'Placemark')) {
    const inner = pm.inner;
    // Name/description of the placemark itself (not of nested elements).
    const name = childText(inner.replace(/<(?:[\w.-]+:)?ExtendedData[\s\S]*?<\/(?:[\w.-]+:)?ExtendedData>/g, ''), 'name');
    const desc = childText(inner, 'description');
    const time = parseTime(childText(inner, 'when')) ?? parseTime(childText(inner, 'begin'));
    const endTime = parseTime(childText(inner, 'end'));

    let found = false;

    for (const ls of blocks(inner, 'LineString')) {
      const pts = parseCoordList(childText(ls.inner, 'coordinates'));
      if (pts.length >= 4) {
        tracks.push({ name, time, endTime, segments: [Float64Array.from(pts)] });
        found = true;
      }
    }

    // gx:Track: <when>...</when> list + <gx:coord>lon lat alt</gx:coord> list
    for (const tr of blocks(inner, 'Track')) {
      const pts = [];
      const re = /<(?:[\w.-]+:)?coord>([^<]*)</g;
      let m;
      while ((m = re.exec(tr.inner))) {
        const [lon, lat] = m[1].trim().split(/\s+/).map(Number);
        if (validLatLon(lat, lon)) pts.push(lat, lon);
      }
      const whens = [...tr.inner.matchAll(/<(?:[\w.-]+:)?when>([^<]*)</g)].map((x) => parseTime(x[1])).filter((x) => x != null);
      if (pts.length >= 4) {
        tracks.push({
          name, time: whens[0] ?? time, endTime: whens[whens.length - 1] ?? endTime,
          segments: [Float64Array.from(pts)],
        });
        found = true;
      }
    }

    if (!found) {
      for (const p of blocks(inner, 'Point')) {
        const pts = parseCoordList(childText(p.inner, 'coordinates'));
        if (pts.length >= 2) {
          waypoints.push({ name, desc, time, sym: '', lat: pts[0], lon: pts[1] });
        }
      }
    }
  }
  return { tracks, waypoints };
}

// ---------------------------------------------------------------- ZIP / KMZ

// Minimal ZIP reader (stored and deflate entries, ZIP64 sizes). Uses the
// standard DecompressionStream, available in modern browsers and Node 18+.
export async function readZip(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  // Find End Of Central Directory record (search the last 64 KB + 22 bytes).
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a ZIP file');

  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);

  // ZIP64 end of central directory locator sits just before the EOCD.
  if ((cdOffset === 0xffffffff || count === 0xffff) && eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) {
    const z64 = Number(dv.getBigUint64(eocd - 12, true));
    if (dv.getUint32(z64, true) === 0x06064b50) {
      count = Number(dv.getBigUint64(z64 + 32, true));
      cdOffset = Number(dv.getBigUint64(z64 + 48, true));
    }
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method = dv.getUint16(p + 10, true);
    let compSize = dv.getUint32(p + 20, true);
    let size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localOffset = dv.getUint32(p + 42, true);
    const name = TEXT.decode(u8.subarray(p + 46, p + 46 + nameLen));

    // ZIP64 extra field
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = dv.getUint16(e, true);
      const len = dv.getUint16(e + 2, true);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(dv.getBigUint64(q, true)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(dv.getBigUint64(q, true)); q += 8; }
      }
      e += 4 + len;
    }

    entries.push({ name, method, compSize, size, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  return {
    entries,
    async read(entry) {
      const lo = entry.localOffset;
      if (dv.getUint32(lo, true) !== 0x04034b50) throw new Error(`Bad ZIP entry ${entry.name}`);
      const start = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      const data = u8.subarray(start, start + entry.compSize);
      if (entry.method === 0) return data;
      if (entry.method !== 8) throw new Error(`Unsupported compression in ${entry.name}`);
      const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    },
  };
}

// ---------------------------------------------------------------- dispatch

export const SUPPORTED = /\.(gpx|kml|kmz|zip)$/i;

function sniff(name, bytes) {
  const ext = (/\.([a-z0-9]+)$/i.exec(name)?.[1] || '').toLowerCase();
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return ext === 'kmz' ? 'kmz' : 'zip';
  if (ext === 'gpx' || ext === 'kml') return ext;
  const head = TEXT.decode(bytes.subarray(0, 2048));
  if (/<gpx\b/i.test(head)) return 'gpx';
  if (/<kml\b/i.test(head)) return 'kml';
  return null;
}

// Parse any supported file. Returns { tracks, waypoints, parts: [names] }.
// ZIPs (e.g. a Garmin account export) are searched for GPX/KML/KMZ inside.
export async function parseFile(name, input, depth = 0) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const kind = sniff(name, bytes);
  if (kind === 'gpx') return { ...parseGPX(TEXT.decode(bytes)), parts: [name] };
  if (kind === 'kml') return { ...parseKML(TEXT.decode(bytes)), parts: [name] };
  if ((kind === 'zip' || kind === 'kmz') && depth < 3) {
    const zip = await readZip(bytes);
    const result = { tracks: [], waypoints: [], parts: [] };
    for (const entry of zip.entries) {
      if (entry.name.endsWith('/') || !SUPPORTED.test(entry.name)) continue;
      if (/(^|\/)__MACOSX\//.test(entry.name)) continue;
      const inner = await parseFile(entry.name, await zip.read(entry), depth + 1);
      result.tracks.push(...inner.tracks);
      result.waypoints.push(...inner.waypoints);
      result.parts.push(...inner.parts.map((x) => `${name} › ${x}`));
    }
    return result;
  }
  return { tracks: [], waypoints: [], parts: [] };
}
