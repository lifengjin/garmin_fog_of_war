// Public land from USGS PAD-US (Protected Areas Database of the United
// States), drawn as a see-through layer coloured by who manages each parcel.
// The map pictures come from USGS's public map service, drawn there with the
// colours below; a tap asks the same service which parcel is under the point.
// It shows who manages the land, not whether foraging is allowed there.

export const PADUS = 'https://edits.nationalmap.gov/arcgis/rest/services/PAD-US/PAD_US_4_1/MapServer';
export const LAND_CREDIT = 'Public land from <a href="https://www.usgs.gov/programs/gap-analysis-project/science/protected-areas">USGS PAD-US 4.1</a>';

// Manager groups, most specific first. `names` match the Mang_Name field;
// `types` (Mang_Type) catch whatever the named groups leave.
export const LAND_CLASSES = [
  { key: 'nps', label: 'National Park Service', colour: [123, 63, 160], names: ['NPS'] },
  { key: 'usfs', label: 'National Forest', colour: [46, 125, 50], names: ['USFS'] },
  { key: 'blm', label: 'Bureau of Land Management', colour: [214, 162, 30], names: ['BLM'] },
  { key: 'fed', label: 'Other federal', colour: [96, 112, 140], types: ['FED'] },
  { key: 'spr', label: 'State park', colour: [0, 137, 123], names: ['SPR'] },
  { key: 'dnr', label: 'State natural resources (DNR)', colour: [30, 110, 200], names: ['SDNR', 'SLB', 'SDOL'] },
  { key: 'state', label: 'Other state (fish and wildlife and more)', colour: [100, 170, 220], types: ['STAT'] },
  { key: 'local', label: 'County, city or regional', colour: [230, 120, 40], types: ['LOC', 'DIST'] },
  { key: 'trib', label: 'Tribal land', colour: [140, 90, 50], types: ['TRIB'] },
  { key: 'other', label: 'Private, nonprofit or other', colour: [170, 120, 150] },
];

const NAMED = LAND_CLASSES.flatMap((c) => c.names || []);
const FILL_ALPHA = 80; // of 255
const sym = ([r, g, b]) => ({
  type: 'esriSFS', style: 'esriSFSSolid', color: [r, g, b, FILL_ALPHA],
  outline: { type: 'esriSLS', style: 'esriSLSSolid', color: [r, g, b, 255], width: 1 },
});
const other = LAND_CLASSES.find((c) => c.key === 'other');

// Two drawings of the same layer: one coloured by manager name for the named
// agencies, one by manager type for the rest, so every parcel is drawn once.
export function dynamicLayers() {
  const quoted = NAMED.map((n) => `'${n}'`).join(',');
  const byName = LAND_CLASSES.filter((c) => c.names);
  const byType = LAND_CLASSES.filter((c) => c.types);
  return [
    {
      id: 1, source: { type: 'mapLayer', mapLayerId: 0 },
      definitionExpression: `Mang_Name IN (${quoted})`,
      drawingInfo: { renderer: { type: 'uniqueValue', field1: 'Mang_Name', defaultSymbol: sym(other.colour),
        uniqueValueInfos: byName.flatMap((c) => c.names.map((v) => ({ value: v, symbol: sym(c.colour) }))) } },
    },
    {
      id: 0, source: { type: 'mapLayer', mapLayerId: 0 },
      definitionExpression: `Mang_Name IS NULL OR Mang_Name NOT IN (${quoted})`,
      drawingInfo: { renderer: { type: 'uniqueValue', field1: 'Mang_Type', defaultSymbol: sym(other.colour),
        uniqueValueInfos: byType.flatMap((c) => c.types.map((v) => ({ value: v, symbol: sym(c.colour) }))) } },
    },
  ];
}

// One map picture for a box in Web Mercator metres.
export function exportUrl([xmin, ymin, xmax, ymax], size) {
  const q = new URLSearchParams({
    bbox: [xmin, ymin, xmax, ymax].map((v) => v.toFixed(1)).join(','),
    bboxSR: '3857', imageSR: '3857', size: `${size},${size}`,
    format: 'png32', transparent: 'true', f: 'image',
    dynamicLayers: JSON.stringify(dynamicLayers()),
  });
  return `${PADUS}/export?${q}`;
}

