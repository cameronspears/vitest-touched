import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findChanges } from '../src/git.js';

// Finding the base is where a quiet mistake would skip tests, so these use a real repository.
describe('finding what changed', () => {
  let dir: string;
  const git = (...args: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const write = (file: string, text = file) => writeFileSync(path.join(dir, file), text);
  const commit = (file: string) => {
    write(file);
    git('add', '-A');
    git('commit', '-qm', file);
  };

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'vitest-touched-'));
    git('init', '-q', '-b', 'main');
    commit('a.ts');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('compares with the base you give, including uncommitted and new files', () => {
    git('checkout', '-qb', 'feature');
    commit('b.ts');
    write('a.ts', 'edited');
    write('s.ts');
    git('add', 's.ts');
    write('c.ts');
    expect(findChanges(dir, 'main', {})).toEqual({ base: 'main', files: ['a.ts', 'b.ts', 's.ts', 'c.ts'] });
  });

  it('counts a rename as both paths, and gives root-relative paths from a subfolder', () => {
    git('checkout', '-qb', 'feature');
    mkdirSync(path.join(dir, 'pkg'));
    git('mv', 'a.ts', 'pkg/a.ts');
    expect(findChanges(path.join(dir, 'pkg'), 'main', {}).files).toEqual(['a.ts', 'pkg/a.ts']);
  });

  it('ignores what landed on the base after the branch started', () => {
    git('checkout', '-qb', 'feature');
    commit('b.ts');
    git('checkout', '-q', 'main');
    commit('later.ts');
    git('checkout', '-q', 'feature');
    expect(findChanges(dir, 'main', {}).files).toEqual(['b.ts']);
  });

  it("uses a merge commit's first parent, the way GitHub checks out a pull request", () => {
    git('checkout', '-qb', 'feature');
    commit('b.ts');
    git('checkout', '-q', 'main');
    commit('later.ts');
    git('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
    expect(findChanges(dir, undefined, {})).toEqual({ base: "the merge commit's first parent", files: ['b.ts'] });
  });

  it("uses the pull request's target branch, then origin's default branch", () => {
    git('checkout', '-qb', 'dev');
    commit('dev.ts');
    git('checkout', '-q', 'main');
    const clone = mkdtempSync(path.join(tmpdir(), 'vitest-touched-clone-'));
    try {
      execFileSync('git', ['clone', '-q', dir, clone]);
      execFileSync('git', ['checkout', '-qb', 'feature', 'origin/dev'], { cwd: clone });
      writeFileSync(path.join(clone, 'b.ts'), 'b');
      expect(findChanges(clone, undefined, {})).toEqual({ base: 'origin/main', files: ['dev.ts', 'b.ts'] });
      expect(findChanges(clone, undefined, { GITHUB_BASE_REF: 'dev' })).toEqual({ base: 'origin/dev', files: ['b.ts'] });
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("gives up when the clone doesn't reach back to the base", () => {
    git('checkout', '-qb', 'feature');
    commit('b.ts');
    commit('c.ts');
    git('checkout', '-q', 'main');
    commit('later.ts');
    const clone = mkdtempSync(path.join(tmpdir(), 'vitest-touched-shallow-'));
    try {
      execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', 'feature', `file://${dir}`, clone], { stdio: 'ignore' });
      execFileSync('git', ['fetch', '-q', '--depth', '1', 'origin', 'main:refs/remotes/origin/main'], { cwd: clone, stdio: 'ignore' });
      const changes = findChanges(clone, 'origin/main', {});
      expect(changes.files).toBeNull();
      expect(changes).toMatchObject({ why: expect.stringContaining('fetch more history') });
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it("gives up outside a git checkout", () => {
    const plain = mkdtempSync(path.join(tmpdir(), 'vitest-touched-plain-'));
    try {
      expect(findChanges(plain, undefined, {})).toEqual({ base: null, files: null, why: "this isn't a git checkout" });
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  it("gives up when there's nothing to compare with", () => {
    expect(findChanges(dir, undefined, {}).files).toBeNull();
    expect(findChanges(dir, 'missing', {}).files).toBeNull();
    expect(findChanges(dir, undefined, { GITHUB_BASE_REF: 'main' }).files).toBeNull();
  });
});
