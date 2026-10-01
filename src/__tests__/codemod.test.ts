import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/codemod-v1-to-v2.mjs');
const repoTypeScript = path.resolve('node_modules/typescript');

/** PATH without any `node_modules/.bin`, so only the TypeScript a test sets up can be found. */
function cleanPath(): string {
  return (process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((entry) => !/node_modules[\\/]\.bin/.test(entry))
    .join(path.delimiter);
}

function codemod(args: string[], cwd: string, PATH = cleanPath()) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, PATH },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A project directory with the given files, and no TypeScript of its own. */
function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'locco-codemod-project-'));
  writeFileSync(path.join(dir, 'package.json'), '{"name":"probe","version":"1.0.0"}');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

const V1_CALL = "const a = await locker.lock('k', 100).acquire();";
const V2_CALL = "const a = await locker.acquire('k', { ttl: 100 });";

function run(source: string, write = false): { output: string; report: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'locco-codemod-'));
  const file = path.join(dir, 'sample.ts');
  writeFileSync(file, source);
  const report = execFileSync(process.execPath, [script, ...(write ? ['--write'] : []), file], {
    encoding: 'utf8',
  });
  return { output: readFileSync(file, 'utf8'), report };
}

/** A project whose own `typescript` is TypeScript 7, which has no classic syntax API. */
function projectOnTypeScript7(): string {
  return project({
    'node_modules/typescript/package.json':
      '{"name":"typescript","version":"7.0.2","main":"index.js"}',
    'node_modules/typescript/index.js': 'module.exports = { version: "7.0.2" };',
    'sample.ts': V1_CALL,
  });
}

