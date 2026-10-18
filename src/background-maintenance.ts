/** Bounded pause for background work; HTTP serving and durable intent remain available. */
export function backgroundWorkPaused(value = process.env.CARS_BACKGROUND_PAUSED_UNTIL, now = Date.now()): boolean {
  if (!value) return false;
  const until = Date.parse(value);
  if (!Number.isFinite(until) || !value.endsWith('Z') || until > now + 4 * 60 * 60 * 1000) {
    throw new Error('CARS_BACKGROUND_PAUSED_UNTIL must be a UTC deadline within four hours');
  }
  return until > now;
}
