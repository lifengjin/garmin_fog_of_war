// Generates the made-up sample files in samples/. None of this is real data:
// the walks are random wanders around an arbitrary point in a national forest.
//
//   node tools/make-samples.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeZip } from './zip.mjs';
import { makeFit } from './fit.mjs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'samples');
fs.mkdirSync(out, { recursive: true });

// Deterministic RNG so the samples don't change between runs.
let seed = 42;
const rand = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);

const CENTER = [45.30, -121.80];

// A wandering walk: ~1 point every 3 s at walking pace.
function walk(start, n, heading) {
  const pts = [];
  let [lat, lon] = start;
  let h = heading;
  for (let i = 0; i < n; i++) {
    h += (rand() - 0.5) * 0.5;
    const step = 3 + rand() * 2; // metres
    lat += (step * Math.cos(h)) / 111320;
    lon += (step * Math.sin(h)) / (111320 * Math.cos((lat * Math.PI) / 180));
    pts.push([lat + (rand() - 0.5) * 2e-5, lon + (rand() - 0.5) * 2e-5]);
  }
  return pts;
}

const off = (dlat, dlon) => [CENTER[0] + dlat, CENTER[1] + dlon];
const iso = (d) => new Date(d).toISOString().replace('.000', '');

function gpxTrack(name, segments, startMs) {
  let t = startMs;
  const segs = segments.map((seg) => `    <trkseg>\n${seg.map(([la, lo]) => {
    t += 3000;
    return `      <trkpt lat="${la.toFixed(7)}" lon="${lo.toFixed(7)}"><ele>${(900 + rand() * 40).toFixed(1)}</ele><time>${iso(t)}</time></trkpt>`;
  }).join('\n')}\n    </trkseg>`).join('\n');
  return `  <trk>\n    <name>${name}</name>\n${segs}\n  </trk>`;
}

const gpx = (body) => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="foraging-fog-map sample generator" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>Made-up sample data</name></metadata>
${body}
</gpx>
`;

// 2023: three walks, one with a pause (two segments)
const w2023 = gpx([
  gpxTrack('Sample walk: north ridge', [walk(off(0.004, -0.006), 900, 0.3)], Date.UTC(2023, 9, 7, 17)),
  gpxTrack('Sample walk: creek loop', [walk(off(-0.003, -0.004), 700, 2.2), walk(off(-0.006, 0.000), 500, 1.0)], Date.UTC(2023, 9, 21, 16)),
  gpxTrack('Sample walk: old road', [walk(off(0.000, 0.002), 1200, 1.4)], Date.UTC(2023, 10, 4, 18)),
].join('\n'));

// 2024
const w2024 = gpx([
  gpxTrack('Sample walk: east slope', [walk(off(0.002, 0.008), 1000, 3.4)], Date.UTC(2024, 8, 29, 17)),
  gpxTrack('Sample walk: south flats', [walk(off(-0.008, 0.003), 800, 5.0)], Date.UTC(2024, 9, 12, 19)),
  gpxTrack('Sample walk: north ridge again', [walk(off(0.005, -0.004), 600, 0.8)], Date.UTC(2024, 10, 2, 17)),
].join('\n'));

// 2025 as KML: one plain LineString and one gx:Track, plus two points
const kmlLine = walk(off(0.007, 0.004), 700, 2.6);
const kmlTrack = walk(off(-0.004, 0.010), 600, 4.2);
let t25 = Date.UTC(2025, 9, 18, 17);
const w2025 = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2" xmlns:gx="http://www.google.com/kml/ext/2.2">
<Document>
  <name>Made-up sample data</name>
  <Placemark>
    <name>Sample walk: west bench (KML line)</name>
    <TimeStamp><when>${iso(Date.UTC(2025, 9, 5, 17))}</when></TimeStamp>
    <LineString><coordinates>
${kmlLine.map(([la, lo]) => `      ${lo.toFixed(7)},${la.toFixed(7)},950`).join('\n')}
    </coordinates></LineString>
  </Placemark>
  <Placemark>
    <name>Sample walk: far meadow (gx:Track)</name>
    <gx:Track>
${kmlTrack.map(() => `      <when>${iso((t25 += 3000))}</when>`).join('\n')}
${kmlTrack.map(([la, lo]) => `      <gx:coord>${lo.toFixed(7)} ${la.toFixed(7)} 950</gx:coord>`).join('\n')}
    </gx:Track>
  </Placemark>
  <Placemark>
    <name>Sample spot: oyster log</name>
    <description><![CDATA[Made-up spot. Fallen alder, check after rain.]]></description>
    <Point><coordinates>${(CENTER[1] + 0.006).toFixed(6)},${(CENTER[0] + 0.0075).toFixed(6)},0</coordinates></Point>
  </Placemark>
  <Placemark>
    <name>Sample spot: nothing here</name>
    <description>Made-up spot. Looked twice, found nothing.</description>
    <Point><coordinates>${(CENTER[1] + 0.012).toFixed(6)},${(CENTER[0] - 0.005).toFixed(6)},0</coordinates></Point>
  </Placemark>
</Document>
</kml>
`;

