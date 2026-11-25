import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DEFAULT_READS_DISK, DEFAULT_RUN_EVERYTHING, DEFAULT_TESTS } from './plan.js';

/** The `vitestTouched` key in package.json. Every key is optional. */
export interface UserConfig {
  /** Ref to compare with, such as `origin/main`. A `--base` flag wins over it. */
  base?: string;
  /** Extra globs, relative to the repository root, that run the whole suite. Added to the defaults. */
  runEverything?: string[];
  /** Extra regular expressions that mark a test as reading the disk. Added to the defaults. */
  readsDisk?: string[];
  /** Glob, relative to where Vitest runs, for test files. Replaces the default. */
  tests?: string;
}

/** Everything the command needs, after defaults, package.json and flags are merged. */
export interface Options {
  /** Ref to compare with, or undefined to find one. */
  base: string | undefined;
  /** Globs that run the whole suite: the defaults plus yours. */
  runEverything: string[];
  /** Patterns that mark a test as reading the disk: the defaults plus yours. */
  readsDisk: string[];
  /** Glob for test files. */
  tests: string;
  /** Print the plan instead of running it. */
  dryRun: boolean;
  /** Arguments passed straight to Vitest. */
  vitestArgs: string[];
}

/** The command line, parsed. */
export interface Args {
  help: boolean;
  version: boolean;
  dryRun: boolean;
  base?: string;
  runEverything: string[];
  readsDisk: string[];
  vitestArgs: string[];
}

/** The text `vitest-touched --help` prints. */
export const USAGE = `Usage: vitest-touched [options] [-- vitest arguments]

Runs only the Vitest tests your changes touched, or every test when it can't be sure.

Options:
  --base <ref>              Compare with this ref. Default: GITHUB_BASE_REF, then
                            origin's default branch, then a merge commit's first parent
  --dry-run                 Print what would run and why, without running anything
  --run-everything <glob>   Also run every test when a path matching this changes
  --reads-disk <regex>      Also always run tests whose source matches this
  -h, --help                Show this help
  -v, --version             Show the version

Examples:
  vitest-touched --dry-run
  vitest-touched --base origin/main
  vitest-touched --run-everything 'scripts/ci/**' -- --reporter=dot

Config: a "vitestTouched" key in package.json with "base", "runEverything",
"readsDisk" and "tests". Flags add to it.`;

/**
 * Parses the command line.
 * @param argv The arguments after the command name.
 * @returns The parsed options. Everything after `--` lands in `vitestArgs`.
 * @throws When an option is unknown or is missing its value.
 */
export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { help: false, version: false, dryRun: false, runEverything: [], readsDisk: [], vitestArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    const flag = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;
    const value = () => {
      if (inline !== undefined) return inline;
      const next = argv[++i];
      if (next === undefined || next.startsWith('-')) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (arg === '--') {
      args.vitestArgs = argv.slice(i + 1);
      break;
    } else if (flag === '-h' || flag === '--help') args.help = true;
    else if (flag === '-v' || flag === '--version') args.version = true;
    else if (flag === '--dry-run') args.dryRun = true;
    else if (flag === '--base') args.base = value();
    else if (flag === '--run-everything') args.runEverything.push(value());
    else if (flag === '--reads-disk') args.readsDisk.push(value());
    else throw new Error(`unknown option ${arg}. Put Vitest's own arguments after --`);
  }
  return args;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

const KEYS = ['base', 'runEverything', 'readsDisk', 'tests'];

/**
 * Reads the `vitestTouched` key from package.json.
 * @param cwd The folder holding package.json.
 * @returns The config, or `{}` when there's no package.json or no key.
 * @throws When the key holds something it doesn't understand, so a typo can't quietly skip tests.
 */
export function readUserConfig(cwd: string): UserConfig {
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(path.join(cwd, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
  const raw = (pkg as { vitestTouched?: unknown }).vitestTouched;
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('"vitestTouched" in package.json must be an object');
  }
  const config = raw as Record<string, unknown>;
  for (const key of Object.keys(config)) {
    if (!KEYS.includes(key)) throw new Error(`unknown key "vitestTouched.${key}" in package.json`);
  }
  for (const key of ['base', 'tests'] as const) {
    if (config[key] !== undefined && typeof config[key] !== 'string') {
      throw new Error(`"vitestTouched.${key}" in package.json must be a string`);
    }
  }
  for (const key of ['runEverything', 'readsDisk'] as const) {
    if (config[key] !== undefined && !isStringArray(config[key])) {
      throw new Error(`"vitestTouched.${key}" in package.json must be an array of strings`);
    }
  }
  return config as UserConfig;
}

/**
 * Merges the defaults, package.json and flags. Lists add up; a flag replaces a single value.
 * @param args The parsed command line.
 * @param config The `vitestTouched` key from package.json.
 * @returns The options the command runs with.
 * @throws When a `readsDisk` pattern isn't a valid regular expression.
 */
export function resolveOptions(args: Args, config: UserConfig): Options {
  const readsDisk = [...DEFAULT_READS_DISK, ...(config.readsDisk ?? []), ...args.readsDisk];
  for (const pattern of readsDisk) {
    try {
      new RegExp(pattern);
    } catch {
      throw new Error(`"${pattern}" isn't a valid regular expression`);
    }
  }
  return {
    base: args.base ?? config.base,
    runEverything: [...DEFAULT_RUN_EVERYTHING, ...(config.runEverything ?? []), ...args.runEverything],
    readsDisk,
    tests: config.tests ?? DEFAULT_TESTS,
    dryRun: args.dryRun,
    vitestArgs: args.vitestArgs,
  };
}
