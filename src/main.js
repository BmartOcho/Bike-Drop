import './style.css';
import { applyPlan, baseline, clampDelta, evaluatePlan, forecast as forecastOf } from './sim.js';
import { GRADE_EMOJI, gradePlan, score as scoreOf, shareString, solve } from './solver.js';
import { createMap } from './map.js';
import { createReplay } from './replay.js';
import { currentStreak, load, recordStreak, save, todayISO } from './storage.js';
import { pickDay } from './schedule.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const BASE = import.meta.env.BASE_URL || '/';

/* ------------------------------------------------------------------ */
/* solver in a worker (inline fallback)                                */
/* ------------------------------------------------------------------ */
let worker = null;
let reqId = 0;
const pending = new Map();
try {
  worker = new Worker(new URL('./solver.worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = (e) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    e.data.ok ? p.resolve(e.data.result) : p.reject(new Error(e.data.error));
  };
  worker.onerror = () => {
    worker = null;
    for (const [, p] of pending) p.reject(new Error('worker failed'));
    pending.clear();
  };
} catch {
  worker = null;
}
function callSolver(cmd, day, plan) {
  if (!worker) return Promise.resolve(cmd === 'solve' ? solve(day) : gradePlan(day, plan));
  return new Promise((resolve, reject) => {
    const id = ++reqId;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, cmd, day, plan });
  }).catch(() => (cmd === 'solve' ? solve(day) : gradePlan(day, plan)));
}

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */
const state = {
  day: null,
  playDate: params.get('date') || todayISO(),
  puzzleNo: 1,
  plan: [],
  selected: null,
  pendingDelta: 0,
  phase: 'plan',
  solverPromise: null,
  solver: null,
  base: null,
  result: null,
};

let mapApi = null;
let replay = null;

function currentInventory() {
  return applyPlan(state.day, state.plan);
}

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._h);
  toast._h = setTimeout(() => t.classList.add('hidden'), 1800);
}

function show(view) {
  for (const v of ['view-plan', 'view-station', 'view-replay']) $(v).classList.toggle('hidden', v !== view);
}

/* ------------------------------------------------------------------ */
/* header + plan list                                                  */
/* ------------------------------------------------------------------ */
function renderHeader() {
  const { van } = currentInventory();
  $('van-load').textContent = van;
  $('van-cap').textContent = state.day.vanCapacity;
  $('stops-left').textContent = state.day.stops - state.plan.length;
}

function renderPlan() {
  const list = $('plan-list');
  list.innerHTML = '';
  if (!state.plan.length) {
    list.innerHTML = '<span class="muted">Tap a station to plan your first stop.</span>';
  } else {
    state.plan.forEach((s, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      const st = state.day.stations[s.station];
      chip.innerHTML = `<b>${i + 1}</b><span class="${s.delta < 0 ? 'pick' : 'drop'}">${s.delta < 0 ? '−' : '+'}${Math.abs(s.delta)}</span> ${shortName(st.name)}`;
      list.appendChild(chip);
    });
    list.scrollLeft = list.scrollWidth;
  }
  $('undo-btn').disabled = !state.plan.length;
  mapApi.setPlan(state.plan);
  mapApi.setInventory(currentInventory().inventory);
  renderHeader();
}

function shortName(name) {
  return name.replace(/ & /g, ' & ').replace(/\bStreet\b/g, 'St').replace(/\bAvenue\b/g, 'Ave');
}

/* ------------------------------------------------------------------ */
/* station sheet                                                       */
/* ------------------------------------------------------------------ */
function selectStation(i) {
  if (state.phase !== 'plan') return;
  if (state.plan.length >= state.day.stops) {
    toast('No stops left — undo one or run the morning');
    return;
  }
  state.selected = i;
  state.pendingDelta = 0;
  mapApi.setSelected(i);
  renderStation();
  show('view-station');
}

function closeStation() {
  state.selected = null;
  mapApi.setSelected(null);
  show('view-plan');
}

