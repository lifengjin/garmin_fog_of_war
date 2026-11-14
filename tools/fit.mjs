// A small FIT file writer, only for making the made-up sample and test files.
// It writes what a Garmin watch would for a recorded activity: file_id,
// GPS records, timer events, a session with the sport, and the file CRC.

const FIT_EPOCH_S = 631065600;
const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401,
  0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

export function fitCrc(bytes, crc = 0) {
  for (const b of bytes) {
    let tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[b & 0xf];
    tmp = CRC_TABLE[crc & 0xf];
    crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[(b >> 4) & 0xf];
  }
  return crc;
}

const SIZES = { 0x00: 1, 0x02: 1, 0x84: 2, 0x85: 4, 0x86: 4, 0x07: 0 };

class Writer {
  constructor() { this.bytes = []; }
  u8(v) { this.bytes.push(v & 0xff); }
  num(v, size, little, signed) {
    const b = new DataView(new ArrayBuffer(size));
    if (size === 1) b.setUint8(0, v & 0xff);
    else if (size === 2) b.setUint16(0, v & 0xffff, little);
    else if (signed) b.setInt32(0, v, little);
    else b.setUint32(0, v >>> 0, little);
    for (let i = 0; i < size; i++) this.u8(b.getUint8(i));
  }
}

// fields: [[fieldNum, baseType, size?]]
// opts.bigEndian writes that message type big-endian; opts.devFields adds
// developer fields of the given sizes (filled with zeros).
export function makeFit({ fileType = 4, sport = 17, sportName = null, segments, startS, stepS = 3, compressEvery = 0 }) {
  const w = new Writer();
  const defs = {};

  function define(local, global, fields, { bigEndian = false, devFields = [] } = {}) {
    w.u8(0x40 | (devFields.length ? 0x20 : 0) | local);
    w.u8(0); // reserved
    w.u8(bigEndian ? 1 : 0);
    w.num(global, 2, !bigEndian);
    w.u8(fields.length);
    for (const [num, type, size] of fields) { w.u8(num); w.u8(size ?? SIZES[type]); w.u8(type); }
    if (devFields.length) {
      w.u8(devFields.length);
      devFields.forEach((size, i) => { w.u8(i); w.u8(size); w.u8(0); });
    }
    defs[local] = { fields, little: !bigEndian, devFields };
  }

  function data(local, values, { compressed = null } = {}) {
    const def = defs[local];
    if (compressed != null) w.u8(0x80 | (local << 5) | (compressed & 0x1f));
    else w.u8(local);
    def.fields.forEach(([num, type, size], i) => {
      const v = values[i];
      if (type === 0x07) {
        const enc = new TextEncoder().encode(v);
        for (let j = 0; j < size; j++) w.u8(j < enc.length ? enc[j] : 0);
      } else {
        w.num(v, size ?? SIZES[type], def.little, type === 0x85);
      }
    });
    for (const size of def.devFields) for (let j = 0; j < size; j++) w.u8(0);
  }

  const semi = (deg) => Math.round((deg / 180) * 2 ** 31);
  let t = startS - FIT_EPOCH_S;

  // file_id: type, manufacturer (garmin), time_created
  define(0, 0, [[0, 0x00], [1, 0x84], [4, 0x86]]);
  data(0, [fileType, 1, t]);

  // record: timestamp, lat, long, altitude (uint16, big-endian, with a developer field)
  define(1, 20, [[253, 0x86], [0, 0x85], [1, 0x85], [2, 0x84]], { bigEndian: true, devFields: [2] });
  // record without timestamp, used with compressed timestamp headers
  define(2, 20, [[0, 0x85], [1, 0x85]]);
  // event: timestamp, event, event_type
  define(3, 21, [[253, 0x86], [0, 0x00], [1, 0x00]]);

  data(3, [t, 0, 0]); // timer start
  segments.forEach((seg, si) => {
    if (si > 0) {
      t += 600; // a ten-minute pause
      data(3, [t, 0, 0]); // timer start
    }
    seg.forEach(([lat, lon], i) => {
      t += stepS;
      if (compressEvery && i % compressEvery === compressEvery - 1) {
        data(2, [semi(lat), semi(lon)], { compressed: t & 0x1f });
      } else {
        data(1, [t, semi(lat), semi(lon), 2500 + 4600]);
      }
    });
    data(3, [t, 0, 1]); // timer stop
  });

  if (sportName != null) {
    define(4, 12, [[0, 0x00], [3, 0x07, 16]]);
    data(4, [sport, sportName]);
  }
  // session: timestamp, start_time, sport
  define(5, 18, [[253, 0x86], [2, 0x86], [5, 0x00]]);
  data(5, [t, startS - FIT_EPOCH_S, sport]);

  const body = Uint8Array.from(w.bytes);
  const header = new Uint8Array(14);
  const hv = new DataView(header.buffer);
  header[0] = 14; header[1] = 0x20;
  hv.setUint16(2, 2132, true);
  hv.setUint32(4, body.length, true);
  header.set([0x2e, 0x46, 0x49, 0x54], 8);
  hv.setUint16(12, fitCrc(header.subarray(0, 12)), true);
  const out = new Uint8Array(14 + body.length + 2);
  out.set(header); out.set(body, 14);
  new DataView(out.buffer).setUint16(14 + body.length, fitCrc(out.subarray(0, 14 + body.length)), true);
  return out;
}
