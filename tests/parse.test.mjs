// Unit tests for parsing and geometry. Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGPX, parseKML, parseFile, decodeText } from '../js/parse.js';
import { simplify, simplifyLatLon, splitOnGaps, splitBySpeed, haversine, toUV, metresToUV } from '../js/geo.js';
import { prepare, combine, filterByYears, stats, years, FAST_MPH } from '../js/data.js';
import { makeZip } from '../tools/zip.mjs';
import { makeFit } from '../tools/fit.mjs';
import { parseFIT } from '../js/fit.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const sample = (f) => fs.readFileSync(path.join(root, 'samples', f));

test('decodeText handles entities and CDATA', () => {
  assert.equal(decodeText('Fir &amp; hemlock &lt;N&gt; &#233;&#x41;'), 'Fir & hemlock <N> éA');
  assert.equal(decodeText('<![CDATA[a & <b>]]> &amp; c'), 'a & <b> & c');
});

test('GPX: tracks, segments, times, waypoints; routes ignored', () => {
  const xml = `<?xml version="1.0"?>
  <gpx:gpx xmlns:gpx="http://www.topografix.com/GPX/1/1">
    <gpx:wpt lat='47.1' lon="-122.2"><gpx:name>Spot &amp; more</gpx:name><gpx:desc><![CDATA[<b>not html</b>]]></gpx:desc><gpx:time>2024-10-01T10:00:00Z</gpx:time></gpx:wpt>
    <gpx:wpt lat="999" lon="0"><gpx:name>bad</gpx:name></gpx:wpt>
    <gpx:rte><gpx:rtept lat="47" lon="-122"/><gpx:rtept lat="47.1" lon="-122"/></gpx:rte>
    <gpx:trk><gpx:name>Walk A</gpx:name>
      <gpx:trkseg>
        <gpx:trkpt lat="47.0" lon="-122.0"><gpx:time>2024-10-01T09:00:00Z</gpx:time></gpx:trkpt>
        <gpx:trkpt lat="47.001" lon="-122.0"/>
        <gpx:trkpt lat="abc" lon="-122.0"/>
      </gpx:trkseg>
      <gpx:trkseg>
        <gpx:trkpt lat="47.002" lon="-122.0"></gpx:trkpt>
        <gpx:trkpt lat="47.003" lon="-122.0"><gpx:time>2024-10-01T09:30:00Z</gpx:time></gpx:trkpt>
      </gpx:trkseg>
    </gpx:trk>
  </gpx:gpx>`;
  const { tracks, waypoints } = parseGPX(xml);
  assert.equal(tracks.length, 1);
  assert.equal(tracks[0].name, 'Walk A');
  assert.equal(tracks[0].segments.length, 2);
  assert.deepEqual([...tracks[0].segments[0]], [47.0, -122.0, 47.001, -122.0]);
  assert.equal(tracks[0].time, Date.parse('2024-10-01T09:00:00Z'));
  assert.equal(tracks[0].endTime, Date.parse('2024-10-01T09:30:00Z'));
  assert.equal(waypoints.length, 1);
  assert.equal(waypoints[0].name, 'Spot & more');
  assert.equal(waypoints[0].desc, '<b>not html</b>');
});

test('KML: LineString, gx:Track, MultiGeometry and Points', () => {
  const xml = `<kml xmlns:gx="http://www.google.com/kml/ext/2.2"><Document>
    <Placemark><name>Line</name><TimeStamp><when>2023-09-01T00:00:00Z</when></TimeStamp>
      <LineString><coordinates>-122,47,0 -122.001,47.001,0
        -122.002,47.002</coordinates></LineString></Placemark>
    <Placemark><name>Multi</name><MultiGeometry>
      <LineString><coordinates>-121,46 -121.001,46.001</coordinates></LineString>
      <LineString><coordinates>-121.01,46.01 -121.011,46.011</coordinates></LineString>
    </MultiGeometry></Placemark>
    <Placemark><name>Tracked</name><gx:Track>
      <when>2025-01-02T03:04:05Z</when><when>2025-01-02T03:04:08Z</when>
      <gx:coord>-120 45 10</gx:coord><gx:coord>-120.001 45.001 10</gx:coord>
    </gx:Track></Placemark>
    <Placemark><name>Pin</name><description>note</description><ExtendedData><Data name="x"><value>1</value></Data></ExtendedData>
      <Point><coordinates>-119.5,44.5,0</coordinates></Point></Placemark>
  </Document></kml>`;
  const { tracks, waypoints } = parseKML(xml);
  assert.deepEqual(tracks.map((t) => t.name), ['Line', 'Multi', 'Multi', 'Tracked']);
  assert.deepEqual([...tracks[0].segments[0]], [47, -122, 47.001, -122.001, 47.002, -122.002]);
  assert.equal(tracks[0].time, Date.parse('2023-09-01T00:00:00Z'));
  assert.equal(tracks[3].time, Date.parse('2025-01-02T03:04:05Z'));
  assert.deepEqual(waypoints, [{ name: 'Pin', desc: 'note', time: null, sym: '', lat: 44.5, lon: -119.5 }]);
});

