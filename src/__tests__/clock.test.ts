import { describe, expect, it } from 'vitest';
import { createSystemClock } from '../clock';

/** Two clocks the test moves by hand: the monotonic one and the wall clock. */
function sources() {
  const time = { monotonic: 1000, wall: 1_700_000_000_000 };
  return {
    time,
    clock: createSystemClock(
      () => time.monotonic,
      () => time.wall,
    ),
  };
}

describe('createSystemClock', () => {
  it('follows the monotonic clock from zero', () => {
    const { time, clock } = sources();
    expect(clock()).toBe(0);
    time.monotonic += 250.5;
    time.wall += 250;
    expect(clock()).toBe(250.5);
  });

  it('adds a pause that only the wall clock saw', () => {
    // The machine slept for ten seconds. The monotonic clock stood still; the backend's did not.
    const { time, clock } = sources();
    time.monotonic += 100;
    time.wall += 10_100;
    expect(clock()).toBe(10_100);
    time.monotonic += 100;
    time.wall += 100;
    expect(clock()).toBe(10_200);
  });

  it('ignores a wall clock that steps backwards', () => {
    const { time, clock } = sources();
    time.monotonic += 100;
    time.wall -= 3_600_000;
    expect(clock()).toBe(100);
    time.monotonic += 100;
    time.wall += 100;
    expect(clock()).toBe(200);
  });

  it('ignores the small disagreements of rounding and slewing', () => {
    const { time, clock } = sources();
    time.monotonic += 1000.4;
    time.wall += 1030;
    expect(clock()).toBeCloseTo(1000.4, 6);
  });

  it('reads performance.now and Date.now by default', () => {
    const clock = createSystemClock();
    const first = clock();
    expect(first).toBeGreaterThanOrEqual(0);
    expect(clock()).toBeGreaterThanOrEqual(first);
  });
});
