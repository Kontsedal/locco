export const TEST_CONFIG = {
  MONGO_URL: process.env.MONGO_URL || "mongodb://localhost:27018/locco-test",
  REDIS_PORT: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6380,
};
