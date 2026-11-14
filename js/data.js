// Turns parsed files into what the map draws. Pure functions (tested in Node).

import { simplifyLatLon, splitOnGaps, trackKey, waypointKey, trackLength } from './geo.js';

// Prepare one parsed file for storage: drop GPS jumps, simplify to ~2 m.
// Each stored piece keeps its walk's key, so a walk split into several
// segments still counts once.
export function prepare(parsed) {
  const tracks = [];
  for (const t of parsed.tracks) {
    const key = trackKey(t);
    for (const segment of t.segments) {
      for (const part of splitOnGaps(segment)) {
        const points = simplifyLatLon(part, 2);
        tracks.push({ key, name: t.name || '', time: t.time ?? null, endTime: t.endTime ?? null, points, length: trackLength(points) });
      }
    }
  }
  const waypoints = parsed.waypoints.map((w) => ({ ...w, key: waypointKey(w) }));
  return { tracks, waypoints, parts: parsed.parts || [] };
}

// Merge every cached file into one de-duplicated set.
export function combine(files) {
  const seenSpots = new Set();
  const tracks = [];
  const waypoints = [];
  // Files can share a track; keep the first copy of each.
  const byKey = new Map();
  for (const f of files) {
    for (const t of f.tracks) {
      if (!byKey.has(t.key)) byKey.set(t.key, f.id);
      if (byKey.get(t.key) !== f.id) continue; // an earlier file already has this walk
      tracks.push(t);
    }
    for (const w of f.waypoints) {
      if (seenSpots.has(w.key)) continue;
      seenSpots.add(w.key);
      waypoints.push(w);
    }
  }
  return { tracks, waypoints };
}

export function yearOf(ms) {
  return ms == null ? null : new Date(ms).getUTCFullYear();
}

export function filterByYears(tracks, fromYear, toYear) {
  if (!fromYear && !toYear) return tracks;
  return tracks.filter((t) => {
    const y = yearOf(t.time);
    if (y == null) return true; // undated walks always count
    return (!fromYear || y >= fromYear) && (!toYear || y <= toYear);
  });
}

export function stats(tracks, waypoints) {
  const walks = new Set(tracks.map((t) => t.key));
  let metres = 0;
  let first = null, last = null;
  for (const t of tracks) {
    metres += t.length || 0;
    if (t.time != null) {
      if (first == null || t.time < first) first = t.time;
      if (last == null || t.time > last) last = t.time;
    }
  }
  return { walks: walks.size, km: metres / 1000, spots: waypoints.length, first, last };
}

export function years(tracks) {
  return [...new Set(tracks.map((t) => yearOf(t.time)).filter((y) => y != null))].sort();
}
