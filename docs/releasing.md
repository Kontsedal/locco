# Releasing

A pushed `v*` tag publishes the package from `.github/workflows/publish.yml`. The workflow has two
jobs. `verify` runs every check with no write permission, packs the tarball and picks the
dist-tag. `publish` runs in the `npm` environment, holds the only OIDC token, runs no project code,
and publishes the tarball that `verify` tested, with provenance.

## One-time setup

1. **npm trusted publishing.** On npmjs.com, open the package settings of `@kontsedal/locco` and
   add a trusted publisher: GitHub Actions, repository `Kontsedal/locco`, workflow `publish.yml`,
   environment `npm`. Then set publishing access to require two-factor authentication and
   disallow tokens, and revoke any npm token stored for this repository. The workflow uses no
   token; npm swaps the job's OIDC token for one that lasts minutes.
2. **The `npm` environment.** In the repository settings, under Environments, create `npm`, add
   yourself as a required reviewer, and limit deployment to tags matching `v*`. A publish then
   waits for an approval after every check has passed.
3. **Tag protection.** Add a tag ruleset for `v*` that restricts creation, update and deletion to
   maintainers, so nobody else can start a release and a published tag cannot be moved.

## A release

1. Set the version: `npm version 2.0.0 --no-git-tag-version`. It updates `package.json` and
   `package-lock.json` together.
2. Rename `## [Unreleased]` in `CHANGELOG.md` to the version and date, add a new empty
   `## [Unreleased]` above it, and point the link references at the new tag.
3. Commit, then tag and push: `git tag v2.0.0 && git push origin v2.0.0`.
4. Approve the `npm` deployment once `verify` is green.

The dist-tag follows from the version. A prerelease goes to its identifier, so `2.0.0-rc.1` goes
to `rc`. A stable version goes to `latest` only when it is newer than the current `latest` and the
tagged commit is on `main`; a patch for an older major goes to `latest-<major>`, such as
`latest-1`. `scripts/release-dist-tag.mjs` holds the rule and has its own tests.
