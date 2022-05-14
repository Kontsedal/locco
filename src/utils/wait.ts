export const wait = (ms: number) => {
  return new Promise((res) => setTimeout(res, ms));
};
