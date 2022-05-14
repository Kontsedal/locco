import { RetryError } from "../errors";
import { wait } from "./wait";

export type RetrySettings = {
  retryTimes: number;
  retryDelay?: number;
  retryDelayFn?: (params: {
    attemptNumber: number;
    startedAt: number;
  }) => number | Promise<number>;
  totalTime?: number;
};

export const retry = ({
  settings,
  fn,
  shouldProceedFn,
}: {
  settings: RetrySettings;
  fn: () => Promise<void>;
  shouldProceedFn: (err: any) => boolean;
}) => {
  let attemptNumber = -1;
  let startedAt;
  const tick = async () => {
    if (attemptNumber === -1) {
      startedAt = Date.now();
    }
    if (settings.totalTime && Date.now() - startedAt >= settings.totalTime) {
      throw new RetryError("Total time exceeded");
    }
    attemptNumber += 1;
    try {
      return await fn();
    } catch (error) {
      const shouldProceed = shouldProceedFn(error);
      if (!shouldProceed) {
        throw error;
      }
      if (settings.retryTimes <= attemptNumber + 1) {
        throw new RetryError("Reached retry times limit");
      }
      let delay;
      if (settings.retryDelayFn) {
        delay = settings.retryDelayFn({
          attemptNumber,
          startedAt,
        });
      } else {
        delay = settings.retryDelay;
      }
      await wait(delay);
      return tick();
    }
  };
  return tick();
};
