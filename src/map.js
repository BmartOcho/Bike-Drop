import L from 'leaflet';
import 'leaflet/dist/leaflet.css';

export const COLORS = { empty: [255, 90, 90], half: [61, 220, 132], full: [90, 169, 255] };

function mix(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

/** Colour for a fill ratio 0..1: red (empty) → green (half) → blue (full). */
export function fillColor(ratio) {
  const r = Math.max(0, Math.min(1, ratio));
  const c = r < 0.5 ? mix(COLORS.empty, COLORS.half, r / 0.5) : mix(COLORS.half, COLORS.full, (r - 0.5) / 0.5);
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function radiusFor(cap) {
  return 4 + Math.sqrt(cap) * 1.05;
}

const HINT_GLYPH = { drain: '▼', flood: '▲', both: '⇅' };

/**
 * Leaflet map with CARTO dark tiles and one circle per station.
 * onSelect(idx) fires on tap.
 */
export function createMap(container, day, { forecast, onSelect }) {
  const map = L.map(container, { zoomControl: false, attributionControl: true, tap: true });
  // CARTO basemaps need a (free) API key since Sept 2026; without one the
  // tiles carry an "API key required" watermark. See README → Deploying.
  const key = import.meta.env.VITE_CARTO_API_KEY;
  const tileUrl = `https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}{r}.png${key ? `?key=${encodeURIComponent(key)}` : ''}`;
  if (!key) console.warn('Bike Drop: set VITE_CARTO_API_KEY to remove the CARTO watermark (https://carto.com/basemaps/apikey).');
  L.tileLayer(tileUrl, {
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
    maxZoom: 19,
  }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);

  const bounds = L.latLngBounds(day.stations.map((s) => [s.lat, s.lon]));
  map.fitBounds(bounds, { padding: [24, 24] });

  const circles = day.stations.map((s, i) => {
    const c = L.circleMarker([s.lat, s.lon], {
      radius: radiusFor(s.cap),
      color: '#0b0d12',
      weight: 1.5,
      fillColor: fillColor(day.inventory[i] / s.cap),
      fillOpacity: 0.92,
      bubblingMouseEvents: false,
    }).addTo(map);
    c.on('click', () => onSelect(i));
    c.bindTooltip(s.name, { direction: 'top', offset: [0, -radiusFor(s.cap)], opacity: 0.9 });
    return c;
  });

  const hints = day.stations.map((s, i) => {
    const h = forecast[i];
    if (!h) return null;
    return L.marker([s.lat, s.lon], {
      interactive: false,
      icon: L.divIcon({ className: `station-hint-icon ${h}`, html: HINT_GLYPH[h], iconSize: [14, 12], iconAnchor: [7, 6 + radiusFor(s.cap) + 7] }),
    }).addTo(map);
  });

  let badges = [];
  let selected = null;

  function setInventory(inv) {
    for (let i = 0; i < circles.length; i++) {
      const col = fillColor(inv[i] / day.stations[i].cap);
      if (circles[i].options.fillColor !== col) circles[i].setStyle({ fillColor: col });
    }
  }

  function setStation(i, v) {
    const col = fillColor(v / day.stations[i].cap);
    if (circles[i].options.fillColor !== col) circles[i].setStyle({ fillColor: col });
  }

  function setSelected(i) {
    if (selected != null) circles[selected].setStyle({ color: '#0b0d12', weight: 1.5 });
    selected = i;
    if (i != null) {
      circles[i].setStyle({ color: '#ffffff', weight: 3 });
      circles[i].bringToFront();
    }
  }

  function setPlan(plan) {
    badges.forEach((b) => b.remove());
    badges = plan.map((stop, k) => {
      const s = day.stations[stop.station];
      return L.marker([s.lat, s.lon], {
        interactive: false,
        icon: L.divIcon({ className: '', html: `<div class="stop-badge">${k + 1}</div>`, iconSize: [18, 18], iconAnchor: [-radiusFor(s.cap) * 0.5, radiusFor(s.cap) + 10] }),
      }).addTo(map);
    });
  }

  function setHintsVisible(v) {
    hints.forEach((h) => h && (v ? h.addTo(map) : h.remove()));
  }

  return { map, circles, setInventory, setStation, setSelected, setPlan, setHintsVisible, fitAll: () => map.fitBounds(bounds, { padding: [24, 24] }) };
}
