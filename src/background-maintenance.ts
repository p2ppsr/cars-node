/** A migration fence must never expire into competing lock authorities. */
export function backgroundMaintenance(value = process.env.CARS_BACKGROUND_PAUSED_UNTIL, now = Date.now()) {
  if (!value) return { paused: false, expired: false };
  const until = Date.parse(value);
  if (!Number.isFinite(until) || !value.endsWith('Z') || until > now + 4 * 60 * 60 * 1000) {
    throw new Error('CARS_BACKGROUND_PAUSED_UNTIL must be a UTC deadline within four hours');
  }
  return { paused: true, expired: until <= now, deadline: value };
}

export function backgroundWorkPaused(value = process.env.CARS_BACKGROUND_PAUSED_UNTIL, now = Date.now()): boolean {
  return backgroundMaintenance(value, now).paused;
}