test('ZIP and KMZ, nested, stored and deflated; junk skipped', async () => {
  const gpx = '<gpx><trk><trkseg><trkpt lat="1" lon="2"/><trkpt lat="1.001" lon="2"/></trkseg></trk></gpx>';
  const kml = '<kml><Placemark><name>P</name><Point><coordinates>3,4</coordinates></Point></Placemark></kml>';
  const kmz = makeZip([{ name: 'doc.kml', data: kml }]);
  const zip = makeZip([
    { name: 'a/track.gpx', data: gpx },
    { name: 'a/places.kmz', data: kmz, store: true },
    { name: '__MACOSX/a/._track.gpx', data: 'junk' },
    { name: 'notes.txt', data: 'hello' },
  ]);
  const r = await parseFile('export.zip', zip);
  assert.equal(r.tracks.length, 1);
  assert.equal(r.waypoints.length, 1);
  assert.equal(r.waypoints[0].lat, 4);
  assert.deepEqual(r.parts, ['export.zip › a/track.gpx', 'export.zip › a/places.kmz › doc.kml']);
  // A file with the wrong extension is still recognized by its content.
  assert.equal((await parseFile('Track.xml', Buffer.from(gpx))).tracks.length, 1);
});

test('FIT: GPS records, pauses, compressed timestamps, sport filter', async () => {
  const line = (lat0, n) => Array.from({ length: n }, (_, i) => [lat0 + i * 1e-4, -122 + i * 5e-5]);
  const start = Date.UTC(2024, 9, 1, 16) / 1000;

  // A hike with a pause: two segments, big-endian records with a developer
  // field, and every third point using a compressed timestamp header.
  const hike = makeFit({ sport: 17, sportName: 'Hike', segments: [line(47, 40), line(47.01, 30)], startS: start, compressEvery: 3 });
  const { tracks } = parseFIT(hike);
  assert.equal(tracks.length, 1);
  const t = tracks[0];
  assert.equal(t.name, 'Hike');
  assert.equal(t.sport, 17);
  assert.deepEqual(t.segments.map((s) => s.length / 2), [40, 30]);
  assert.ok(Math.abs(t.segments[0][0] - 47) < 1e-6 && Math.abs(t.segments[0][1] + 122) < 1e-6);
  assert.equal(t.time, (start + 3) * 1000);
  assert.equal(t.endTime, (start + 70 * 3 + 600) * 1000, 'compressed timestamps roll over correctly');

  // Not on foot, or not a recorded activity: skipped.
  assert.equal(parseFIT(makeFit({ sport: 2, segments: [line(47, 20)], startS: start })).tracks.length, 0, 'bike ride');
  assert.equal(parseFIT(makeFit({ fileType: 6, segments: [line(47, 20)], startS: start })).tracks.length, 0, 'course');
  assert.equal(parseFIT(makeFit({ sport: 11, segments: [line(47, 20)], startS: start })).tracks[0].name, 'Walk');

  // Found by content and by extension, inside zips; truncated files keep what's there.
  assert.equal((await parseFile('activity.bin', hike)).tracks.length, 1);
  const zipped = makeZip([{ name: 'a/b/123.fit', data: Buffer.from(hike) }]);
  assert.equal((await parseFile('export.zip', zipped)).tracks.length, 1);
  const exp = await parseFile('garmin-export-sample.zip', sample('garmin-export-sample.zip'));
  assert.deepEqual(exp.fit, { activities: 3, read: 2, notActivity: 1, notOnFoot: 1, noGps: 0 });
  assert.deepEqual((await parseFile('export-sample.zip', sample('export-sample.zip'))).fit.activities, 0);
  const cut = parseFIT(hike.subarray(0, Math.floor(hike.length * 0.4)));
  assert.equal(cut.tracks.length, 1);
  assert.ok(cut.tracks[0].segments[0].length / 2 >= 4);
  // Garbage doesn't throw.
  assert.deepEqual(parseFIT(new Uint8Array([14, 0x20, 0, 0, 0xff, 0xff, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0, 0x45, 0x01])).tracks, []);
});

