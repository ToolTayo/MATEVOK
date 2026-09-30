const ARROW_STEP = Object.freeze({ ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 });

export function nextAttendanceStatus(current, key, statuses) {
  const step = ARROW_STEP[key];
  if (!step || !Array.isArray(statuses) || statuses.length < 2) return null;
  const index = statuses.indexOf(current);
  if (index < 0) return null;
  return statuses[(index + step + statuses.length) % statuses.length];
}
