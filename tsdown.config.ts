import { defineConfig } from 'tsdown';

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
  platform: 'node',
  target: 'node22',
  // The testing entry point imports vitest, an optional peer. It must stay a runtime import so a
  // consumer without vitest can still install the package.
  deps: { neverBundle: ['vitest'] },
  // Fail the build on a packaging mistake instead of leaving it for the publish step.
  publint: true,
});