test('simplify keeps shape within tolerance and drops collinear points', () => {
  const line = [];
  for (let i = 0; i <= 100; i++) line.push(i, 0);
  assert.deepEqual([...simplify(Float64Array.from(line), 0.1)], [0, 0, 100, 0]);

  const zig = Float64Array.from([0, 0, 1, 0.05, 2, 0, 3, 5, 4, 0]);
  const s = simplify(zig, 0.5);
  assert.deepEqual([...s], [0, 0, 2, 0, 3, 5, 4, 0]);
});

test('simplifyLatLon stays within ~2 m of the original', () => {
  const pts = [];
  let lat = 45, lon = -121;
  for (let i = 0; i < 2000; i++) {
    lat += 2.5e-5 * Math.cos(i / 40);
    lon += 3e-5 * Math.sin(i / 55);
    pts.push(lat, lon);
  }
  const s = simplifyLatLon(Float64Array.from(pts), 2);
  assert.ok(s.length < pts.length / 3, `expected a big reduction, got ${s.length / 2} of ${pts.length / 2}`);
  // every original point is within 2.5 m of some kept point segment (cheap check: of a kept vertex or segment)
  let worst = 0;
  for (let i = 0; i < pts.length; i += 2) {
    let best = Infinity;
    for (let j = 2; j < s.length; j += 2) {
      // distance to segment in a local flat frame
      const ky = 111320, kx = 111320 * Math.cos((45 * Math.PI) / 180);
      const ax = s[j - 1] * kx, ay = s[j - 2] * ky, bx = s[j + 1] * kx, by = s[j] * ky;
      const px = pts[i + 1] * kx, py = pts[i] * ky;
      const dx = bx - ax, dy = by - ay;
      const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
      best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
    worst = Math.max(worst, best);
  }
  assert.ok(worst <= 2.5, `worst deviation ${worst.toFixed(2)} m`);
});

test('splitOnGaps cuts GPS jumps over 500 m', () => {
  const pts = Float64Array.from([45, -121, 45.0001, -121, 45.0002, -121, 45.1, -121, 45.1001, -121]);
  const parts = splitOnGaps(pts);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].length, 6);
  assert.equal(parts[1].length, 4);
});

test('geometry: haversine, Web Mercator and metre scale', () => {
  assert.ok(Math.abs(haversine(45, -121, 45.001, -121) - 111.2) < 0.5);
  assert.deepEqual(toUV(0, 0), [0.5, 0.5]);
  const [u] = toUV(0, 180);
  assert.equal(u, 1);
  // 30 m at 45° is wider in Mercator than at the equator
  assert.ok(metresToUV(30, 45) > metresToUV(30, 0) * 1.4);
});

test('sample files: counts, de-duplication and year filter', async () => {
  const names = ['walks-2023.gpx', 'walks-2024.gpx', 'walks-2025.kml', 'spots.gpx', 'export-sample.zip', 'hike-2025.fit', 'garmin-export-sample.zip'];
  const files = [];
  for (const n of names) files.push({ id: n, ...prepare(await parseFile(n, sample(n))) });

  const counts = Object.fromEntries(files.map((f) => [f.id, new Set(f.tracks.map((t) => t.key)).size]));
  assert.deepEqual(counts, { 'walks-2023.gpx': 3, 'walks-2024.gpx': 3, 'walks-2025.kml': 2, 'spots.gpx': 0, 'export-sample.zip': 5,
    'hike-2025.fit': 1, 'garmin-export-sample.zip': 2 });

  const all = combine(files);
  const s = stats(all.tracks, all.waypoints);
  assert.equal(s.walks, 10, 'the ZIPs repeat walks, which count once; the ride and the course are skipped');
  assert.equal(s.spots, 7);
  assert.ok(s.km > 15 && s.km < 80, `km ${s.km}`);
  assert.deepEqual(years(all.tracks), [2022, 2023, 2024, 2025]);
  assert.equal(new Set(filterByYears(all.tracks, 2024, 2024).map((t) => t.key)).size, 3);
  assert.equal(new Set(filterByYears(all.tracks, 2024, null).map((t) => t.key)).size, 6);
});

