import { createHash } from "crypto";

export const getSha1 = (value: string) => {
  return createHash("sha1").update(value).digest("hex");
};