describe('locco-migrate-v2', () => {
  it('rewrites the literal 1.x call shape and subtracts one from retryTimes', () => {
    const source = [
      'const a = await locker.lock(`o:${id}`, TTL).setRetrySettings({ retryTimes: 60, retryDelay: 1000 }).acquire();',
      'const b = await locker.lock(key, 30000).setRetrySettings({ retryTimes: 0, retryDelay: 0 }).acquire();',
      'const c = await getLocker().lock(key, 30000).acquire();',
      'const d = await locker.lock(key, 1000).setRetrySettings({ retryTimes: 3, retryDelay: 10, totalTime: 5000 }).acquire();',
    ].join('\n');
    const { output, report } = run(source, true);
    expect(output.split('\n')).toEqual([
      'const a = await locker.acquire(`o:${id}`, { ttl: TTL, retry: { retries: 59, delay: 1000 } });',
      'const b = await locker.acquire(key, { ttl: 30000, retry: { retries: 0 } });',
      'const c = await getLocker().acquire(key, { ttl: 30000 });',
      'const d = await locker.acquire(key, { ttl: 1000, retry: { retries: 2, delay: 10, timeout: 5000 } });',
    ]);
    expect(report).toContain('4 site(s) rewritten');
  });

  it('leaves strings, comments, regular expressions and templates alone', () => {
    const source = [
      'const s = "keep .lock(x, 1).acquire() here";',
      '// locker.lock(k, 1).acquire() in a comment',
      '/* locker.lock(k, 1).acquire() in a block comment */',
      'const r = /x.lock\\(key, 100\\).acquire\\(\\)/;',
      'const t = `${"a.lock(k, 1).acquire()"} text`;',
    ].join('\n');
    const { output, report } = run(source, true);
    expect(output).toBe(source);
    expect(report).toContain('0 site(s) rewritten');
  });

  it('explains itself when the project TypeScript has no classic syntax API', () => {
    // TypeScript 7 ships the native compiler and exposes none of createSourceFile, ScriptTarget
    // or the type guards. The codemod loads the project's own TypeScript, so a consumer on 7
    // would otherwise get a TypeError from inside a tree walk.
    const { status, stderr } = codemod(['sample.ts'], projectOnTypeScript7());
    expect(status).toBe(2);
    expect(stderr).toContain('classic TypeScript syntax API');
    expect(stderr).toContain('typescript@7.0.2');
    expect(stderr).toContain('npx --package typescript@5');
    expect(stderr).not.toContain('TypeError');
  });

  it('falls back to a TypeScript that npx put on the PATH', () => {
    // `npx --package typescript@5 -- locco-migrate-v2` installs TypeScript 5 outside the
    // project and puts its `.bin` on the PATH. The project's own 7 must not shadow it.
    const dir = projectOnTypeScript7();
    const PATH = [path.resolve('node_modules/.bin'), cleanPath()].join(path.delimiter);
    const { status, stdout } = codemod(['--write', 'sample.ts'], dir, PATH);
    expect(status).toBe(0);
    expect(stdout).toContain('1 site(s) rewritten');
    expect(readFileSync(path.join(dir, 'sample.ts'), 'utf8')).toBe(V2_CALL);
  });

  it('uses the TypeScript that --typescript names', () => {
    const dir = projectOnTypeScript7();
    expect(codemod(['--typescript', repoTypeScript, 'sample.ts'], dir).status).toBe(0);
    expect(codemod([`--typescript=${repoTypeScript}`, 'sample.ts'], dir).status).toBe(0);
    const wrong = codemod(['--typescript', path.join(dir, 'missing'), 'sample.ts'], dir);
    expect(wrong.status).toBe(2);
    expect(wrong.stderr).toContain('is not a TypeScript package');
    expect(codemod(['sample.ts', '--typescript'], dir).stderr).toContain('--typescript needs');
  });

  it('says how to get TypeScript when there is none', () => {
    const { status, stderr } = codemod(['sample.ts'], project({ 'sample.ts': V1_CALL }));
    expect(status).toBe(2);
    expect(stderr).toContain('needs the "typescript" package');
  });

  it('expands globs and directories itself, at every depth, and skips node_modules', () => {
    // A shell would expand the glob one level deep, or not at all on Windows.
    const files = {
      'src/top.ts': V1_CALL,
      'src/deep/er/nested.ts': V1_CALL,
      'src/node_modules/dep/index.ts': V1_CALL,
      'src/notes.md': V1_CALL,
    };
    for (const pattern of ['src/**/*.ts', 'src']) {
      const dir = project(files);
      const { status, stdout } = codemod(['--typescript', repoTypeScript, '--write', pattern], dir);
      expect(status).toBe(0);
      expect(stdout).toContain('2 site(s) rewritten');
      expect(readFileSync(path.join(dir, 'src/top.ts'), 'utf8')).toBe(V2_CALL);
      expect(readFileSync(path.join(dir, 'src/deep/er/nested.ts'), 'utf8')).toBe(V2_CALL);
      expect(readFileSync(path.join(dir, 'src/node_modules/dep/index.ts'), 'utf8')).toBe(V1_CALL);
      expect(readFileSync(path.join(dir, 'src/notes.md'), 'utf8')).toBe(V1_CALL);
    }
  });

  it('changes nothing when one of the patterns matches no file', () => {
    const dir = project({ 'src/top.ts': V1_CALL });
    const { status, stderr } = codemod(
      ['--typescript', repoTypeScript, '--write', 'src/**/*.ts', 'lib/**/*.ts'],
      dir,
    );
    expect(status).toBe(2);
    expect(stderr).toContain('No file matches "lib/**/*.ts"');
    expect(readFileSync(path.join(dir, 'src/top.ts'), 'utf8')).toBe(V1_CALL);
    expect(codemod([], dir).stderr).toContain('usage: locco-migrate-v2');
  });

  it('never rewrites a call that contains another one, and reports it instead', () => {
    // A site is rebuilt from the source text of its key and ttl, so rewriting the outer call
    // would carry the inner 1.x call across verbatim and the two edits would overlap. Only the
    // inner call is safe to rewrite; the outer one is reported. Announcing "0 site(s) need a
    // hand" over code that still calls the deleted API is the worst thing this tool could do.
    const source =
      "const x = await locker.lock(await locker.lock('inner', 100).acquire(), 200).acquire();";
    const { output, report } = run(source, true);
    expect(output).toBe(
      "const x = await locker.lock(await locker.acquire('inner', { ttl: 100 }), 200).acquire();",
    );
    expect(report).toContain('line 1: a Locker.lock() call the codemod did not rewrite');
    expect(report).toContain('1 site(s) rewritten, 1 site(s) need a hand.');
  });

  it('reports the sites it cannot rewrite', () => {
    const source = [
      'const l = locker.lock(key, 5000);',
      'await l.acquire();',
      'const e = await locker.lock(key, 5000).setRetrySettings({ retryDelayFn: fn }).acquire();',
      'const f = await locker.lock(key, 5000).setRetrySettings(settings).acquire();',
      'const g = await locker.lock(key, 5000).setRetrySettings({ retryTimes: N, retryDelay: 1 }).acquire();',
    ].join('\n');
    const { output, report } = run(source);
    expect(output).toBe(source);
    expect(report).toContain('line 1: a Locker.lock() call the codemod did not rewrite');
    expect(report).toContain('line 3: a Locker.lock() call the codemod did not rewrite');
    expect(report).toContain('line 3: retryDelayFn');
    expect(report).toContain('line 4: a Locker.lock() call the codemod did not rewrite');
    expect(report).toContain('line 5: a Locker.lock() call the codemod did not rewrite');
    expect(report).not.toContain('Run again with --write');
  });
});
