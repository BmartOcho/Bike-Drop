/**
 * Bike Drop solver + scoring. Pure functions; run inside a Web Worker in the
 * app (see solver.worker.js) and directly in tests.
 *
 * Strategy
 *  1. Cheap estimate: each station is simulated on its own (ignoring
 *     redirects / cancelled trips) to get a "miss curve" — misses as a
 *     function of starting inventory. This ranks candidate moves instantly.
 *  2. Exact check: the top candidates are re-scored with the full simulator.
 *  3. Greedy with a 2-step lookahead: at each stop choose the move (or the
 *     pickup→drop pair) that removes the most misses, respecting van load.
 *  4. Local search: nudge each stop's amount, swap stations, drop useless
 *     stops, append new ones, keep anything that reduces misses. The search is
 *     a fixed amount of work so every player sees the same "best" plan.
 */
import { applyPlan, clampDelta, compile, simulate } from './sim.js';

const curveCache = new WeakMap();

export const DEFAULTS = {
  shortlist: 10, // exact sims per ranking
  pairPickups: 5, // pickups tried in pickup→drop pairs
  pairDrops: 6, // drops tried for each pickup
  passes: 3, // local-search passes
};

/* ------------------------------------------------------------------ */
/* estimates                                                           */
/* ------------------------------------------------------------------ */

/** Per-station miss curves from an independent single-station replay. */
export function missCurves(day) {
  let curves = curveCache.get(day);
  if (curves) return curves;
  const { n, start, origin, dest, end } = compile(day);
  const ns = day.stations.length;
  const seqs = Array.from({ length: ns }, () => []);
  for (let i = 0; i < n; i++) {
    if (origin[i] >= 0) seqs[origin[i]].push([start[i], -1]);
    if (dest[i] >= 0) seqs[dest[i]].push([end[i], 1]);
  }
  curves = seqs.map((seq, s) => {
    seq.sort((a, b) => a[0] - b[0] || b[1] - a[1]); // arrivals first on ties
    const cap = day.stations[s].cap;
    const curve = new Int32Array(cap + 1);
    for (let v = 0; v <= cap; v++) {
      let inv = v;
      let miss = 0;
      for (let k = 0; k < seq.length; k++) {
        if (seq[k][1] < 0) {
          if (inv > 0) inv--;
          else miss++;
        } else if (inv < cap) inv++;
        else miss++;
      }
      curve[v] = miss;
    }
    return curve;
  });
  curveCache.set(day, curves);
  return curves;
}

/**
 * Candidate moves ranked by the cheap estimate. Keeps the best two amounts
 * per direction per station so one hot station can't crowd out the rest.
 */
export function estimateMoves(day, state, { dropsOnly = false, pickupsOnly = false } = {}) {
  const curves = missCurves(day);
  const vanCap = day.vanCapacity ?? 20;
  const { inventory, van } = state;
  const out = [];
  for (let s = 0; s < day.stations.length; s++) {
    const cap = day.stations[s].cap;
    const inv = inventory[s];
    const base = curves[s][inv];
    if (!dropsOnly) {
      const maxPick = Math.min(inv, vanCap - van);
      const best = [];
      for (let k = 1; k <= maxPick; k++) best.push({ station: s, delta: -k, est: base - curves[s][inv - k] });
      best.sort((a, b) => b.est - a.est || a.delta - b.delta);
      out.push(...best.slice(0, 2));
    }
    if (!pickupsOnly) {
      const maxDrop = Math.min(van, cap - inv);
      const best = [];
      for (let k = 1; k <= maxDrop; k++) best.push({ station: s, delta: k, est: base - curves[s][inv + k] });
      best.sort((a, b) => b.est - a.est || b.delta - a.delta);
      out.push(...best.slice(0, 2));
    }
  }
  out.sort((a, b) => b.est - a.est || Math.abs(b.delta) - Math.abs(a.delta) || a.station - b.station);
  return out;
}

/* ------------------------------------------------------------------ */
/* exact evaluation                                                    */
/* ------------------------------------------------------------------ */

export function missesOf(day, inventory) {
  return simulate(day, inventory).misses;
}

export function applyMove(day, state, move) {
  const inventory = Int32Array.from(state.inventory);
  const delta = clampDelta(day, inventory, state.van, move.station, move.delta);
  inventory[move.station] += delta;
  return { inventory, van: state.van - delta, delta };
}

/**
 * Exact ranking of the shortlisted moves from `state`. `curMisses` is the
 * misses of `state` itself. Returns [{ station, delta, saved, misses }] sorted
 * by saved (desc).
 */
