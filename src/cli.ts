#!/usr/bin/env node
/**
 * The `vitest-touched` command. Works out what changed, decides what to run
 * with {@link plan}, then hands over to the project's own Vitest.
 *
 * Exit codes: Vitest's own when it runs; 0 for --help, --version, --dry-run or
 * when no test was touched; 2 for a bad option, bad config or missing Vitest.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as util from 'node:util';

import { USAGE, parseArgs, readUserConfig, resolveOptions, type Options } from './config.js';
import { findChanges, listFiles, repoRoot } from './git.js';
import { globToRegExp, plan, readsDisk, type Plan } from './plan.js';

/** A problem with how the tool was called or set up. Exits with code 2. */
class UsageError extends Error {}

// Colour only on a terminal, unless NO_COLOR turns it off or FORCE_COLOR turns it on.
const { NO_COLOR, FORCE_COLOR } = process.env;
const useColor =
  typeof util.styleText === 'function' &&
  !NO_COLOR &&
  (FORCE_COLOR ? FORCE_COLOR !== '0' : Boolean(process.stdout.isTTY));
type Style = 'bold' | 'dim' | 'green' | 'yellow' | 'cyan';
const paint = (style: Style, text: string) => (useColor ? util.styleText(style, text, { validateStream: false }) : text);

const say = (line = '') => process.stdout.write(`${line}\n`);
const toPosix = (file: string) => file.split(path.sep).join('/');
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
const NAME = paint('cyan', 'vitest-touched');

function version(): string {
  const pkgPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

/** Finds the project's own Vitest, the way `npx vitest` would. */
function vitestFrom(cwd: string): { bin: string; require: NodeJS.Require } {
  const require = createRequire(path.join(cwd, 'noop.js'));
  let pkgPath: string;
  try {
    pkgPath = require.resolve('vitest/package.json');
  } catch {
    throw new UsageError("couldn't find Vitest in this project. Install it first: npm install -D vitest");
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { bin?: string | Record<string, string> };
  const bin = typeof pkg.bin === 'string' ? pkg.bin : (pkg.bin?.vitest ?? 'vitest.mjs');
  return { bin: path.join(path.dirname(pkgPath), bin), require };
}

/** Test files under `cwd` (relative to it) that read the disk or run commands. */
function diskReaders(cwd: string, options: Options): string[] {
  const isTest = globToRegExp(options.tests);
  return listFiles(cwd)
    .filter((file) => isTest.test(file) && !file.includes('node_modules/') && existsSync(path.join(cwd, file)))
    .filter((file) => readsDisk(readFileSync(path.join(cwd, file), 'utf8'), options.readsDisk));
}

/**
 * Asks Vitest which tests import the changed files, without running them.
 * Uses Vitest's Node API (Vitest 3 and later); returns null if that isn't available.
 */
async function relatedTests(cwd: string, require: NodeJS.Require, files: string[]): Promise<string[] | null> {
  try {
    const node = (await import(pathToFileURL(require.resolve('vitest/node')).href)) as {
      createVitest: (mode: 'test', options: Record<string, unknown>) => Promise<{
        getRelevantTestSpecifications?: () => Promise<{ moduleId: string }[]>;
        close: () => Promise<void>;
      }>;
    };
    const vitest = await node.createVitest('test', {
      related: files.map((file) => path.resolve(cwd, file)),
      watch: false,
      run: true,
      passWithNoTests: true,
    });
    try {
      if (!vitest.getRelevantTestSpecifications) return null;
      const specs = await vitest.getRelevantTestSpecifications();
      return [...new Set(specs.map((spec) => toPosix(path.relative(cwd, spec.moduleId))))].sort();
    } finally {
      await vitest.close();
    }
  } catch {
    return null;
  }
}

const readers = (count: number) =>
  count === 1 ? '1 test that reads the disk or runs commands' : `${count} tests that read the disk or run commands`;

function group(title: string, files: readonly string[]) {
  say();
  say(`  ${paint('bold', title)} ${paint('dim', `(${files.length})`)}`);
  for (const file of files) say(`    ${file}`);
}

/** Prints the plan: what would run, grouped by why. */
async function printPlan(cwd: string, chosen: Plan, base: string | null, related: string[], require: NodeJS.Require) {
  if (chosen.mode === 'all') {
    say(`${NAME}: would run ${paint('yellow', 'every test')}, because ${chosen.why}.`);
    return;
  }
  const imports = related.length ? await relatedTests(cwd, require, related) : [];
  const alsoAlways = chosen.alwaysRun.filter((file) => !imports?.includes(file));
  if (imports === null) {
    say(
      `${NAME}: would run ${paint('green', 'the tests that import the changed files')}, ` +
        `plus ${readers(alsoAlways.length)}, compared with ${base}.`
    );
  } else {
    const total = imports.length + alsoAlways.length;
    say(`${NAME}: would run ${paint('green', plural(total, 'test file'))}, compared with ${base}.`);
  }
  group('Changed files', chosen.changed);
  if (imports === null) {
    say();
    say(`  ${paint('bold', 'Imports a changed file')} ${paint('dim', "(this Vitest can't list them ahead of time)")}`);
  } else {
    group('Imports a changed file', imports);
  }
  group('Reads the disk or runs commands, so always runs', alsoAlways);
  say();
  say(paint('dim', 'Nothing ran. Drop --dry-run to run them.'));
}

async function main(argv: string[]): Promise<number> {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    throw new UsageError(`${(error as Error).message}\nRun vitest-touched --help to see the options.`);
  }
  if (args.help) {
    say(USAGE);
    return 0;
  }
  if (args.version) {
    say(version());
    return 0;
  }
  const cwd = process.cwd();
  let options: Options;
  try {
    options = resolveOptions(args, readUserConfig(cwd));
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
  const vitest = vitestFrom(cwd);
  const changes = findChanges(cwd, options.base);
  const alwaysRun = changes.files ? diskReaders(cwd, options) : [];
  const chosen = plan({
    changed: changes.files,
    unknownReason: changes.files ? undefined : changes.why,
    alwaysRun,
    runEverything: options.runEverything,
  });

  // Changed paths are relative to the repository root; Vitest wants them relative to here.
  // A deleted file can't be looked up, so it's left out (type-checking catches what still imports it).
  const root = changes.files ? repoRoot(cwd) : cwd;
  const related =
    chosen.mode === 'touched'
      ? chosen.changed
          .map((file) => toPosix(path.relative(cwd, path.join(root, file))))
          .filter((file) => existsSync(path.join(cwd, file)))
      : [];

  if (options.dryRun) {
    await printPlan(cwd, chosen, changes.base, related, vitest.require);
    return 0;
  }

  const vitestArgs = [vitest.bin];
  if (chosen.mode === 'all') {
    say(`${NAME}: running ${paint('yellow', 'every test')}, because ${chosen.why}.`);
    vitestArgs.push('run', ...options.vitestArgs);
  } else if (related.length === 0 && alwaysRun.length === 0) {
    say(`${NAME}: nothing changed since ${changes.base} and no test always runs, so there's nothing to run.`);
    return 0;
  } else {
    say(
      `${NAME}: running the tests that import ${paint('green', plural(chosen.changed.length, 'changed file'))} ` +
        `since ${changes.base}, plus ${readers(alwaysRun.length)}.`
    );
    vitestArgs.push('related', '--run', '--passWithNoTests', ...options.vitestArgs, ...related, ...alwaysRun);
  }
  return spawnSync(process.execPath, vitestArgs, { stdio: 'inherit' }).status ?? 1;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`vitest-touched: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
);
