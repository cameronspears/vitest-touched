# vitest-touched

Runs only the Vitest tests a change could break in CI, and every test when it can't be sure.

On the project it came from (about 640 test files), I looked at the last 40 pull requests. 32 of
them ran a median of 85 test files, and the tests took 16 seconds instead of about 90. The other 8
changed something every test depends on, so they ran the lot. Averaged over all 40, the test step
went from about 90 seconds to 37.

[Demo](https://cameronspears.github.io/vitest-touched/demo/) (click a file to change it and see which tests run)

```bash
npm install -D vitest-touched
npx vitest-touched --dry-run
```

`--dry-run` shows what it would run for your branch, without running anything:

```text
vitest-touched: would run 2 test files, compared with origin/main.

  Changed files (1)
    src/price.ts

  Imports a changed file (1)
    test/price.test.ts

  Reads the disk or runs commands, so always runs (1)
    test/config.test.ts

Nothing ran. Drop --dry-run to run them.
```

Drop `--dry-run` to run those tests. Anything after `--` goes straight to Vitest, for example
`npx vitest-touched -- --reporter=dot`. It exits with Vitest's exit code.

## What runs and why

Every test that imports a changed file, directly or through other files. Vitest works this out
itself with `vitest related`.

Every test that reads the disk or runs commands. A test that reads a stylesheet or a workflow file
never imports it, so the import graph can't tell when it matters. These run on every change. It
spots them by searching each test's source for `fs`, `fs/promises`, `child_process` (with or without
`node:`) and `import.meta.glob`.

Every test, when a file everything depends on changes, or when it can't tell what changed. By
default that's any `package.json`, lockfile, `pnpm-workspace.yaml`, `.npmrc`, `.nvmrc`,
`.node-version`, `tsconfig*.json`, Vite or Vitest config, test setup file, and anything in
`.github/workflows/`.

To work out what changed, it compares with `--base` if you give one, then the pull request's target
branch on GitHub, then origin's default branch, then the first parent of a merge commit. It compares
from where your branch split off, and counts committed, staged, unstaged and new files, so it works
on your own machine too.

## Config

Put a `vitestTouched` key in the package.json next to where you run Vitest. Every key is optional.

```json
{
  "vitestTouched": {
    "base": "origin/main",
    "runEverything": ["scripts/ci/**"],
    "readsDisk": ["from 'execa'"]
  }
}
```

- `base`: the ref to compare with. `--base` wins over it.
- `runEverything`: more globs, from the repository root, that run every test. Added to the
  defaults. Also `--run-everything <glob>`.
- `readsDisk`: more regular expressions that mark a test as reading the disk. Added to the
  defaults. Also `--reads-disk <regex>`.
- `tests`: which files count as tests when looking for disk readers. Defaults to
  `**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}`.

An unknown key is an error, so a typo can't quietly skip tests.

## GitHub Actions

```yaml
on:
  pull_request:
  push:
    branches: [main]
  schedule:
    - cron: '0 4 * * *'

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 2 # the merge commit and its parents
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - if: github.event_name == 'pull_request'
        run: npx vitest-touched
      - if: github.event_name != 'pull_request'
        run: npx vitest run
```

Keep running the full suite on main or on a schedule. vitest-touched can miss a test that depends on
a file in a way it can't see, like a file read through a shared helper, an environment variable or a
network call. The full run catches it.

## Why not vitest related, --changed or vitest-affected

`vitest related` is what this runs underneath, but you have to find the changed files yourself, and
it doesn't know about tests that read the disk or files every test depends on.

`vitest --changed` finds the changed files for you and reruns everything when `package.json` or a
Vite or Vitest config changes. It doesn't run disk-reading tests, and it doesn't watch lockfiles,
tsconfig or CI files.

[vitest-affected](https://www.npmjs.com/package/vitest-affected) is a plugin that records what each
test really loaded and keeps a cache. It's more precise. vitest-touched is a plain command with no
cache, and it runs disk-reading tests without you listing them. If you can keep a cache, try
vitest-affected first.

It needs git, Node 20 or later and Vitest 3 or later.

## License

MIT
