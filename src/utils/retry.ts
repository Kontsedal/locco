import { RetryError } from "../errors";
import { wait } from "./wait";
import * as validators from "./validators";

export type RetrySettings = {
  retryTimes?: number;
  retryDelay?: number;
  retryDelayFn?: (params: {
    attemptNumber: number;
    startedAt: number;
    previousDelay: number;
    settings: RetrySettings;
    stop: () => void;
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
  validators.validateRetrySettings(settings);
  let attemptNumber = -1;
  const startedAt = Date.now();
  const tick = async (previousDelay = 0) => {
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
      if (
        !validators.isUndefined(settings.retryTimes) &&
        settings.retryTimes <= attemptNumber + 1
      ) {
        throw new RetryError("Reached retry times limit");
      }
      let delay;
      if (settings.retryDelayFn) {
        delay = settings.retryDelayFn({
          attemptNumber,
          startedAt,
          settings,
          previousDelay,
          stop: () => {
            throw new RetryError("Was manually stopped");
          },
        });
      } else {
        delay = settings.retryDelay;
      }
      await wait(delay);
      return tick(delay);
    }
  };
  return tick();
};