const FIELDS = 'Unit_Nm,Loc_Nm,Mang_Name,Loc_Mang,Mang_Type,Des_Tp,Loc_Ds,Pub_Access';
export function queryUrl(lat, lon) {
  const q = new URLSearchParams({
    geometry: `${lon},${lat}`, geometryType: 'esriGeometryPoint', inSR: '4326',
    spatialRel: 'esriSpatialRelIntersects', outFields: FIELDS, returnGeometry: 'false', f: 'json',
  });
  return `${PADUS}/0/query?${q}`;
}

export const MANAGERS = {
  TVA: 'Tennessee Valley Authority', BLM: 'Bureau of Land Management', BOEM: 'Bureau of Ocean Energy Management',
  USBR: 'Bureau of Reclamation', FWS: 'U.S. Fish and Wildlife Service', USFS: 'Forest Service', DOD: 'Department of Defense',
  USACE: 'Army Corps of Engineers', DOE: 'Department of Energy', NPS: 'National Park Service',
  NRCS: 'Natural Resources Conservation Service', ARS: 'Agricultural Research Service', BIA: 'Bureau of Indian Affairs',
  NOAA: 'National Oceanic and Atmospheric Administration', BPA: 'Bonneville Power Administration',
  OTHF: 'Other federal', TRIB: 'Tribal land', SPR: 'State Parks', SDC: 'State Department of Conservation',
  SLB: 'State Land Board', SFW: 'State Fish and Wildlife', SDNR: 'State Department of Natural Resources',
  SDOL: 'State Department of Land', OTHS: 'Other state', REG: 'Regional agency', RWD: 'Regional water district',
  CITY: 'City', CNTY: 'County', UNKL: 'Other local government', NGO: 'Nonprofit', PVT: 'Private', JNT: 'Joint',
  OTHR: 'Other', UNK: 'Unknown',
};
const DESIGNATIONS = {
  NP: 'National Park', NM: 'National Monument', NCA: 'Conservation Area', NF: 'National Forest', NG: 'National Grassland',
  PUB: 'National Public Lands', NWR: 'National Wildlife Refuge', WA: 'Wilderness Area', WSR: 'Wild and Scenic River',
  WSA: 'Wilderness Study Area', NRA: 'National Recreation Area', NSBV: 'National Scenic, Botanical or Volcanic Area',
  RNA: 'Research Natural Area', ACEC: 'Area of Critical Environmental Concern', MIL: 'Military land',
  TRIBL: 'Native American land', SP: 'State Park', SW: 'State Wilderness', SCA: 'State Conservation Area',
  SREC: 'State Recreation Area', SRMA: 'State Resource Management Area', LP: 'Local Park',
  LCA: 'Local Conservation Area', LREC: 'Local Recreation Area', LRMA: 'Local Resource Management Area',
  PCON: 'Private Conservation', PFOR: 'Private Forest Stewardship',
};
const ACCESS = { OA: 'Open to the public', RA: 'Restricted access', XA: 'Closed to the public', UK: '' };

export function landClass(a) {
  return LAND_CLASSES.find((c) => c.names?.includes(a.Mang_Name))
    || LAND_CLASSES.find((c) => c.types?.includes(a.Mang_Type))
    || other;
}

// Plain text lines for one parcel, from the service's attributes.
export function describeParcel(a) {
  const name = a.Unit_Nm || a.Loc_Nm || 'Unnamed parcel';
  const manager = [MANAGERS[a.Mang_Name] || a.Mang_Name, a.Loc_Mang && a.Loc_Mang !== a.Mang_Name ? a.Loc_Mang : '']
    .filter(Boolean).join(', ');
  const kind = DESIGNATIONS[a.Des_Tp] || a.Loc_Ds || '';
  return { name, manager: manager || 'Manager not listed', kind, access: ACCESS[a.Pub_Access] || '', cls: landClass(a) };
}

export async function lookUpLand(lat, lon, { fetchImpl = fetch } = {}) {
  const res = await fetchImpl(queryUrl(lat, lon), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`USGS answered ${res.status}`);
  const body = await res.json();
  if (body.error) throw new Error(body.error.message || 'USGS sent an error');
  return (body.features || []).map((f) => describeParcel(f.attributes || {}));
}
