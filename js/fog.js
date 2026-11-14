// The fog-of-war layer: a canvas covering the map with fog, with every
// walked track "erased" out of it as a strip `widthMetres` wide.
//
// Built on L.Renderer so it gets Leaflet's padding, panning and smooth zoom
// animation for free. Tracks are pre-projected to normalized Web Mercator and
// simplified per zoom level, so redraws stay fast with years of data.

import { projectTrack, metresToUV, simplify } from './geo.js';

const L = window.L;

export const FogLayer = L.Renderer.extend({
  options: {
    padding: 0.5,
    pane: 'fogPane',
    widthMetres: 30,
    fogColor: '#121a16',
    fogOpacity: 0.78,
    showLines: false,
    lineColor: '#ff8a3d',
    minWidthPx: 1.25,
  },

  initialize(options) {
    L.Renderer.prototype.initialize.call(this, options);
    this._tracks = [];
  },

  // tracks: [{ points: Float64Array lat/lon, ... }]
  setTracks(tracks) {
    this._tracks = tracks.map((t) => {
      const p = projectTrack(t.points);
      return { ...p, levels: new Map() };
    });
    this.redraw();
    return this;
  },

  setOptions(opts) {
    L.setOptions(this, opts);
    this.redraw();
    return this;
  },

  redraw() {
    if (this._map && this._ctx) this._draw();
    return this;
  },

  getEvents() {
    const events = L.Renderer.prototype.getEvents.call(this);
    events.move = this._onMove;
    return events;
  },

  _initContainer() {
    const c = (this._container = document.createElement('canvas'));
    c.className = 'fog-canvas';
    this._ctx = c.getContext('2d');
  },

  _destroyContainer() {
    if (this._moveFrame) cancelAnimationFrame(this._moveFrame);
    L.DomUtil.remove(this._container);
    delete this._ctx;
    delete this._container;
  },

  // While dragging, redraw early if the view runs past the padded canvas.
  _onMove() {
    if (!this._bounds || this._map._animatingZoom || this._moveFrame) return;
    const size = this._map.getSize();
    const tl = this._map.containerPointToLayerPoint([0, 0]);
    const br = this._map.containerPointToLayerPoint(size);
    const b = this._bounds;
    const margin = 8;
    if (tl.x < b.min.x + margin || tl.y < b.min.y + margin || br.x > b.max.x - margin || br.y > b.max.y - margin) {
      this._moveFrame = requestAnimationFrame(() => {
        this._moveFrame = null;
        this._update();
      });
    }
  },

  _update() {
    if (this._map._animatingZoom && this._bounds) return;
    L.Renderer.prototype._update.call(this);
    const b = this._bounds;
    const size = b.getSize();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const c = this._container;
    L.DomUtil.setPosition(c, b.min);
    c.width = Math.round(size.x * dpr);
    c.height = Math.round(size.y * dpr);
    c.style.width = `${size.x}px`;
    c.style.height = `${size.y}px`;
    this._dpr = dpr;
    this._draw();
    this.fire('update');
  },

  // Simplified copy of a track for an integer zoom level (half-pixel accuracy).
  _level(track, z) {
    let pts = track.levels.get(z);
    if (!pts) {
      pts = simplify(track.uv, 0.5 / (256 * 2 ** z));
      track.levels.set(z, pts);
    }
    return pts;
  },

  _draw() {
    const ctx = this._ctx;
    const map = this._map;
    if (!ctx || !map || !this._bounds) return;
    const o = this.options;
    const dpr = this._dpr || 1;
    const size = this._bounds.getSize();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    ctx.globalAlpha = o.fogOpacity;
    ctx.fillStyle = o.fogColor;
    ctx.fillRect(0, 0, size.x, size.y);
    ctx.globalAlpha = 1;

    const zoom = map.getZoom();
    const scale = 256 * 2 ** zoom;
    const origin = map.getPixelOrigin().add(this._bounds.min); // canvas top-left in world pixels
    const ox = origin.x, oy = origin.y;
    const level = Math.max(0, Math.min(22, Math.round(zoom)));

    // Visible area in uv units, for culling.
    const vMinU = ox / scale, vMinV = oy / scale;
    const vMaxU = (ox + size.x) / scale, vMaxV = (oy + size.y) / scale;

    const visible = [];
    for (const t of this._tracks) {
      const [a, b, c, d] = t.bbox;
      const pad = metresToUV(o.widthMetres, t.meanLat);
      if (c + pad < vMinU || a - pad > vMaxU || d + pad < vMinV || b - pad > vMaxV) continue;
      visible.push(t);
    }

    const pathFor = (t) => {
      const pts = this._level(t, level);
      ctx.beginPath();
      ctx.moveTo(pts[0] * scale - ox, pts[1] * scale - oy);
      for (let i = 2; i < pts.length; i += 2) ctx.lineTo(pts[i] * scale - ox, pts[i + 1] * scale - oy);
      if (pts.length === 2) ctx.lineTo(pts[0] * scale - ox + 0.01, pts[1] * scale - oy);
    };

    // Erase the fog along each track: a soft outer edge, then the full strip.
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#000';
    for (const pass of [{ k: 1.5, alpha: 0.35 }, { k: 1, alpha: 1 }]) {
      ctx.globalAlpha = pass.alpha;
      for (const t of visible) {
        const w = Math.max(o.minWidthPx * pass.k, metresToUV(o.widthMetres, t.meanLat) * scale * pass.k);
        ctx.lineWidth = w;
        pathFor(t);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    if (o.showLines) {
      ctx.strokeStyle = o.lineColor;
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.5;
      for (const t of visible) {
        pathFor(t);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  },
});
