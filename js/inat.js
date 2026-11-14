// Sightings from iNaturalist, shown as a map overlay.
// The site asks iNaturalist's public API for them (no key, no sign-in) and
// keeps a copy on this device, so the overlay still shows with no signal.

export const SIGHTINGS = {
  key: 'candystick',
  name: 'Candystick',
  sci: 'Allotropa virgata',
  taxonId: 62481,
  place: 'Washington',
  placeId: 46,
};

const API = 'https://api.inaturalist.org/v2/observations';
const FIELDS = 'id,observed_on,obscured,geojson,positional_accuracy,quality_grade,user.login';
const PER_PAGE = 200;
export const REFRESH_DAYS = 7;

// Turns one API result into what the map needs. Observations whose place
// iNaturalist hides (obscured) only have a point picked at random within
// about 20 km, so they are counted but not mapped.
export function toSighting(o) {
  const c = o?.geojson?.coordinates;
  if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) return null;
  return {
    id: o.id,
    lat: c[1],
    lon: c[0],
    date: o.observed_on || '',
    acc: Number.isFinite(o.positional_accuracy) ? o.positional_accuracy : null,
    grade: o.quality_grade || '',
    user: o.user?.login || '',
    obscured: !!o.obscured,
  };
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Reads every page (200 at a time, about a second apart as iNaturalist asks).
export async function fetchSightings(spec = SIGHTINGS, { fetchImpl = fetch, delayMs = 1000, onProgress } = {}) {
  const items = [];
  let obscured = 0;
  let total = 0;
  let idAbove = 0;
  for (let page = 0; page < 100; page++) {
    if (page) await pause(delayMs);
    const url = `${API}?taxon_id=${spec.taxonId}&place_id=${spec.placeId}&per_page=${PER_PAGE}` +
      `&order_by=id&order=asc&id_above=${idAbove}&fields=${FIELDS}`;
    const res = await fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`iNaturalist answered ${res.status}`);
    const body = await res.json();
    if (!page) total = body.total_results || 0;
    const results = body.results || [];
    for (const o of results) {
      const s = toSighting(o);
      if (!s) continue;
      if (s.obscured) obscured++;
      else items.push(s);
    }
    onProgress?.(items.length + obscured, total);
    if (results.length < PER_PAGE) break;
    idAbove = results[results.length - 1].id;
  }
  return { key: spec.key, fetchedAt: Date.now(), total, obscured, items };
}

export const isStale = (data, now = Date.now()) => !data || now - data.fetchedAt > REFRESH_DAYS * 864e5;
