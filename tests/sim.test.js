import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { applyPlan, baseline, clampDelta, evaluatePlan, forecast, fmtClock, simulate } from '../src/sim.js';

// Three stations in a row, 100 m apart. Trips: [start, origin, dest, dur].
function tinyDay(over = {}) {
  return {
    vanCapacity: 20,
    stops: 8,
    stations: [
      { id: 'a', name: 'A', lat: 40.7, lon: -74.0, cap: 4 },
      { id: 'b', name: 'B', lat: 40.701, lon: -74.0, cap: 4 },
      { id: 'c', name: 'C', lat: 40.702, lon: -74.0, cap: 4 },
    ],
    inventory: [2, 2, 2],
    ext: [[40.75, -73.99]],
    trips: [],
    ...over,
  };
}

describe('simulate', () => {
  it('serves trips and moves bikes between stations', () => {
    const day = tinyDay({ trips: [[100, 0, 1, 60]] });
    const r = simulate(day, day.inventory);
    expect(r.misses).toBe(0);
    expect(r.served).toBe(1);
    expect(Array.from(r.inventory)).toEqual([1, 3, 2]);
  });

  it('counts a departure from an empty station as stranded and cancels the trip', () => {
    const day = tinyDay({ inventory: [0, 2, 2], trips: [[100, 0, 1, 60]] });
    const r = simulate(day, day.inventory);
    expect(r.stranded).toBe(1);
    expect(r.fullDock).toBe(0);
    expect(r.served).toBe(0);
    expect(Array.from(r.inventory)).toEqual([0, 2, 2]); // bike never arrived at B
    expect(r.strandedAt[0]).toBe(1);
  });

  it('counts an arrival at a full station as a full-dock miss and redirects to the nearest station with space', () => {
    const day = tinyDay({ inventory: [2, 4, 4], trips: [[100, 0, 1, 60]] });
    const r = simulate(day, day.inventory);
    expect(r.fullDock).toBe(1);
    expect(r.fullAt[1]).toBe(1);
    // B full, C full → nearest with space from B is A.
    expect(Array.from(r.inventory)).toEqual([2, 4, 4]);
  });

  it('redirects to the nearest station that has space', () => {
    const day = tinyDay({ inventory: [2, 4, 3], trips: [[100, 0, 1, 60]] });
    day.stations[2].lat = 40.7015; // C is nearer to B than A is
    const r = simulate(day, day.inventory);
    expect(r.fullDock).toBe(1);
    expect(Array.from(r.inventory)).toEqual([1, 4, 4]); // A lost its bike, C gained it
  });

  it('processes arrivals before departures at the same instant', () => {
    // A has 1 bike. Trip X arrives at A at t=160; trip Y leaves A at t=160.
    const day = tinyDay({ inventory: [0, 2, 2], trips: [[100, 1, 0, 60], [160, 0, 2, 60]] });
    const r = simulate(day, day.inventory);
    expect(r.misses).toBe(0);
    expect(r.served).toBe(2);
  });

  it('treats negative endpoints as outside the puzzle', () => {
    const day = tinyDay({ inventory: [0, 2, 4], trips: [[100, -1, 0, 60], [100, -2, 2, 60], [200, 1, -1, 60]] });
    const r = simulate(day, day.inventory);
    expect(r.misses).toBe(1); // only the arrival at full C
    expect(r.served).toBe(2);
    expect(Array.from(r.inventory)).toEqual([1, 2, 4]); // C overflow went to B, then B's rider took it
  });

  it('returns a replay timeline whose counts match the totals', () => {
    const day = JSON.parse(fs.readFileSync('public/data/days/2026-09-30.json', 'utf8'));
    const r = baseline(day, { events: true });
    const count = (type) => r.events.filter((e) => e.type === type).length;
    expect(count('stranded')).toBe(r.stranded);
    expect(count('full')).toBe(r.fullDock);
    expect(count('arrive')).toBe(r.served);
    expect(count('depart') + count('stranded')).toBe(day.trips.length);
    for (let i = 1; i < r.events.length; i++) expect(r.events[i].t).toBeGreaterThanOrEqual(r.events[i - 1].t);
    expect(r.misses).toBeGreaterThan(0);
  });
});

describe('applyPlan / clampDelta', () => {
  it('cannot drop more than the van carries, or pick up more than is docked', () => {
    const day = tinyDay({ inventory: [1, 2, 2] });
    const { inventory, van, applied } = applyPlan(day, [
      { station: 1, delta: 5 }, // van is empty → nothing
      { station: 0, delta: -3 }, // only 1 bike there
      { station: 2, delta: 2 }, // cap 4, has 2, van has 1 → 1
    ]);
    expect(applied.map((a) => a.delta)).toEqual([0, -1, 1]);
    expect(Array.from(inventory)).toEqual([0, 2, 3]);
    expect(van).toBe(0);
  });

  it('respects van capacity and station capacity', () => {
    const day = tinyDay({ inventory: [4, 4, 0], vanCapacity: 5 });
    expect(clampDelta(day, day.inventory, 0, 0, -10)).toBe(-4);
    expect(clampDelta(day, day.inventory, 3, 1, -10)).toBe(-2);
    expect(clampDelta(day, day.inventory, 5, 2, 10)).toBe(4);
    expect(clampDelta(day, day.inventory, 0, 2, 0)).toBe(0);
  });

  it('ignores stops beyond the limit', () => {
    const day = tinyDay({ stops: 1 });
    const { applied } = applyPlan(day, [{ station: 0, delta: -1 }, { station: 1, delta: 1 }]);
    expect(applied).toHaveLength(1);
  });

  it('a good plan beats doing nothing', () => {
    const day = tinyDay({ inventory: [0, 4, 2], trips: [[100, 0, 2, 60], [110, 0, 2, 60], [120, -1, 1, 60]] });
    expect(baseline(day).misses).toBe(3);
    const r = evaluatePlan(day, [{ station: 1, delta: -2 }, { station: 0, delta: 2 }]);
    expect(r.misses).toBe(0);
  });
});

describe('forecast / helpers', () => {
  it('flags draining and flooding stations without numbers', () => {
    const day = tinyDay({ inventory: [0, 4, 2], trips: [[100, 0, 2, 60], [120, -1, 1, 60]] });
    expect(forecast(day)).toEqual(['drain', 'flood', null]);
  });
  it('formats the clock', () => {
    expect(fmtClock(6 * 3600)).toBe('6:00');
    expect(fmtClock(9 * 3600 + 5 * 60 + 59)).toBe('9:05');
  });
});
