// Geometry helpers. No DOM, no Leaflet: runs in the browser and in Node.

const R = 6378137; // Web Mercator sphere radius (metres)

// Distance in metres between two lat/lon points (haversine).
export function haversine(lat1, lon1, lat2, lon2) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function trackLength(points) {
  let d = 0;
  for (let i = 2; i < points.length; i += 2) d += haversine(points[i - 2], points[i - 1], points[i], points[i + 1]);
  return d;
}

// Lat/lon -> normalized Web Mercator (u, v) in [0, 1]. Pixel position at zoom z
// is u * 256 * 2^z, which lets us draw years of tracks without Leaflet's
// per-point projection overhead.
export function toUV(lat, lon) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const s = Math.sin((clamped * Math.PI) / 180);
  const u = 0.5 + lon / 360;
  const v = 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI);
  return [u, v];
}

export function projectTrack(points) {
  const n = points.length / 2;
  const uv = new Float64Array(n * 2);
  let minU = Infinity, minV = Infinity, maxU = -Infinity, maxV = -Infinity, latSum = 0;
  for (let i = 0; i < n; i++) {
    const [u, v] = toUV(points[2 * i], points[2 * i + 1]);
    uv[2 * i] = u;
    uv[2 * i + 1] = v;
    if (u < minU) minU = u;
    if (u > maxU) maxU = u;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
    latSum += points[2 * i];
  }
  return { uv, bbox: [minU, minV, maxU, maxV], meanLat: latSum / n };
}

// Metres of ground -> fraction of world width, at a latitude.
export function metresToUV(m, lat) {
  return m / (2 * Math.PI * R * Math.cos((lat * Math.PI) / 180));
}

// Douglas-Peucker on a flat [x, y, x, y, ...] array (iterative, no recursion
// so very long tracks are safe). Tolerance in the same units as the input.
export function simplify(flat, tolerance) {
  const n = flat.length / 2;
  if (n <= 2 || tolerance <= 0) return flat;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [0, n - 1];
  const tol2 = tolerance * tolerance;
  while (stack.length) {
    const last = stack.pop();
    const first = stack.pop();
    const ax = flat[2 * first], ay = flat[2 * first + 1];
    const bx = flat[2 * last], by = flat[2 * last + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, index = -1;
    for (let i = first + 1; i < last; i++) {
      const px = flat[2 * i], py = flat[2 * i + 1];
      let d2;
      if (len2 === 0) {
        d2 = (px - ax) ** 2 + (py - ay) ** 2;
      } else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        d2 = (px - ax - t * dx) ** 2 + (py - ay - t * dy) ** 2;
      }
      if (d2 > maxD) { maxD = d2; index = i; }
    }
    if (maxD > tol2) {
      keep[index] = 1;
      stack.push(first, index, index, last);
    }
  }
  let count = 0;
  for (let i = 0; i < n; i++) count += keep[i];
  const out = new Float64Array(count * 2);
  for (let i = 0, j = 0; i < n; i++) {
    if (keep[i]) { out[j++] = flat[2 * i]; out[j++] = flat[2 * i + 1]; }
  }
  return out;
}

// Simplify a lat/lon track to roughly `metres` of accuracy (done once at
// import, it typically removes 70-90% of GPS points with no visible change).
export function simplifyLatLon(points, metres = 2) {
  if (points.length < 6) return points;
  const lat0 = points[0];
  const ky = 111320;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180);
  const flat = new Float64Array(points.length);
  for (let i = 0; i < points.length; i += 2) {
    flat[i] = points[i + 1] * kx;
    flat[i + 1] = points[i] * ky;
  }
  const s = simplify(flat, metres);
  const out = new Float64Array(s.length);
  for (let i = 0; i < s.length; i += 2) {
    out[i] = s[i + 1] / ky;
    out[i + 1] = s[i] / kx;
  }
  return out;
}

// Split a track wherever consecutive points are implausibly far apart
// (GPS jumps, or a device that was turned off in the car), so the fog
// doesn't clear a straight line between two trailheads.
export function splitOnGaps(points, maxGapMetres = 500) {
  const parts = [];
  let start = 0;
  for (let i = 2; i < points.length; i += 2) {
    if (haversine(points[i - 2], points[i - 1], points[i], points[i + 1]) > maxGapMetres) {
      if (i - start >= 4) parts.push(points.slice(start, i));
      start = i;
    }
  }
  if (points.length - start >= 4) parts.push(points.slice(start));
  return parts;
}

// Stable-ish fingerprint so the same walk imported twice (e.g. from a
// single GPX and from a full Garmin export) only counts once.
export function trackKey(t) {
  const a = t.segments[0];
  const z = t.segments[t.segments.length - 1];
  const n = t.segments.reduce((sum, s) => sum + s.length, 0);
  const r = (x) => x.toFixed(5);
  return [n, r(a[0]), r(a[1]), r(z[z.length - 2]), r(z[z.length - 1]), t.time ?? ''].join('|');
}

export function waypointKey(w) {
  return `${w.lat.toFixed(5)}|${w.lon.toFixed(5)}|${(w.name || '').toLowerCase()}`;
}
