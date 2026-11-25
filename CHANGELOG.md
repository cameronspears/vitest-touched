# Changelog

## 0.1.0

First release.

- `vitest-touched` runs every test that imports a changed file, every test that reads the disk or
  runs commands, and the whole suite when a shared file changes or it can't tell what changed.
- Finds what changed from `--base`, `GITHUB_BASE_REF`, origin's default branch or a pull request's
  merge commit.
- `--dry-run` prints what would run, grouped by reason.
- Extra rules through a `vitestTouched` key in package.json or flags.
- `plan()`, the pure planning function, is exported for your own tests.