test('large file: 300,000 points parse and simplify quickly', async () => {
  let xml = '<gpx>';
  let lat = 46, lon = -121;
  for (let trk = 0; trk < 60; trk++) {
    xml += `<trk><name>t${trk}</name><trkseg>`;
    for (let i = 0; i < 5000; i++) {
      lat += 2e-5 * Math.cos(i / 30 + trk);
      lon += 2e-5 * Math.sin(i / 45 + trk);
      xml += `<trkpt lat="${lat.toFixed(7)}" lon="${lon.toFixed(7)}"><ele>500.0</ele><time>2022-10-01T10:00:00Z</time></trkpt>\n`;
    }
    xml += '</trkseg></trk>';
  }
  xml += '</gpx>';
  const t0 = performance.now();
  const parsed = await parseFile('big.gpx', Buffer.from(xml));
  const t1 = performance.now();
  const prepared = prepare(parsed);
  const t2 = performance.now();
  const before = parsed.tracks.reduce((a, t) => a + t.segments[0].length / 2, 0);
  const after = prepared.tracks.reduce((a, t) => a + t.points.length / 2, 0);
  assert.equal(before, 300000);
  console.log(`  ${(xml.length / 1e6).toFixed(1)} MB: parse ${(t1 - t0).toFixed(0)} ms, simplify ${(t2 - t1).toFixed(0)} ms, ${before} -> ${after} points`);
  assert.ok(t2 - t0 < 10000);
});

// A made-up track: [seconds, metres per second] legs, heading east from a
// point, one point per second, with up to `jitter` metres of GPS noise.
function legs(spec, jitter = 0, start = [47.5, -121.8]) {
  let lat = start[0], lon = start[1], t = Date.UTC(2025, 9, 1, 16);
  const pts = [], times = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 2;
  const mPerDegLon = 111320 * Math.cos((lat * Math.PI) / 180);
  for (const [secs, mps] of spec) {
    for (let i = 0; i < secs; i++) {
      lon += mps / mPerDegLon;
      t += 1000;
      pts.push(lat + (rnd() * jitter) / 111320, lon + (rnd() * jitter) / mPerDegLon);
      times.push(t);
    }
  }
  return { points: Float64Array.from(pts), times: Float64Array.from(times) };
}
const mph = (v) => (v * 1609.344) / 3600;

test('splitBySpeed keeps walking and drops driving', () => {
  const max = mph(FAST_MPH);
  assert.equal(FAST_MPH, 4);

  // Walking at 3 mph with 4 m of GPS noise, and standing still with noise: all kept.
  for (const spec of [[[900, mph(3)]], [[600, 0]], [[600, mph(3.8)]]]) {
    const { points, times } = legs(spec, 4);
    const r = splitBySpeed(points, times, max);
    assert.equal(r.fast.length, 0, JSON.stringify(spec));
    assert.equal(r.slow.length, 1);
  }

  // Walk, drive with a 60 s stop at a junction, walk again.
  const { points, times } = legs([[600, mph(2.5)], [180, mph(35)], [60, 0], [240, mph(30)], [300, mph(2)]], 3);
  const r = splitBySpeed(points, times, max);
  assert.equal(r.fast.length, 1, 'the drive, stop included, is one stretch');
  assert.equal(r.slow.length, 2, 'walks before and after');
  // The fast stretch starts and ends within about 15 s of the car.
  const span = (a) => haversine(a[0], a[1], a[a.length - 2], a[a.length - 1]);
  const walk1 = 600 * mph(2.5), drive = mph(35) * 180 + mph(30) * 240;
  assert.ok(Math.abs(span(r.fast[0]) - drive) < 120, `drive ${span(r.fast[0])} vs ${drive}`);
  assert.ok(Math.abs(span(r.slow[0]) - walk1) < 30, `first walk ${span(r.slow[0])} vs ${walk1}`);

  // No times: nothing can be measured, so all kept.
  assert.equal(splitBySpeed(points, null, max).fast.length, 0);
});

test('prepare marks driving in a Garmin FIT walk', () => {
  // makeFit writes a point every stepS seconds; 3 s steps of 3.5 m is a walk,
  // of 40 m is driving.
  const step = (n, metres, from) => Array.from({ length: n }, (_, i) => [from[0], from[1] + ((i + 1) * metres) / 75000]);
  const walk1 = step(200, 3.5, [47.5, -121.8]);
  const drive = step(120, 40, walk1[walk1.length - 1]);
  const fit = makeFit({ segments: [[...walk1, ...drive]], startS: Date.UTC(2025, 9, 1, 16) / 1000 });
  const parsed = parseFIT(fit);
  assert.equal(parsed.tracks[0].times[0].length, 320);
  const p = prepare(parsed);
  assert.equal(p.tracks.filter((t) => t.fast).length, 1);
  assert.ok(p.tracks.some((t) => !t.fast));
  const walked = stats(p.tracks.filter((t) => !t.fast), []).km;
  assert.ok(walked > 0.5 && walked < 0.9, `walked ${walked} km`);
});
