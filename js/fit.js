// Reader for Garmin FIT activity files.
//
// FIT is Garmin's binary format for recorded activities. Garmin Connect keeps
// every activity as a FIT file, and the account data export contains them.
// This reads just what the map needs: the GPS points of each recorded
// activity, its start and end time and its sport. Like the GPX reader, it
// returns { tracks: [{ name, time, endTime, sport, segments }], waypoints: [] }.
//
// Format reference: the FIT protocol (header, definition and data messages,
// compressed timestamp headers, chained files). No dependencies.

const FIT_EPOCH_MS = 631065600000; // 1989-12-31T00:00:00Z
const SEMICIRCLE = 180 / 2 ** 31;

// Global message numbers and field numbers used here.
const MSG_FILE_ID = 0;
const MSG_SPORT = 12;
const MSG_SESSION = 18;
const MSG_RECORD = 20;
const MSG_EVENT = 21;
const FIELD_TIMESTAMP = 253;

// file_id.type values. Only activities are walked; courses are planned routes
// (like GPX routes), which shouldn't clear fog.
const FILE_ACTIVITY = 4;

// Sports done on foot. Activities of other sports (rides, drives, paddling,
// skiing, flights...) are skipped so they don't clear fog along roads or
// rivers. An activity with no sport recorded is kept.
export const ON_FOOT_SPORTS = new Map([
  [0, 'Activity'], // generic
  [1, 'Run'],
  [11, 'Walk'],
  [16, 'Mountaineering'],
  [17, 'Hike'],
  [28, 'Hunting'],
  [29, 'Fishing'],
  [35, 'Snowshoe'],
]);

const TEXT = new TextDecoder('utf-8');

export function isFIT(bytes) {
  return bytes.length >= 12 && (bytes[0] === 12 || bytes[0] === 14) &&
    bytes[8] === 0x2e && bytes[9] === 0x46 && bytes[10] === 0x49 && bytes[11] === 0x54; // ".FIT"
}

// Read one field value. Returns null for FIT's "invalid" values.
function readValue(dv, pos, size, baseType, little) {
  const bt = baseType & 0x1f;
  switch (bt) {
    case 0x00: case 0x02: case 0x0a: case 0x0d: { // enum, uint8, uint8z, byte
      if (size < 1) return null;
      const v = dv.getUint8(pos);
      return (bt === 0x0a ? v === 0 : v === 0xff) ? null : v;
    }
    case 0x01: { // sint8
      if (size < 1) return null;
      const v = dv.getInt8(pos);
      return v === 0x7f ? null : v;
    }
    case 0x03: { // sint16
      if (size < 2) return null;
      const v = dv.getInt16(pos, little);
      return v === 0x7fff ? null : v;
    }
    case 0x04: case 0x0b: { // uint16, uint16z
      if (size < 2) return null;
      const v = dv.getUint16(pos, little);
      return (bt === 0x0b ? v === 0 : v === 0xffff) ? null : v;
    }
    case 0x05: { // sint32
      if (size < 4) return null;
      const v = dv.getInt32(pos, little);
      return v === 0x7fffffff ? null : v;
    }
    case 0x06: case 0x0c: { // uint32, uint32z
      if (size < 4) return null;
      const v = dv.getUint32(pos, little);
      return (bt === 0x0c ? v === 0 : v === 0xffffffff) ? null : v;
    }
    case 0x07: { // string
      const u8 = new Uint8Array(dv.buffer, dv.byteOffset + pos, size);
      const end = u8.indexOf(0);
      const s = TEXT.decode(end < 0 ? u8 : u8.subarray(0, end)).trim();
      return s || null;
    }
    default:
      return null; // floats and 64-bit types aren't needed here
  }
}

// Parse one FIT file (or a chain of them) into tracks.
export function parseFIT(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tracks = [];
  // What was found, so the app can say why a file cleared no fog.
  const fit = { activities: 0, read: 0, notActivity: 0, notOnFoot: 0, noGps: 0 };

  let start = 0;
  while (start + 12 <= u8.length && isFIT(u8.subarray(start))) {
    const headerSize = u8[start];
    const dataSize = dv.getUint32(start + 4, true);
    // A truncated file (e.g. a device that lost power) may report a size past
    // the end; read what is there.
    const end = Math.min(u8.length, start + headerSize + dataSize);
    const { track, skip } = parseOne(dv, start + headerSize, end);
    if (skip === 'notActivity') fit.notActivity++;
    else {
      fit.activities++;
      if (track) { fit.read++; tracks.push(track); } else fit[skip]++;
    }
    start = start + headerSize + dataSize + 2; // + CRC
  }
  return { tracks, waypoints: [], fit };
}

