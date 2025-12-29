export function normalizeDelays(expected: number[], received: number[]) {
  const result: number[] = [];
  received.forEach((delay, index) => {
    const expectedDelay = expected[index];
    if (typeof expectedDelay !== "number") {
      result.push(delay);
      return;
    }
    result.push(normalizeDelay(expectedDelay, delay));
  });
  return result;
}

export function normalizeDelay(expected: number, received: number) {
  const maxDiff = 30;
  return received >= expected && received - maxDiff <= expected
    ? expected
    : received;
}
