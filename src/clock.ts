/** A forward jump of the wall clock this much larger than the monotonic clock's counts as a pause. */
const PAUSE_THRESHOLD_MS = 50;

/**
 * The default clock of `Locker` and `InMemoryAdapter`, in milliseconds from an arbitrary origin.
 *
 * `performance.now()` never steps backwards, but it can stand still while the machine sleeps or a
 * virtual machine is paused, and the backend's clock keeps running through that. `Date.now()`
 * keeps running through a pause but can step either way. This clock follows the monotonic one and
 * adds every forward jump of the wall clock that the monotonic clock did not see, so neither
 * failure can make a lease look longer than it is. A wall clock that steps backwards is ignored.
 */
export function createSystemClock(
  monotonic: () => number = () => performance.now(),
  wall: () => number = () => Date.now(),
): () => number {
  const origin = monotonic();
  let lastMonotonic = origin;
  let lastWall = wall();
  let paused = 0;
  return () => {
    const nowMonotonic = monotonic();
    const nowWall = wall();
    const gap = nowWall - lastWall - (nowMonotonic - lastMonotonic);
    // Below the threshold the two clocks only disagree on rounding and on NTP slewing.
    if (gap > PAUSE_THRESHOLD_MS) {
      paused += gap;
    }
    lastMonotonic = nowMonotonic;
    lastWall = nowWall;
    return nowMonotonic - origin + paused;
  };
}
