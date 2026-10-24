/**
 * Bike Drop simulator — pure functions, no DOM.
 *
 * Day pack shape (see scripts/build_day.py):
 *   {
 *     stations: [{ id, name, lat, lon, cap }],   // selected stations, index = station idx
 *     inventory: [int],                          // bikes docked at 11 PM
 *     ext: [[lat, lon]],                          // unselected endpoints, referenced as -(k+1)
 *     trips: [[startSec, originIdx, destIdx, durSec]],  // sorted by startSec
 *     vanCapacity: 20, stops: 8
 *   }
 * Any negative originIdx/destIdx means "not one of our stations" (-1 = unknown).
 *
 * A plan is an ordered list of stops: [{ station, delta }], delta > 0 drops
 * bikes off at the station, delta < 0 picks them up.
 */

const neighborCache = new WeakMap();
const compiledCache = new WeakMap();

function haversineM(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const p1 = (lat1 * Math.PI) / 180;
  const p2 = (lat2 * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

/** For each station, the other stations sorted by distance (nearest first). */
export function neighbors(day) {
  let n = neighborCache.get(day);
  if (n) return n;
  const st = day.stations;
  n = st.map((a, i) =>
    st
      .map((b, j) => [j, haversineM(a.lat, a.lon, b.lat, b.lon)])
      .filter(([j]) => j !== i)
      .sort((x, y) => x[1] - y[1])
      .map(([j]) => j),
  );
  neighborCache.set(day, n);
  return n;
}

/**
 * Flat typed-array view of a day's trips, cached per day object:
 * start/origin/dest/end per trip, plus trip indices sorted by arrival time.
 */
export function compile(day) {
  let c = compiledCache.get(day);
  if (c) return c;
  const t = day.trips;
  const n = t.length;
  const start = new Int32Array(n);
  const origin = new Int32Array(n);
  const dest = new Int32Array(n);
  const end = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    start[i] = t[i][0];
    origin[i] = t[i][1];
    dest[i] = t[i][2];
    end[i] = t[i][0] + t[i][3];
  }
  const order = Int32Array.from({ length: n }, (_, i) => i).sort((a, b) => end[a] - end[b] || a - b);
  const arrEnd = new Int32Array(n);
  for (let i = 0; i < n; i++) arrEnd[i] = end[order[i]];
  c = { n, start, origin, dest, end, order, arrEnd, cap: Int32Array.from(day.stations, (s) => s.cap) };
  compiledCache.set(day, c);
  return c;
}

export function capacities(day) {
  return day.stations.map((s) => s.cap);
}

/**
 * Clamp a requested move to what is physically possible given the station and
 * the van. Returns the feasible delta (may be 0).
 */
export function clampDelta(day, inventory, van, station, delta) {
  const cap = day.stations[station].cap;
  const vanCap = day.vanCapacity ?? 20;
  if (delta > 0) return Math.max(0, Math.min(delta, van, cap - inventory[station]));
  if (delta < 0) return -Math.max(0, Math.min(-delta, inventory[station], vanCap - van));
  return 0;
}

/**
 * Apply a plan to the starting inventory, in order. Infeasible parts of a stop
 * are clamped (and reported in `applied`). Returns the 6 AM inventory and the
 * van's final load.
 */
export function applyPlan(day, plan, startInventory = day.inventory) {
  const inventory = Int32Array.from(startInventory);
  let van = 0;
  const applied = [];
  const maxStops = day.stops ?? 8;
  for (const stop of plan.slice(0, maxStops)) {
    const d = clampDelta(day, inventory, van, stop.station, stop.delta);
    inventory[stop.station] += d;
    van -= d;
    applied.push({ station: stop.station, delta: d, requested: stop.delta });
  }
  return { inventory, van, applied };
}

/**
 * Replay the morning.
 *
 * Events are processed in time order; at equal timestamps arrivals go before
 * departures (a returning bike can be taken by the next rider).
 *  - departure from an empty station  → "stranded" miss, trip cancelled
 *  - arrival at a full station        → "full dock" miss, bike docks at the
 *                                        nearest station with space
 * With { events: true } a replay timeline is returned as well.
 */
export function simulate(day, startInventory, opts = {}) {
  const collect = !!opts.events;
  const { n: total, start, origin, dest, order, arrEnd, cap } = compile(day);
  const n = day.stations.length;
  const inv = Int32Array.from(startInventory);
  const nb = neighbors(day);
  const ok = new Uint8Array(total); // departure succeeded
  const strandedAt = new Int32Array(n);
  const fullAt = new Int32Array(n);
  const events = collect ? [] : null;
  let stranded = 0;
  let fullDock = 0;
  let served = 0;
  let redirectedDropped = 0;

  let di = 0; // departure pointer (trips sorted by start)
  let ai = 0; // arrival pointer (order sorted by end)
  const INF = 0x7fffffff;
  while (di < total || ai < total) {
    const nextDep = di < total ? start[di] : INF;
    const nextArr = ai < total ? arrEnd[ai] : INF;
    if (nextArr <= nextDep) {
      const ti = order[ai++];
      if (!ok[ti]) continue;
      const t = nextArr;
      const d = dest[ti];
      if (d < 0) {
        served++;
        if (collect) events.push({ t, type: 'arrive', trip: ti, station: d });
        continue;
      }
      if (inv[d] < cap[d]) {
        inv[d]++;
        served++;
        if (collect) events.push({ t, type: 'arrive', trip: ti, station: d });
      } else {
        fullDock++;
        fullAt[d]++;
        let to = -1;
        const nbd = nb[d];
        for (let k = 0; k < nbd.length; k++) {
          const j = nbd[k];
          if (inv[j] < cap[j]) {
            to = j;
            break;
          }
        }
        if (to >= 0) inv[to]++;
        else redirectedDropped++;
        if (collect) events.push({ t, type: 'full', trip: ti, station: d, to });
      }
    } else {
      const ti = di++;
      const o = origin[ti];
      const t = nextDep;
      if (o < 0) {
        ok[ti] = 1;
        if (collect) events.push({ t, type: 'depart', trip: ti, station: o });
        continue;
      }
      if (inv[o] > 0) {
        inv[o]--;
        ok[ti] = 1;
        if (collect) events.push({ t, type: 'depart', trip: ti, station: o });
      } else {
        stranded++;
        strandedAt[o]++;
        if (collect) events.push({ t, type: 'stranded', trip: ti, station: o });
      }
    }
  }

  return {
    stranded,
    fullDock,
    misses: stranded + fullDock,
    served,
    redirectedDropped,
    inventory: inv,
    strandedAt,
    fullAt,
    events,
  };
}

/** Misses for a plan (apply + simulate). */
export function evaluatePlan(day, plan, opts) {
  const { inventory, van, applied } = applyPlan(day, plan);
  const result = simulate(day, inventory, opts);
  return { ...result, startInventory: inventory, van, applied };
}

/** The "do nothing" result. */
export function baseline(day, opts) {
  return simulate(day, day.inventory, opts);
}

/**
 * Forecast hint per station from the do-nothing run:
 *   'drain' (riders will find it empty), 'flood' (riders will find it full),
 *   'both', or null. No numbers leak to the player.
 */
export function forecast(day) {
  const b = baseline(day);
  return day.stations.map((_, i) => {
    const d = b.strandedAt[i] > 0;
    const f = b.fullAt[i] > 0;
    return d && f ? 'both' : d ? 'drain' : f ? 'flood' : null;
  });
}

/** Seconds-from-midnight → "H:MM". */
export function fmtClock(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}
