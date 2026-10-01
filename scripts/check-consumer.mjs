#!/usr/bin/env node
// Installs the packed package into a scratch project, the way a consumer gets it, type-checks
// test/consumer for ESM and CommonJS, and runs the adapter contract from the published testing
// entry point.
//   npm run check:consumer -- [--typescript <version>] [--vitest <version>]
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    typescript: { type: 'string', default: 'latest' },
    vitest: { type: 'string', default: 'latest' },
  },
});
const root = path.resolve(import.meta.dirname, '..');
const work = mkdtempSync(path.join(tmpdir(), 'locco-consumer-'));

/** `npm run` hands its own CLI over in npm_execpath, which runs without a shell on every platform. */
function npm(args, cwd) {
  const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] };
  const cli = process.env.npm_execpath;
  return cli
    ? execFileSync(process.execPath, [cli, ...args], options)
    : execFileSync('npm', args, { ...options, shell: process.platform === 'win32' });
}

function installed(name) {
  return JSON.parse(readFileSync(path.join(work, 'node_modules', name, 'package.json'), 'utf8'))
    .version;
}

function node(file, args) {
  execFileSync(process.execPath, [path.join(work, 'node_modules', file), ...args], {
    cwd: work,
    stdio: 'inherit',
  });
}

try {
  npm(['run', 'build'], root);
  const [{ filename }] = JSON.parse(
    npm(['pack', '--json', '--ignore-scripts', '--pack-destination', work], root),
  );
  cpSync(path.join(root, 'test', 'consumer'), work, { recursive: true });
  npm(
    [
      'install',
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      path.join(work, filename),
      `typescript@${values.typescript}`,
      `vitest@${values.vitest}`,
      '@types/node@22',
    ],
    work,
  );
  console.log(`Type-checking with typescript@${installed('typescript')}`);
  node('typescript/bin/tsc', ['-p', work]);
  console.log(`Running the contract with vitest@${installed('vitest')}`);
  node('vitest/vitest.mjs', ['run']);
} finally {
  rmSync(work, { recursive: true, force: true });
}
