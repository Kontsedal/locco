import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const script = path.resolve('scripts/release-dist-tag.mjs');

function distTag(...args: string[]): { status: number | null; tag: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
  return { status: result.status, tag: result.stdout.trim(), stderr: result.stderr };
}

describe('release-dist-tag', () => {
  it('sends a prerelease to its identifier', () => {
    expect(distTag('2.0.0-beta.2', '1.1.0').tag).toBe('beta');
    expect(distTag('2.0.0-rc.1', '1.1.0').tag).toBe('rc');
    expect(distTag('2.1.0-next.0+build.5', '2.0.0').tag).toBe('next');
  });

  it('sends a prerelease without a usable identifier to "next"', () => {
    // npm refuses a tag that reads as a version range, and "latest" must stay stable.
    expect(distTag('2.0.0-0', '1.1.0').tag).toBe('next');
    expect(distTag('2.0.0-latest.1', '1.1.0').tag).toBe('next');
  });

  it('moves "latest" only forward', () => {
    expect(distTag('2.0.0', '1.1.0').tag).toBe('latest');
    expect(distTag('2.0.1', '2.0.0').tag).toBe('latest');
    expect(distTag('2.1.0', '2.0.9').tag).toBe('latest');
    expect(distTag('2.0.0').tag).toBe('latest');
    expect(distTag('2.0.0', '2.0.0').tag).toBe('latest');
  });

  it('keeps a maintenance release of an older major off "latest"', () => {
    expect(distTag('1.1.1', '2.0.0').tag).toBe('latest-1');
    expect(distTag('2.0.5', '2.1.0').tag).toBe('latest-2');
  });

  it('refuses something that is not a version', () => {
    const result = distTag('v2.0.0');
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('not a semantic version');
    expect(distTag().status).toBe(2);
  });
});
