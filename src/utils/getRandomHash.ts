import { randomBytes } from "crypto";

export const getRandomHash = () => {
  return randomBytes(16).toString("hex");
};
