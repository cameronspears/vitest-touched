import { describe, expect, it } from 'vitest';

import { parseArgs, resolveOptions } from '../src/config.js';
import { globToRegExp, plan, readsDisk } from '../src/index.js';

// These pin the cases where running only the touched tests would be unsafe, so
// everything runs instead.
describe('which tests run', () => {
  const alwaysRun = ['test/config.test.ts'];

  it('runs the changed files and the tests that read the disk', () => {
    expect(plan({ changed: ['src/outcome.ts', 'styles/main.css'], alwaysRun })).toEqual({
      mode: 'touched',
      changed: ['src/outcome.ts', 'styles/main.css'],
      alwaysRun,
    });
  });

  it('still runs the disk-reading tests when nothing else changed', () => {
    expect(plan({ changed: [], alwaysRun })).toEqual({ mode: 'touched', changed: [], alwaysRun });
  });

  it.each([
    'package.json',
    'packages/ui/package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'bun.lock',
    '.npmrc',
    'vitest.workspace.ts',
    'src/setupTests.ts',
    'package-lock.json',
    'yarn.lock',
    'vitest.config.ts',
    'vite.config.mjs',
    'test-setup.ts',
    'vitest.setup.ts',
    'tsconfig.json',
    'tsconfig.build.json',
    '.github/workflows/ci.yml',
  ])('runs everything when %s changes', (file) => {
    expect(plan({ changed: ['app/page.tsx', file], alwaysRun })).toEqual({ mode: 'all', why: `${file} changed` });
  });

  it('adds your own run-everything patterns to the defaults', () => {
    const runEverything = resolveOptions(parseArgs(['--run-everything', 'scripts/ci/**']), {}).runEverything;
    expect(plan({ changed: ['scripts/ci/checks.sh'], alwaysRun, runEverything })).toEqual({
      mode: 'all',
      why: 'scripts/ci/checks.sh changed',
    });
    expect(plan({ changed: ['package.json'], alwaysRun, runEverything }).mode).toBe('all');
    expect(plan({ changed: ['scripts/build.sh'], alwaysRun, runEverything }).mode).toBe('touched');
  });

  it("runs everything when it can't tell what changed", () => {
    expect(plan({ changed: null, unknownReason: 'no base ref found', alwaysRun })).toEqual({
      mode: 'all',
      why: "couldn't tell what changed (no base ref found)",
    });
  });

  it('spots a test that reads files or runs commands', () => {
    expect(readsDisk("import { readFileSync } from 'node:fs';")).toBe(true);
    expect(readsDisk('import { execFileSync } from "node:child_process";')).toBe(true);
    expect(readsDisk("import fs from 'fs/promises';")).toBe(true);
    expect(readsDisk("const fs = require('fs');")).toBe(true);
    expect(readsDisk("const fs = await import('node:fs');")).toBe(true);
    expect(readsDisk("const pages = import.meta.glob('./*.tsx');")).toBe(true);
    expect(readsDisk("import { render } from '@testing-library/react';")).toBe(false);
  });

  it('lets you mark more tests as reading the disk', () => {
    const patterns = resolveOptions(parseArgs([]), { readsDisk: ["from 'execa'"] }).readsDisk;
    expect(readsDisk("import { execa } from 'execa';", patterns)).toBe(true);
    expect(readsDisk("import { readFileSync } from 'node:fs';", patterns)).toBe(true);
  });
});

describe('globs', () => {
  it.each([
    ['**/package.json', 'package.json', true],
    ['**/package.json', 'a/b/package.json', true],
    ['**/package.json', 'package.json.bak', false],
    ['.github/workflows/**', '.github/workflows/ci.yml', true],
    ['src/*.ts', 'src/a/b.ts', false],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['**/*.{test,spec}.ts', 'src/a.spec.ts', true],
    ['**/*.{test,spec}.ts', 'src/a.ts', false],
  ])('%s against %s is %s', (glob, file, expected) => {
    expect(globToRegExp(glob).test(file)).toBe(expected);
  });
});

describe('the command line', () => {
  it('passes everything after -- to Vitest', () => {
    expect(parseArgs(['--base=origin/dev', '--dry-run', '--', '--reporter', 'dot'])).toMatchObject({
      base: 'origin/dev',
      dryRun: true,
      vitestArgs: ['--reporter', 'dot'],
    });
  });

  it('rejects options it does not know', () => {
    expect(() => parseArgs(['--reporter', 'dot'])).toThrow(/after --/);
  });

  it('lets a flag win over package.json for the base', () => {
    expect(resolveOptions(parseArgs(['--base', 'a']), { base: 'b' }).base).toBe('a');
    expect(resolveOptions(parseArgs([]), { base: 'b' }).base).toBe('b');
  });
});
