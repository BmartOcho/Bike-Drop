import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { baseline, evaluatePlan, applyPlan } from '../src/sim.js';
import { gradeOf, gradePlan, missCurves, score, shareString, solve, normalizePlan } from '../src/solver.js';

const real = JSON.parse(fs.readFileSync('public/data/days/2026-09-30.json', 'utf8'));

function tinyDay(over = {}) {
  return {
    vanCapacity: 20,
    stops: 8,
    stations: [
      { id: 'a', name: 'A', lat: 40.7, lon: -74.0, cap: 10 },
      { id: 'b', name: 'B', lat: 40.71, lon: -74.0, cap: 10 },
      { id: 'c', name: 'C', lat: 40.72, lon: -74.0, cap: 10 },
    ],
    inventory: [0, 10, 5],
    ext: [],
    trips: [],
    ...over,
  };
}

describe('score', () => {
  it('is 100 for matching the solver and 0 for doing nothing', () => {
    expect(score(100, 60, 60)).toBe(100);
    expect(score(100, 100, 60)).toBe(0);
    expect(score(100, 80, 60)).toBe(50);
  });
  it('clamps to 0..100', () => {
    expect(score(100, 50, 60)).toBe(100); // beat the solver
    expect(score(100, 120, 60)).toBe(0); // made it worse
  });
  it('handles a day the solver cannot improve', () => {
    expect(score(10, 10, 10)).toBe(100);
    expect(score(10, 12, 10)).toBe(0);
  });
});

describe('gradeOf', () => {
  it('maps the ratio of saved to best-available onto four colours', () => {
    expect(gradeOf(10, 10)).toBe('green');
    expect(gradeOf(8, 10)).toBe('green');
    expect(gradeOf(5, 10)).toBe('yellow');
    expect(gradeOf(2, 10)).toBe('orange');
    expect(gradeOf(0, 10)).toBe('red');
    expect(gradeOf(-1, 10)).toBe('red');
    expect(gradeOf(0, 0)).toBe('green');
  });
});

describe('missCurves', () => {
  it('counts misses for every possible starting inventory', () => {
    const day = tinyDay({ trips: [[100, 0, 1, 60], [110, 0, 1, 60], [120, 0, 1, 60]] });
    const c = missCurves(day);
    expect(Array.from(c[0])).toEqual([3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(Array.from(c[1])).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3]);
  });
});

describe('solve', () => {
  it('finds the obvious fix on a tiny day', () => {
    // A starts empty but 3 riders leave it; B starts full and 3 riders arrive.
    const day = tinyDay({ trips: [[100, 0, 2, 60], [110, 0, 2, 60], [120, 0, 2, 60], [130, -1, 1, 60], [140, -1, 1, 60], [150, -1, 1, 60]] });
    expect(baseline(day).misses).toBe(6);
    const r = solve(day);
    expect(r.misses).toBe(0);
    expect(r.plan.length).toBeLessThanOrEqual(8);
    expect(r.plan[0].delta).toBeLessThan(0); // van starts empty: first stop is a pickup
  });

  it('never does worse than doing nothing and respects the van on the real day', () => {
    const r = solve(real);
    const base = baseline(real).misses;
    expect(r.baseline).toBe(base);
    expect(r.misses).toBeLessThanOrEqual(base);
    expect(r.misses).toBeLessThan(base); // this day is improvable
    expect(r.plan.length).toBeLessThanOrEqual(real.stops);
    let van = 0;
    for (const s of r.plan) {
      van -= s.delta;
      expect(van).toBeGreaterThanOrEqual(0);
      expect(van).toBeLessThanOrEqual(real.vanCapacity);
    }
    // Plan is already feasible: applying it changes nothing.
    expect(normalizePlan(real, r.plan)).toEqual(r.plan);
    expect(evaluatePlan(real, r.plan).misses).toBe(r.misses);
  });

  it('is deterministic', () => {
    const a = solve(real);
    const b = solve(real);
    expect(a.plan).toEqual(b.plan);
    expect(a.misses).toBe(b.misses);
  });

  it('runs fast enough for a phone', () => {
    const r = solve(real);
    expect(r.elapsedMs).toBeLessThan(2000);
  });
});

describe('gradePlan', () => {
  it("grades the solver's own plan mostly green and a bad plan red", () => {
    const r = solve(real);
    const g = gradePlan(real, r.plan);
    expect(g).toHaveLength(r.plan.length);
    expect(g.filter((s) => s.grade === 'green').length).toBeGreaterThanOrEqual(g.length - 2);
    const bad = gradePlan(real, [{ station: 0, delta: -5 }, { station: 1, delta: 5 }]);
    expect(bad.map((s) => s.grade)).toContain('red');
  });

  it('judges a pickup by the drop it enables', () => {
    const day = tinyDay({ trips: [[100, 0, 2, 60], [110, 0, 2, 60], [120, 0, 2, 60]] });
    // Picking up from C (balanced) saves nothing by itself, but enables the drop at A.
    const g = gradePlan(day, [{ station: 2, delta: -3 }, { station: 0, delta: 3 }]);
    expect(g[0].paired).toBe(true);
    expect(g[0].saved).toBe(3);
    expect(g[0].grade).toBe('green');
    expect(g[1].grade).toBe('green');
  });

  it('player score never exceeds 100 and the solver scores 100', () => {
    const r = solve(real);
    const player = evaluatePlan(real, [{ station: 3, delta: -10 }, { station: 20, delta: 10 }]).misses;
    const s = score(r.baseline, player, r.misses);
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
    expect(score(r.baseline, r.misses, r.misses)).toBe(100);
  });
});

describe('shareString', () => {
  it('produces the Wordle-style block', () => {
    const s = shareString({ puzzleNo: 3, date: '2026-10-24', score: 72, player: 90, best: 80, baseline: 120, grades: ['green', 'red'], url: 'https://example.test' });
    expect(s).toBe('🚲 Bike Drop #3 · 2026-10-24\nScore 72/100 · 90 misses (best 80, do nothing 120)\n🟩🟥\nhttps://example.test');
  });
});

describe('day pack', () => {
  it('is well-formed and under 500 KB', () => {
    const bytes = fs.statSync('public/data/days/2026-09-30.json').size;
    expect(bytes).toBeLessThan(500_000);
    expect(real.stations.length).toBeGreaterThanOrEqual(40);
    expect(real.inventory).toHaveLength(real.stations.length);
    real.inventory.forEach((v, i) => {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(real.stations[i].cap);
    });
    for (let i = 1; i < real.trips.length; i++) expect(real.trips[i][0]).toBeGreaterThanOrEqual(real.trips[i - 1][0]);
    for (const [t, o, d, dur] of real.trips) {
      expect(t).toBeGreaterThanOrEqual(real.window.start);
      expect(t).toBeLessThan(real.window.end);
      expect(dur).toBeGreaterThan(0);
      expect(o >= 0 || d >= 0).toBe(true);
      if (o < -1) expect(real.ext[-o - 1]).toBeDefined();
      if (d < -1) expect(real.ext[-d - 1]).toBeDefined();
    }
    const sched = JSON.parse(fs.readFileSync('public/data/schedule.json', 'utf8'));
    expect(sched.days).toContain(real.date);
    for (const d of Object.values(sched.byDate)) expect(sched.days).toContain(d);
  });
});
