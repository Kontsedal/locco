import { RetryError } from "./errors";
import { wait } from "./utils/wait";

export type RetrySettings = {
  retryTimes: number;
  retryDelay: number;
  retryDelayFn: ({ attemptNumber: number }) => number | Promise<number>;
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

  const tick = async () => {
    attemptNumber += 1;
    try {
      return await fn();
    } catch (error) {
      const shouldProceed = shouldProceedFn(error);
      if (!shouldProceed || settings.retryTimes <= attemptNumber + 1) {
        throw new RetryError();
      }
      let delay;
      if (settings.retryDelayFn) {
        delay = settings.retryDelayFn({
          attemptNumber: attemptNumber,
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
