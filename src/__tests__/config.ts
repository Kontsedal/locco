export const TEST_CONFIG = {
  REDIS_PORT: Number(process.env.REDIS_PORT ?? 6380),
  MONGO_URL: process.env.MONGO_URL ?? 'mongodb://localhost:27018/locco-test',
  POSTGRES_URL: process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5433/postgres',
};
