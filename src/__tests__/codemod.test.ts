import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/codemod-v1-to-v2.mjs');

function run(source: string, write = false): { output: string; report: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'locco-codemod-'));
  const file = path.join(dir, 'sample.ts');
  writeFileSync(file, source);
  const report = execFileSync(process.execPath, [script, ...(write ? ['--write'] : []), file], {
    encoding: 'utf8',
  });
  return { output: readFileSync(file, 'utf8'), report };
}

/** Runs the codemod in a directory whose `typescript` resolves to `stub`, and returns its exit. */
function runWithTypeScript(stub: string): { status: number | null; stderr: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'locco-codemod-ts-'));
  writeFileSync(path.join(dir, 'package.json'), '{"name":"probe","version":"1.0.0"}');
  mkdirSync(path.join(dir, 'node_modules', 'typescript'), { recursive: true });
  writeFileSync(
    path.join(dir, 'node_modules', 'typescript', 'package.json'),
    '{"name":"typescript","version":"7.0.2","main":"index.js"}',
  );
  writeFileSync(path.join(dir, 'node_modules', 'typescript', 'index.js'), stub);
  const file = path.join(dir, 'sample.ts');
  writeFileSync(file, "const a = await locker.lock('k', 100).acquire();");
  const result = spawnSync(process.execPath, [script, file], { cwd: dir, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
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
    const { status, stderr } = runWithTypeScript('module.exports = { version: "7.0.2" };');
    expect(status).toBe(2);
    expect(stderr).toContain('classic TypeScript syntax API');
    expect(stderr).toContain('typescript@7.0.2');
    expect(stderr).toContain('npx --package typescript@5');
    expect(stderr).not.toContain('TypeError');
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
