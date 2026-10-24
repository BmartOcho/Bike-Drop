/** localStorage helpers that never throw (private mode, blocked storage, …). */
const PREFIX = 'bikedrop:';

export function load(key, fallback = null) {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export function save(key, value) {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export function todayISO(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function addDays(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  return todayISO(new Date(y, m - 1, d + n));
}

/** Streak bookkeeping: call once when a puzzle is completed. */
export function recordStreak(playDate) {
  const s = load('streak', { count: 0, last: null });
  if (s.last === playDate) return s;
  const next = s.last === addDays(playDate, -1) ? { count: s.count + 1, last: playDate } : { count: 1, last: playDate };
  save('streak', next);
  return next;
}

export function currentStreak(playDate) {
  const s = load('streak', { count: 0, last: null });
  if (s.last === playDate || s.last === addDays(playDate, -1)) return s.count;
  return 0;
}
