/**
 * 60-second animated replay of the simulator's event timeline on a canvas
 * laid over the Leaflet map. All counts come straight from the sim events, so
 * the HUD always matches `simulate()`.
 */
import { fmtClock } from './sim.js';

export function createReplay({ day, canvas, mapApi, hud, durationMs = 60000, onDone }) {
  const ctx = canvas.getContext('2d');
  const { map } = mapApi;
  const windowStart = day.window?.start ?? 6 * 3600;
  const windowEnd = day.window?.end ?? 10 * 3600;
  let lastEnd = windowEnd;
  let events = [];
  let raf = 0;
  let startWall = 0;
  let simSpan = windowEnd - windowStart;
  let running = false;
  let inventory = null;
  let flashes = []; // { lat, lon, t0, kind }
  let active = new Map(); // trip idx → { from:[lat,lon], to:[lat,lon], t0, t1 }
  let ei = 0;
  let counts = { served: 0, stranded: 0, full: 0 };
  let dirtyStations = new Set();

  function coord(idx) {
    if (idx >= 0) return [day.stations[idx].lat, day.stations[idx].lon];
    if (idx < -1 && day.ext[-idx - 1]) return day.ext[-idx - 1];
    return null;
  }

  function resize() {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
  }

  function start(result) {
    stop();
    events = result.events;
    inventory = Int32Array.from(result.startInventory ?? day.inventory);
    lastEnd = Math.max(windowEnd, events.length ? events[events.length - 1].t + 1 : windowEnd);
    simSpan = lastEnd - windowStart;
    ei = 0;
    counts = { served: 0, stranded: 0, full: 0 };
    flashes = [];
    active = new Map();
    running = true;
    mapApi.setInventory(inventory);
    startWall = performance.now();
    raf = requestAnimationFrame(frame);
  }

  function applyEvent(e) {
    const trip = day.trips[e.trip];
    switch (e.type) {
      case 'depart': {
        if (e.station >= 0) {
          inventory[e.station]--;
          dirtyStations.add(e.station);
        }
        const from = coord(trip[1]);
        const to = coord(trip[2]);
        if (from && to) active.set(e.trip, { from, to, t0: trip[0], t1: trip[0] + trip[3] });
        break;
      }
      case 'stranded': {
        counts.stranded++;
        const c = coord(e.station);
        if (c) flashes.push({ lat: c[0], lon: c[1], t0: e.t, kind: 'stranded' });
        break;
      }
      case 'arrive': {
        counts.served++;
        active.delete(e.trip);
        if (e.station >= 0) {
          inventory[e.station]++;
          dirtyStations.add(e.station);
        }
        break;
      }
      case 'full': {
        counts.full++;
        active.delete(e.trip);
        const c = coord(e.station);
        if (c) flashes.push({ lat: c[0], lon: c[1], t0: e.t, kind: 'full' });
        if (e.to >= 0) {
          inventory[e.to]++;
          dirtyStations.add(e.to);
        }
        break;
      }
      default:
    }
  }

  function frame(now) {
    if (!running) return;
    resize();
    const elapsed = Math.min(1, (now - startWall) / durationMs);
    const simT = windowStart + elapsed * simSpan;

    while (ei < events.length && events[ei].t <= simT) applyEvent(events[ei++]);
    if (dirtyStations.size) {
      for (const s of dirtyStations) mapApi.setStation(s, inventory[s]);
      dirtyStations.clear();
    }

    // HUD
    hud.clock.textContent = fmtClock(Math.min(simT, lastEnd));
    hud.served.textContent = counts.served;
    hud.stranded.textContent = counts.stranded;
    hud.full.textContent = counts.full;

    // Draw
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = 'rgba(255, 220, 120, 0.95)';
    for (const a of active.values()) {
      const p = Math.max(0, Math.min(1, (simT - a.t0) / (a.t1 - a.t0)));
      const lat = a.from[0] + (a.to[0] - a.from[0]) * p;
      const lon = a.from[1] + (a.to[1] - a.from[1]) * p;
      const pt = map.latLngToContainerPoint([lat, lon]);
      if (pt.x < -4 || pt.y < -4 || pt.x > w + 4 || pt.y > h + 4) continue;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    // Miss flashes: expanding red ring for ~1.2 s of wall time
    const flashSim = (1200 / durationMs) * simSpan;
    flashes = flashes.filter((f) => simT - f.t0 < flashSim);
    for (const f of flashes) {
      const k = (simT - f.t0) / flashSim;
      const pt = map.latLngToContainerPoint([f.lat, f.lon]);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, 6 + k * 22, 0, Math.PI * 2);
      ctx.strokeStyle = f.kind === 'stranded' ? `rgba(255, 90, 90, ${1 - k})` : `rgba(255, 140, 66, ${1 - k})`;
      ctx.lineWidth = 3 * (1 - k) + 0.5;
      ctx.stroke();
    }

    if (elapsed >= 1 && ei >= events.length) {
      finish();
      return;
    }
    raf = requestAnimationFrame(frame);
  }

  function finish() {
    running = false;
    cancelAnimationFrame(raf);
    while (ei < events.length) applyEvent(events[ei++]);
    for (const s of dirtyStations) mapApi.setStation(s, inventory[s]);
    dirtyStations.clear();
    hud.clock.textContent = fmtClock(windowEnd);
    hud.served.textContent = counts.served;
    hud.stranded.textContent = counts.stranded;
    hud.full.textContent = counts.full;
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    onDone({ ...counts, inventory });
  }

  function skip() {
    if (running) finish();
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  }

  return { start, skip, stop, isRunning: () => running };
}
