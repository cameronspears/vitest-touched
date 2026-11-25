import { execFileSync } from 'node:child_process';

/** What changed, or why that couldn't be worked out. */
export type Changes =
  | {
      /** What the changes were compared with, in words. */
      base: string;
      /** Changed paths, relative to the repository root. */
      files: string[];
    }
  | { base: null; files: null; why: string };

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}

function tryGit(cwd: string, ...args: string[]): string | null {
  try {
    return git(cwd, ...args).trim();
  } catch {
    return null;
  }
}

const verify = (cwd: string, ref: string) => tryGit(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);

const split = (out: string) => out.split('\0').filter(Boolean);

/**
 * Picks the commit to compare with, in this order:
 * 1. the ref the user gave (`--base` or config);
 * 2. on a GitHub pull request, the branch it targets (`GITHUB_BASE_REF`);
 * 3. origin's default branch;
 * 4. when HEAD is a merge commit (how GitHub checks out a pull request), its first parent.
 * Returns null when none of these exist.
 */
function findBase(
  cwd: string,
  requested: string | undefined,
  env: NodeJS.ProcessEnv
): { ref: string; label: string } | { ref: null; why: string } {
  if (requested) {
    return verify(cwd, requested)
      ? { ref: requested, label: requested }
      : { ref: null, why: `the base ${requested} isn't in this checkout` };
  }
  const candidates: string[] = [];
  if (env.GITHUB_BASE_REF) candidates.push(`origin/${env.GITHUB_BASE_REF}`);
  const originHead = tryGit(cwd, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD');
  if (originHead) candidates.push(originHead);
  for (const ref of candidates) if (verify(cwd, ref)) return { ref, label: ref };
  if (verify(cwd, 'HEAD^2')) return { ref: 'HEAD^1', label: "the merge commit's first parent" };
  return { ref: null, why: 'no base ref found; pass --base' };
}

/**
 * Finds what changed since the base: committed, staged, unstaged and new
 * untracked files, so it works in CI and on your own machine. Renames count as
 * a delete plus an add, so both paths show.
 * @param cwd Any folder inside the repository.
 * @param requested The ref to compare with. When left out: `origin/$GITHUB_BASE_REF`, then
 *   origin's default branch, then the first parent when HEAD is a merge commit.
 * @param env Where to read `GITHUB_BASE_REF` from. Defaults to `process.env`.
 * @returns The base and the changed paths (relative to the repository root), or why they aren't known.
 */
export function findChanges(cwd: string, requested?: string, env: NodeJS.ProcessEnv = process.env): Changes {
  if (tryGit(cwd, 'rev-parse', '--is-inside-work-tree') !== 'true') {
    return { base: null, files: null, why: "this isn't a git checkout" };
  }
  const base = findBase(cwd, requested, env);
  if (base.ref === null) return { base: null, files: null, why: base.why };

  // Compare with where this branch left the base, so commits that landed on the
  // base since don't count as changes. A shallow clone may not have it.
  const from = tryGit(cwd, 'merge-base', base.ref, 'HEAD');
  if (!from) {
    return { base: null, files: null, why: `no common history with ${base.label}; fetch more history` };
  }
  try {
    // `:/` makes every path relative to the repository root, wherever we run.
    const diffed = split(git(cwd, 'diff', '--name-only', '--no-renames', '-z', from, '--', ':/'));
    const untracked = split(git(cwd, 'ls-files', '--others', '--exclude-standard', '--full-name', '-z', '--', ':/'));
    return { base: base.label, files: [...new Set([...diffed, ...untracked])] };
  } catch {
    return { base: null, files: null, why: `git couldn't compare with ${base.label}` };
  }
}

/**
 * Finds the repository root.
 * @param cwd Any folder inside the repository.
 * @returns The root's absolute path.
 */
export function repoRoot(cwd: string): string {
  return git(cwd, 'rev-parse', '--show-toplevel').trim();
}

/**
 * Lists every tracked or new (not ignored) file under a folder.
 * @param cwd The folder.
 * @returns Paths relative to `cwd`.
 */
export function listFiles(cwd: string): string[] {
  return split(git(cwd, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'));
}
