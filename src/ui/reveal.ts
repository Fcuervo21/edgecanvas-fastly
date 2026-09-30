/**
 * When each pixel that arrived from another player becomes visible. Instead of the whole batch appearing at once,
 * pixels show one after another in the order received, spread over a short bounded time (a line looks drawn).
 * Returns index -> time; one pixel shows immediately.
 */
export function scheduleReveal(changed: number[], now: number, options: { maxSpreadMs?: number; stepMs?: number } = {}): Map<number, number> {
  const { maxSpreadMs = 400, stepMs = 12 } = options;
  const unique = [...new Set(changed)], times = new Map<number, number>();
  const spread = Math.min(maxSpreadMs, Math.max(0, unique.length - 1) * stepMs);
  unique.forEach((index, k) => times.set(index, unique.length > 1 ? now + Math.floor(k * spread / (unique.length - 1)) : now));
  return times;
}