const spots = gpx([
  ['Sample spot: chanterelle patch', 'Made-up spot. Under Douglas fir & hemlock, Oct.', 0.0042, -0.0048, Date.UTC(2023, 9, 7, 18)],
  ['Sample spot: lobster mushrooms', 'Made-up spot. Near the second switchback.', -0.0021, -0.0030, Date.UTC(2023, 9, 21, 17)],
  ['Sample spot: hedgehogs', 'Made-up spot. Mossy bank <north side>.', 0.0010, 0.0045, Date.UTC(2024, 8, 29, 18)],
  ['Sample spot: king bolete', 'Made-up spot. One big one, 2024.', -0.0075, 0.0050, Date.UTC(2024, 9, 12, 20)],
  ['Sample spot: car', 'Made-up trailhead parking.', -0.0005, 0.0010, Date.UTC(2023, 9, 7, 16)],
].map(([name, desc, dlat, dlon, t]) => `  <wpt lat="${(CENTER[0] + dlat).toFixed(6)}" lon="${(CENTER[1] + dlon).toFixed(6)}">
    <time>${iso(t)}</time>
    <name>${name.replace(/&/g, '&amp;')}</name>
    <desc>${desc.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</desc>
    <sym>Flag, Green</sym>
  </wpt>`).join('\n'));

fs.writeFileSync(path.join(out, 'walks-2023.gpx'), w2023);
fs.writeFileSync(path.join(out, 'walks-2024.gpx'), w2024);
fs.writeFileSync(path.join(out, 'walks-2025.kml'), w2025);
fs.writeFileSync(path.join(out, 'spots.gpx'), spots);

// A ZIP laid out a bit like an account export, with the 2024 walks repeated
// inside (the app should count those walks only once).
fs.writeFileSync(path.join(out, 'export-sample.zip'), makeZip([
  { name: 'Explore/mapdata.gpx', data: w2024 },
  { name: 'Explore/extra.kmz', data: makeZip([{ name: 'doc.kml', data: w2025 }]), store: true },
  { name: 'README.txt', data: 'Made-up sample export.' },
]));

// FIT files, as Garmin Connect stores recorded activities. A hike with a
// pause (two segments), recorded with some compressed timestamps.
const hikeFit = makeFit({
  sport: 17, sportName: 'Hike',
  segments: [walk(off(0.006, -0.010), 600, 1.9), walk(off(0.003, -0.012), 500, 4.0)],
  startS: Date.UTC(2025, 9, 26, 17) / 1000, compressEvery: 4,
});
fs.writeFileSync(path.join(out, 'hike-2025.fit'), hikeFit);

// A ZIP laid out like Garmin's account data export: the activity FIT files sit
// in zips under DI_CONNECT/DI-Connect-Uploaded-Files. It repeats the 2025 hike
// (counted once), adds a 2022 walk, and has a bike ride and a planned course,
// which the map skips.
const walkFit = makeFit({
  sport: 11,
  segments: [walk(off(-0.010, -0.008), 900, 0.6)],
  startS: Date.UTC(2022, 9, 15, 18) / 1000,
});
const rideFit = makeFit({
  sport: 2,
  segments: [walk(off(-0.012, 0.012), 900, 1.2)],
  startS: Date.UTC(2024, 6, 4, 16) / 1000, stepS: 1,
});
const courseFit = makeFit({
  fileType: 6,
  segments: [walk(off(0.010, 0.010), 600, 3.0)],
  startS: Date.UTC(2025, 0, 1, 0) / 1000,
});
const uploaded = makeZip([
  { name: 'sample_100001.fit', data: walkFit },
  { name: 'sample_100002.fit', data: rideFit },
  { name: 'sample_100003.fit', data: hikeFit },
  { name: 'sample_100004.fit', data: courseFit },
]);
fs.writeFileSync(path.join(out, 'garmin-export-sample.zip'), makeZip([
  { name: 'DI_CONNECT/DI-Connect-Uploaded-Files/UploadedFiles_0-_Part1.zip', data: uploaded, store: true },
  { name: 'DI_CONNECT/DI-Connect-Fitness/sample_summarizedActivities.json', data: '[]' },
  { name: 'README.txt', data: 'Made-up sample export.' },
]));

console.log('Wrote samples to', out);