function renderStation() {
  const i = state.selected;
  const st = state.day.stations[i];
  const { inventory, van } = currentInventory();
  const inv = inventory[i];
  const d = state.pendingDelta;
  $('st-name').textContent = st.name;
  $('st-meta').textContent = `${inv} of ${st.cap} docks have bikes · van has ${van}`;
  const f = state.forecast[i];
  $('st-hint').innerHTML =
    f === 'drain' ? '<b class="drain">▼</b> Likely to run dry by morning' : f === 'flood' ? '<b class="flood">▲</b> Likely to fill up by morning' : f === 'both' ? '<b class="drain">▼</b><b class="flood">▲</b> Runs dry, then fills up' : '<span class="muted">Looks balanced for the morning</span>';
  const after = inv + d;
  $('st-gauge').style.width = `${(Math.min(inv, after) / st.cap) * 100}%`;
  const gd = $('st-gauge-delta');
  gd.style.left = `${(Math.min(inv, after) / st.cap) * 100}%`;
  gd.style.width = `${(Math.abs(d) / st.cap) * 100}%`;
  $('st-delta').textContent = d > 0 ? `+${d}` : d < 0 ? `−${-d}` : '0';
  $('st-delta-label').textContent = d > 0 ? `drop off → ${after} bikes` : d < 0 ? `pick up → ${after} bikes` : 'no change';
  $('st-minus').disabled = clampDelta(state.day, inventory, van, i, d - 1) === d;
  $('st-plus').disabled = clampDelta(state.day, inventory, van, i, d + 1) === d;
  $('st-take-all').disabled = clampDelta(state.day, inventory, van, i, -999) === 0;
  $('st-drop-all').disabled = clampDelta(state.day, inventory, van, i, 999) === 0;
  $('st-confirm').disabled = d === 0;
  $('st-confirm').textContent = d === 0 ? 'Add stop' : d > 0 ? `Drop off ${d} here` : `Pick up ${-d} here`;
}

function nudge(dd) {
  const { inventory, van } = currentInventory();
  state.pendingDelta = clampDelta(state.day, inventory, van, state.selected, state.pendingDelta + dd);
  renderStation();
}

function confirmStop() {
  if (!state.pendingDelta) return;
  state.plan.push({ station: state.selected, delta: state.pendingDelta });
  closeStation();
  renderPlan();
}

function undo() {
  state.plan.pop();
  renderPlan();
}

/* ------------------------------------------------------------------ */
/* run + results                                                       */
/* ------------------------------------------------------------------ */
async function runMorning(planOverride) {
  if (state.phase === 'replay') return;
  if (planOverride) state.plan = planOverride;
  closeStation();
  state.phase = 'replay';
  show('view-replay');
  $('hud').classList.remove('hidden');
  mapApi.setHintsVisible(false);
  $('replay-status').textContent = 'Replaying the real morning…';
  state.result = evaluatePlan(state.day, state.plan, { events: true });
  replay.start(state.result);
}

async function onReplayDone(counts) {
  const r = state.result;
  // The replay is driven by the simulator's own event list; these must agree.
  if (counts.served !== r.served || counts.stranded !== r.stranded || counts.full !== r.fullDock) {
    console.error('replay/simulator mismatch', counts, r);
  }
  $('replay-status').textContent = 'Checking against the best plan…';
  const [solver, grades] = await Promise.all([state.solverPromise, callSolver('grade', state.day, state.plan)]);
  state.solver = solver;
  const sc = scoreOf(state.base.misses, r.misses, solver.misses);
  const saved = { score: sc, misses: r.misses, stranded: r.stranded, fullDock: r.fullDock, grades: grades.map((g) => g.grade), plan: state.plan, best: solver.misses, baseline: state.base.misses };
  save(`result:${state.playDate}`, saved);
  const streak = recordStreak(state.playDate);
  state.phase = 'results';
  showResults(saved, grades, streak.count);
}

function showResults(saved, grades, streak) {
  const day = state.day;
  $('res-score').textContent = saved.score;
  $('res-sub').textContent = saved.score >= 100 ? 'You matched (or beat) our solver!' : saved.score >= 70 ? 'Solid night shift.' : saved.score > 0 ? 'The morning rush had other ideas.' : 'Rough morning out there.';
  $('res-you').textContent = saved.misses;
  $('res-best').textContent = saved.best;
  $('res-none').textContent = saved.baseline;
  $('res-breakdown').textContent = `Your morning: ${saved.stranded} stranded riders, ${saved.fullDock} full-dock misses. Misses are riders who found no bike, or no free dock.`;
  const gl = $('res-grades');
  gl.innerHTML = '';
  if (!saved.plan.length) gl.innerHTML = '<li><span class="muted">You made no stops. The morning ran exactly as it really did.</span></li>';
  saved.plan.forEach((s, i) => {
    const g = grades?.[i];
    const grade = g?.grade ?? saved.grades[i];
    const li = document.createElement('li');
    const st = day.stations[s.station];
    const why = g
      ? g.saved === g.bestSaved
        ? `saved ${g.saved}${g.paired ? ' with the next drop' : ''} — the best move available`
        : `saved ${g.saved}${g.paired ? ' with the next drop' : ''}, best available was ${g.bestSaved}`
      : '';
    li.innerHTML = `<span class="sq ${grade}"></span><div><div>${i + 1}. ${s.delta < 0 ? 'Pick up' : 'Drop off'} ${Math.abs(s.delta)} at ${st.name}</div><div class="why">${why}</div></div>`;
    gl.appendChild(li);
  });
  const bp = $('res-best-plan');
  bp.innerHTML = '';
  (state.solver?.plan ?? []).forEach((s) => {
    const li = document.createElement('li');
    li.textContent = `${s.delta < 0 ? 'Pick up' : 'Drop off'} ${Math.abs(s.delta)} at ${day.stations[s.station].name}`;
    bp.appendChild(li);
  });
  $('res-streak').textContent = streak > 1 ? `🔥 ${streak}-day streak` : streak === 1 ? 'Come back tomorrow to start a streak.' : '';
  const text = shareString({ puzzleNo: state.puzzleNo, date: state.playDate, score: saved.score, player: saved.misses, best: saved.best, baseline: saved.baseline, grades: saved.grades, url: shareUrl() });
  $('share-preview').textContent = text;
  $('share-btn').onclick = () => copy(text);
  $('results').classList.remove('hidden');
}

