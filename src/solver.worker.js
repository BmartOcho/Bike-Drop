import { gradePlan, solve } from './solver.js';

self.onmessage = (e) => {
  const { id, cmd, day, plan } = e.data;
  try {
    if (cmd === 'solve') {
      const r = solve(day);
      self.postMessage({ id, ok: true, result: r });
    } else if (cmd === 'grade') {
      self.postMessage({ id, ok: true, result: gradePlan(day, plan) });
    } else {
      self.postMessage({ id, ok: false, error: `unknown command ${cmd}` });
    }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.stack ? err.stack : err) });
  }
};
