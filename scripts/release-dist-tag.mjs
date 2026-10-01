#!/usr/bin/env node
// Prints the npm dist-tag for a release.
//   node scripts/release-dist-tag.mjs <version> [<version the latest tag points at now>]
// A prerelease goes to its identifier: 2.0.0-rc.1 to "rc". A stable version goes to "latest" only
// when it is newer than what "latest" points at, so a 1.x patch published after 2.0 goes to
// "latest-1" instead of taking "latest" away from 2.x users.
const [version, currentLatest = ''] = process.argv.slice(2);

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

const parsed = SEMVER.exec(version ?? '');
if (!parsed) {
  console.error(`"${version ?? ''}" is not a semantic version.`);
  process.exit(2);
}

console.log(distTag(parsed, SEMVER.exec(currentLatest)));

function distTag([, major, minor, patch, prerelease], latest) {
  if (prerelease !== undefined) {
    const identifier = prerelease.split('.')[0];
    // npm refuses a tag that reads as a version range, such as "1", and "latest" is not a prerelease.
    return /^[A-Za-z][0-9A-Za-z-]*$/.test(identifier) && identifier !== 'latest'
      ? identifier
      : 'next';
  }
  if (!latest) {
    return 'latest';
  }
  const ours = [major, minor, patch].map(Number);
  const theirs = latest.slice(1, 4).map(Number);
  const index = ours.findIndex((part, i) => part !== theirs[i]);
  // An equal version means the publish fails as a duplicate anyway; "latest" keeps that error clear.
  if (index === -1 || ours[index] > theirs[index]) {
    return 'latest';
  }
  return `latest-${major}`;
}