export function rankMoves(day, state, curMisses, opts = {}) {
  const k = opts.k ?? DEFAULTS.shortlist;
  const cands = estimateMoves(day, state, opts).slice(0, k);
  const ranked = cands.map((m) => {
    const next = applyMove(day, state, m);
    const misses = missesOf(day, next.inventory);
    return { station: m.station, delta: next.delta, saved: curMisses - misses, misses };
  });
  ranked.sort((a, b) => b.saved - a.saved || Math.abs(a.delta) - Math.abs(b.delta) || a.station - b.station);
  return ranked;
}

/**
 * Best thing to do with the next one or two stops from `state`:
 *   { moves: [m] | [m1, m2], saved } — the first move alone is the single-stop
 *   recommendation; the total is used to compare pickups fairly, since a
 *   pickup is often only valuable for the drop it enables.
 */
export function bestTwoStep(day, state, curMisses, stopsLeft, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const singles = rankMoves(day, state, curMisses, { k: o.shortlist });
  let best = { moves: [], saved: 0, single: null };
  const top = singles[0];
  if (top && top.saved > 0) best = { moves: [top], saved: top.saved, single: top };
  if (stopsLeft < 2) return best;

  // A: best single, then its best follow-up.
  if (top && top.saved > 0) {
    const s2 = applyMove(day, state, top);
    const follow = rankMoves(day, s2, top.misses, { k: o.shortlist })[0];
    if (follow && follow.saved > 0) {
      best = { moves: [top, follow], saved: top.saved + follow.saved, single: top };
    }
  }
  // B: pickup → drop pairs (pickups include ones that save nothing on their own).
  const pickups = [
    ...singles.filter((m) => m.delta < 0),
    ...rankMoves(day, state, curMisses, { k: o.pairPickups, pickupsOnly: true }),
  ];
  const seen = new Set();
  let tried = 0;
  for (const p of pickups) {
    const key = `${p.station}:${p.delta}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (tried++ >= o.pairPickups) break;
    const s2 = applyMove(day, state, p);
    const drop = rankMoves(day, s2, p.misses, { k: o.pairDrops, dropsOnly: true })[0];
    if (!drop) continue;
    const total = p.saved + drop.saved;
    if (total > best.saved) best = { moves: [p, drop], saved: total, single: p };
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* planning                                                            */
/* ------------------------------------------------------------------ */

export function initialState(day) {
  return { inventory: Int32Array.from(day.inventory), van: 0 };
}

export function greedyPlan(day, opts = {}) {
  const maxStops = day.stops ?? 8;
  let state = initialState(day);
  let cur = missesOf(day, state.inventory);
  const plan = [];
  while (plan.length < maxStops) {
    const best = bestTwoStep(day, state, cur, maxStops - plan.length, opts);
    if (!best.moves.length || best.saved <= 0) break;
    for (const m of best.moves) {
      if (plan.length >= maxStops) break;
      const next = applyMove(day, state, m);
      if (next.delta === 0) break;
      plan.push({ station: m.station, delta: next.delta });
      state = next;
      cur = m.misses;
    }
  }
  return { plan, misses: cur };
}

/** Re-apply with clamping and drop no-op stops. */
export function normalizePlan(day, plan) {
  const { applied } = applyPlan(day, plan);
  return applied.filter((s) => s.delta !== 0).map(({ station, delta }) => ({ station, delta }));
}

export function planMisses(day, plan) {
  return missesOf(day, applyPlan(day, plan).inventory);
}

export function localSearch(day, startPlan, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const maxStops = day.stops ?? 8;
  let plan = normalizePlan(day, startPlan);
  let cur = planMisses(day, plan);
  const nudges = [-5, -3, -2, -1, 1, 2, 3, 5];

  const tryPlan = (cand) => {
    const norm = normalizePlan(day, cand);
    const m = planMisses(day, norm);
    if (m < cur || (m === cur && norm.length < plan.length)) {
      plan = norm;
      cur = m;
      return true;
    }
    return false;
  };

  for (let pass = 0; pass < o.passes; pass++) {
    let improved = false;
    for (let i = 0; i < plan.length; i++) {
      // Nudge the amount.
      for (const dd of nudges) {
        const d = plan[i].delta + dd;
        if (d === 0 || Math.sign(d) !== Math.sign(plan[i].delta)) continue;
        const cand = plan.map((s, j) => (j === i ? { station: s.station, delta: d } : s));
        if (tryPlan(cand)) improved = true;
      }
      // Swap the station (same direction) for an estimated-good alternative.
      const before = applyPlan(day, plan.slice(0, i));
      const state = { inventory: before.inventory, van: before.van };
      const alts = estimateMoves(day, state, plan[i].delta > 0 ? { dropsOnly: true } : { pickupsOnly: true }).slice(0, 6);
      for (const a of alts) {
        if (a.station === plan[i].station) continue;
        const cand = plan.map((s, j) => (j === i ? { station: a.station, delta: a.delta } : s));
        if (tryPlan(cand)) improved = true;
      }
      // Drop the stop entirely if it isn't earning its keep.
      if (tryPlan(plan.filter((_, j) => j !== i))) {
        improved = true;
        i--;
      }
    }
    // Fill free stops greedily.
    while (plan.length < maxStops) {
      const after = applyPlan(day, plan);
      const state = { inventory: after.inventory, van: after.van };
      const best = bestTwoStep(day, state, cur, maxStops - plan.length, o);
      if (!best.moves.length || best.saved <= 0) break;
      const cand = [...plan, ...best.moves.map(({ station, delta }) => ({ station, delta }))];
      if (!tryPlan(cand)) break;
      improved = true;
    }
    if (!improved) break;
  }
  return { plan, misses: cur };
}

/** Full solve: greedy + local search. Deterministic for a given day. */
export function solve(day, opts = {}) {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const base = missesOf(day, day.inventory);
  const g = greedyPlan(day, opts);
  const ls = localSearch(day, g.plan, opts);
  const best = ls.misses <= g.misses ? ls : g;
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return { plan: best.plan, misses: best.misses, greedyMisses: g.misses, baseline: base, elapsedMs: t1 - t0 };
}

/* ------------------------------------------------------------------ */
/* scoring                                                             */
/* ------------------------------------------------------------------ */

/** 0–100: share of the solver's improvement over do-nothing that the player captured. */
export function score(baselineMisses, playerMisses, solverMisses) {
  const denom = baselineMisses - solverMisses;
  if (denom <= 0) return playerMisses <= baselineMisses ? 100 : 0;
  const s = Math.round((100 * (baselineMisses - playerMisses)) / denom);
  return Math.max(0, Math.min(100, s));
}

export const GRADES = ['green', 'yellow', 'orange', 'red'];
export const GRADE_EMOJI = { green: '🟩', yellow: '🟨', orange: '🟧', red: '🟥' };

export function gradeOf(saved, bestSaved) {
  if (saved < 0) return 'red';
  if (bestSaved <= 0) return 'green'; // nothing better was available
  const r = saved / bestSaved;
  if (r >= 0.75) return 'green';
  if (r >= 0.4) return 'yellow';
  if (r > 0) return 'orange';
  return 'red';
}

/**
 * Grade each stop of a player's plan against the best move available at that
 * point. A pickup followed by a drop is judged on the pair (its value is the
 * drop it enables); everything else on its own marginal misses saved.
 */
export function gradePlan(day, plan, opts = {}) {
  const norm = normalizePlan(day, plan);
  let state = initialState(day);
  let cur = missesOf(day, state.inventory);
  const out = [];
  for (let i = 0; i < norm.length; i++) {
    const stop = norm[i];
    const next = applyMove(day, state, stop);
    const nextMisses = missesOf(day, next.inventory);
    let saved = cur - nextMisses;
    let bestSaved;
    const pairWithNext = stop.delta < 0 && i + 1 < norm.length && norm[i + 1].delta > 0;
    if (pairWithNext) {
      const after2 = applyMove(day, next, norm[i + 1]);
      saved += nextMisses - missesOf(day, after2.inventory);
      bestSaved = bestTwoStep(day, state, cur, 2, opts).saved;
    } else {
      const best = rankMoves(day, state, cur, opts)[0];
      bestSaved = best ? Math.max(0, best.saved) : 0;
    }
    out.push({ ...stop, saved, bestSaved, grade: gradeOf(saved, bestSaved), paired: pairWithNext });
    state = next;
    cur = nextMisses;
  }
  return out;
}

export function shareString({ puzzleNo, date, score: sc, player, best, baseline: base, grades, url }) {
  const squares = grades.map((g) => GRADE_EMOJI[g.grade ?? g]).join('') || '⬜';
  return [
    `🚲 Bike Drop #${puzzleNo} · ${date}`,
    `Score ${sc}/100 · ${player} misses (best ${best}, do nothing ${base})`,
    squares,
    url,
  ]
    .filter(Boolean)
    .join('\n');
}