function parseOne(dv, pos, end) {
  const defs = new Array(16);
  let fileType = null;
  let sport = null;
  let sportName = null;
  let lastTimestamp = null;
  let firstTime = null;
  let lastTime = null;
  const segments = [];
  let pts = [];

  const closeSegment = () => {
    if (pts.length >= 4) segments.push(Float64Array.from(pts));
    pts = [];
  };

  while (pos < end) {
    const header = dv.getUint8(pos++);

    // Compressed timestamp header: a data message with a 5-bit time offset.
    if (header & 0x80) {
      const local = (header >> 5) & 0x03;
      const def = defs[local];
      if (!def) break;
      if (lastTimestamp != null) {
        const offset = header & 0x1f;
        let ts = (lastTimestamp & ~0x1f) + offset;
        if (offset < (lastTimestamp & 0x1f)) ts += 0x20;
        lastTimestamp = ts;
      }
      if (pos + def.size > end) break;
      handle(def, pos, lastTimestamp);
      pos += def.size;
      continue;
    }

    const local = header & 0x0f;

    if (header & 0x40) {
      // Definition message.
      if (pos + 5 > end) break;
      const little = dv.getUint8(pos + 1) === 0;
      const global = dv.getUint16(pos + 2, little);
      const nFields = dv.getUint8(pos + 4);
      pos += 5;
      if (pos + nFields * 3 > end) break;
      const fields = [];
      let offset = 0;
      for (let i = 0; i < nFields; i++) {
        const num = dv.getUint8(pos);
        const size = dv.getUint8(pos + 1);
        const baseType = dv.getUint8(pos + 2);
        fields.push({ num, size, baseType, offset });
        offset += size;
        pos += 3;
      }
      if (header & 0x20) {
        // Developer fields: only their sizes matter here.
        if (pos + 1 > end) break;
        const nDev = dv.getUint8(pos++);
        if (pos + nDev * 3 > end) break;
        for (let i = 0; i < nDev; i++) {
          offset += dv.getUint8(pos + 1);
          pos += 3;
        }
      }
      const byNum = new Map(fields.map((f) => [f.num, f]));
      defs[local] = { global, little, size: offset, byNum };
      continue;
    }

    // Normal data message.
    const def = defs[local];
    if (!def || pos + def.size > end) break;
    const tsField = def.byNum.get(FIELD_TIMESTAMP);
    if (tsField) {
      const ts = readValue(dv, pos + tsField.offset, tsField.size, tsField.baseType, def.little);
      if (ts != null) lastTimestamp = ts;
    }
    handle(def, pos, lastTimestamp);
    pos += def.size;
  }

  function get(def, pos, num) {
    const f = def.byNum.get(num);
    return f ? readValue(dv, pos + f.offset, f.size, f.baseType, def.little) : null;
  }

  function handle(def, at, ts) {
    switch (def.global) {
      case MSG_FILE_ID:
        fileType = get(def, at, 0);
        break;
      case MSG_SESSION:
        if (sport == null) sport = get(def, at, 5);
        break;
      case MSG_SPORT:
        if (sport == null) sport = get(def, at, 0);
        sportName = sportName || get(def, at, 3);
        break;
      case MSG_EVENT: {
        // A timer stop ends a segment, so the fog isn't cleared in a straight
        // line between where the watch was paused and where it resumed.
        const event = get(def, at, 0);
        const type = get(def, at, 1);
        if (event === 0 && (type === 1 || type === 4)) closeSegment(); // timer stop / stop all
        break;
      }
      case MSG_RECORD: {
        const lat = get(def, at, 0);
        const lon = get(def, at, 1);
        if (lat == null || lon == null) break;
        const la = lat * SEMICIRCLE;
        const lo = lon * SEMICIRCLE;
        if (Math.abs(la) > 90 || Math.abs(lo) > 180 || (la === 0 && lo === 0)) break;
        pts.push(la, lo);
        if (ts != null) {
          const t = FIT_EPOCH_MS + ts * 1000;
          if (firstTime == null) firstTime = t;
          lastTime = t;
        }
        break;
      }
      default:
        break;
    }
  }

  closeSegment();
  if (fileType != null && fileType !== FILE_ACTIVITY) return { skip: 'notActivity' };
  if (sport != null && !ON_FOOT_SPORTS.has(sport)) return { skip: 'notOnFoot' };
  if (!segments.length) return { skip: 'noGps' };
  const label = sportName || ON_FOOT_SPORTS.get(sport ?? 0) || 'Activity';
  return { track: { name: label, time: firstTime, endTime: lastTime, sport, segments } };
}
