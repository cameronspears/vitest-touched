/**
 * The pure half of vitest-touched: given what changed, decide what to run.
 * No git, no disk, no Vitest, so it is easy to test.
 */

/**
 * A change to a path matching any of these runs the whole suite. These are the
 * files every test stands on: packages, lockfiles, test and build config, CI.
 * Globs, matched against paths relative to the repository root.
 */
export const DEFAULT_RUN_EVERYTHING: readonly string[] = [
  '**/package.json',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/pnpm-lock.yaml',
  '**/pnpm-workspace.yaml',
  '**/yarn.lock',
  '**/bun.lock',
  '**/bun.lockb',
  '**/.npmrc',
  '**/.nvmrc',
  '**/.node-version',
  '**/vitest.config.*',
  '**/vitest.workspace.*',
  '**/vite.config.*',
  '**/{test-setup,vitest.setup,setupTests}.*',
  '**/tsconfig*.json',
  '.github/workflows/**',
];

/**
 * A test whose source matches any of these reads files or runs commands. The
 * import graph can't see what such a test depends on, so it runs every time.
 * Regular expressions, as strings.
 */
export const DEFAULT_READS_DISK: readonly string[] = [
  String.raw`from\s*['"](?:node:)?(?:fs|fs/promises|child_process)['"]`,
  String.raw`(?:require|import)\(\s*['"](?:node:)?(?:fs|fs/promises|child_process)['"]\s*\)`,
  String.raw`import\.meta\.glob`,
];

/** Which files count as tests, when looking for the ones that read the disk. */
export const DEFAULT_TESTS = '**/*.{test,spec}.{ts,tsx,mts,cts,js,jsx,mjs,cjs}';

/**
 * Turns a glob into a regular expression. Supports `*` (within one folder),
 * `**` (any number of folders), `?` and `{a,b}`. Paths use forward slashes.
 * @param glob The glob, such as `src/*.ts` or `docs/**`.
 * @returns A regular expression that matches the whole path.
 */
export function globToRegExp(glob: string): RegExp {
  let source = '';
  let braces = 0;
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === '*' && glob[i + 1] === '*') {
      // `**/` matches zero or more folders; a trailing `**` matches the rest.
      if (glob[i + 2] === '/') {
        source += '(?:.*/)?';
        i += 2;
      } else {
        source += '.*';
        i += 1;
      }
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{') {
      braces++;
      source += '(?:';
    } else if (char === '}' && braces > 0) {
      braces--;
      source += ')';
    } else if (char === ',' && braces > 0) source += '|';
    else source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${source}$`);
}

/**
 * Checks a path against a list of globs.
 * @param file A path with forward slashes.
 * @param globs Globs in the format {@link globToRegExp} takes.
 * @returns True when the path matches any of them.
 */
export function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(file));
}

/**
 * Checks whether a test reads files or runs commands, judged from its source.
 * @param source The test file's source code.
 * @param patterns Regular expressions as strings. Defaults to {@link DEFAULT_READS_DISK}.
 * @returns True when any pattern matches.
 */
export function readsDisk(source: string, patterns: readonly string[] = DEFAULT_READS_DISK): boolean {
  return patterns.some((pattern) => new RegExp(pattern).test(source));
}

/** What {@link plan} needs to decide. */
export interface PlanInput {
  /** Paths that changed, relative to the repository root. Null when that isn't known. */
  changed: readonly string[] | null;
  /** Why the changed paths aren't known, when `changed` is null. */
  unknownReason?: string;
  /** Tests that run every time (the ones that read the disk). */
  alwaysRun: readonly string[];
  /** Globs that run the whole suite. Defaults to DEFAULT_RUN_EVERYTHING. */
  runEverything?: readonly string[];
}

/** What {@link plan} decided: every test, or the touched ones. */
export type Plan =
  | { mode: 'all'; why: string }
  | {
      mode: 'touched';
      /** The changed paths. Vitest runs every test that imports one of them. */
      changed: string[];
      /** Tests that run because they read the disk or run commands. */
      alwaysRun: string[];
    };

/**
 * Decides what to run for a set of changed paths. Pure: no git, disk or Vitest.
 *
 * - Nothing known about the changes: every test.
 * - A path matching `runEverything` changed: every test.
 * - Otherwise: the tests that import a changed path, plus `alwaysRun`.
 *
 * @param input The changed paths, the tests that always run and the run-everything globs.
 * @returns `{ mode: 'all', why }` or `{ mode: 'touched', changed, alwaysRun }`.
 * @example
 * import { plan } from 'vitest-touched';
 *
 * plan({ changed: ['src/price.ts'], alwaysRun: ['test/files.test.ts'] });
 * // { mode: 'touched', changed: ['src/price.ts'], alwaysRun: ['test/files.test.ts'] }
 *
 * plan({ changed: ['pnpm-lock.yaml'], alwaysRun: [] });
 * // { mode: 'all', why: 'pnpm-lock.yaml changed' }
 */
export function plan({
  changed,
  unknownReason,
  alwaysRun,
  runEverything = DEFAULT_RUN_EVERYTHING,
}: PlanInput): Plan {
  if (changed === null) {
    return { mode: 'all', why: `couldn't tell what changed (${unknownReason ?? 'no base to compare with'})` };
  }
  const trigger = changed.find((file) => matchesAny(file, runEverything));
  if (trigger) return { mode: 'all', why: `${trigger} changed` };
  return { mode: 'touched', changed: [...new Set(changed)], alwaysRun: [...new Set(alwaysRun)] };
}
