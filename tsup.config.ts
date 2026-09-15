import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    redis: 'src/redis.ts',
    'node-redis': 'src/node-redis.ts',
    mongo: 'src/mongo.ts',
    postgres: 'src/postgres.ts',
    memory: 'src/memory.ts',
    testing: 'src/testing.ts',
  },
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  // Each entry stands alone. Adapters import no runtime code from the core, so no class is duplicated.
  splitting: false,
  target: 'node22',
  platform: 'node',
  external: ['vitest'],
});
