/** Which data day is today's puzzle, and what number it is. */
export function daysBetween(fromISO, toISO) {
  const [y1, m1, d1] = fromISO.split('-').map(Number);
  const [y2, m2, d2] = toISO.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

export function pickDay(schedule, playDate) {
  const n = daysBetween(schedule.epoch ?? playDate, playDate);
  const puzzleNo = Math.max(1, n + 1);
  const explicit = schedule.byDate?.[playDate];
  const days = schedule.days ?? [];
  const day = explicit ?? days[((n % days.length) + days.length) % days.length];
  return { day, puzzleNo };
}