function shareUrl() {
  return `${location.origin}${location.pathname}`.replace(/\/$/, '');
}

async function copy(text) {
  try {
    if (navigator.share && /Mobi|Android/i.test(navigator.userAgent)) {
      await navigator.share({ text });
      return;
    }
  } catch {
    /* fall through to clipboard */
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      toast('Copied to clipboard');
    } catch {
      toast('Copy failed — select the text below');
    }
  }
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
async function boot() {
  const schedule = await (await fetch(`${BASE}data/schedule.json`)).json();
  const forced = params.get('day');
  const { day: dayId, puzzleNo } = pickDay(schedule, state.playDate);
  const id = forced || dayId;
  state.puzzleNo = puzzleNo;
  const day = await (await fetch(`${BASE}data/days/${id}.json`)).json();
  state.day = day;
  state.base = baseline(day);
  state.forecast = forecastOf(day);
  state.solverPromise = callSolver('solve', day);

  const d = new Date(`${day.date}T12:00:00`);
  $('puzzle-label').textContent = `#${puzzleNo} · a real ${d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}`;

  mapApi = createMap($('map'), day, { forecast: state.forecast, onSelect: selectStation });
  replay = createReplay({
    day,
    canvas: $('replay-canvas'),
    mapApi,
    hud: { clock: $('hud-clock'), served: $('hud-served'), stranded: $('hud-stranded'), full: $('hud-full') },
    durationMs: Number(params.get('speed')) || 60000,
    onDone: onReplayDone,
  });
  renderPlan();

  // wire up
  $('st-close').onclick = closeStation;
  $('st-minus').onclick = () => nudge(-1);
  $('st-plus').onclick = () => nudge(1);
  $('st-take-all').onclick = () => nudge(-999);
  $('st-drop-all').onclick = () => nudge(999);
  $('st-reset').onclick = () => {
    state.pendingDelta = 0;
    renderStation();
  };
  $('st-confirm').onclick = confirmStop;
  $('undo-btn').onclick = undo;
  $('run-btn').onclick = () => runMorning();
  $('skip-btn').onclick = () => replay.skip();
  $('help-btn').onclick = () => $('help').classList.remove('hidden');
  $('help-close').onclick = () => {
    $('help').classList.add('hidden');
    save('seenHelp', true);
  };
  $('replay-again-btn').onclick = () => {
    $('results').classList.add('hidden');
    state.phase = 'plan';
    runMorning(state.plan);
  };
  $('results').addEventListener('click', (e) => {
    if (e.target === $('results')) $('results').classList.add('hidden');
  });
  $('help').addEventListener('click', (e) => {
    if (e.target === $('help')) $('help-close').onclick();
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      $('help').classList.add('hidden');
      if (state.phase === 'results') $('results').classList.add('hidden');
    }
  });

  // Returning player: show today's result straight away.
  const prior = load(`result:${state.playDate}`);
  if (prior && !params.get('replay')) {
    state.plan = prior.plan || [];
    renderPlan();
    state.phase = 'results';
    state.solver = await state.solverPromise;
    const grades = await callSolver('grade', day, state.plan);
    showResults(prior, grades, currentStreak(state.playDate));
    $('replay-again-btn').textContent = 'Watch the replay';
  } else if (!load('seenHelp')) {
    $('help').classList.remove('hidden');
  }

  // expose for debugging / automated play-through
  window.__bikedrop = { state, runMorning, selectStation, get solver() { return state.solver; } };
}

boot().catch((err) => {
  console.error(err);
  $('puzzle-label').textContent = 'Failed to load today’s puzzle';
  $('plan-list').innerHTML = `<span class="muted">Something went wrong loading the data (${err.message}). Try refreshing.</span>`;
});
