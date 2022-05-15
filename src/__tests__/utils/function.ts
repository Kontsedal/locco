export const mapTimes = (times: number, cb: (index?: number) => unknown) =>
  new Array(times).fill(0).map((_, index) => cb(index));
