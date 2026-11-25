import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// The built command, end to end, in a throwaway repository with real Vitest runs.
const here = path.dirname(new URL(import.meta.url).pathname);
const cli = path.join(here, '..', 'dist', 'cli.js');
const pkg = JSON.parse(readFileSync(path.join(here, '..', 'package.json'), 'utf8')) as { version: string };

let dir: string;
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
const write = (file: string, text: string) => {
  mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  writeFileSync(path.join(dir, file), text);
};
// The environment a user's shell would have: none of the variables this test run itself sets.
const shellEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(VITEST|NODE_PATH$|NODE_ENV$|NO_COLOR$|FORCE_COLOR$|GITHUB_BASE_REF$)/.test(key))
  );
const runWith = (env: Record<string, string>, ...args: string[]) => {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...shellEnv(), CI: '1', ...env },
  });
  return { code: result.status, out: result.stdout, err: result.stderr };
};
const run = (...args: string[]) => runWith({}, ...args);
const test = (name: string, from: string, body: string) =>
  `import { expect, it } from 'vitest';\n${from}\nit('${name}', () => { ${body} });\n`;

beforeAll(() => {
  if (!existsSync(cli)) throw new Error('Build first: pnpm build');
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'vitest-touched-cli-')));
  symlinkSync(path.join(here, '..', 'node_modules'), path.join(dir, 'node_modules'));
  write('.gitignore', 'node_modules\n');
  write('package.json', JSON.stringify({ name: 'demo', type: 'module' }));
  write('src/price.js', 'export const price = (n) => n * 2;\n');
  write('src/label.js', 'export const label = (s) => s.trim();\n');
  write('test/price.test.js', test('doubles', "import { price } from '../src/price.js';", 'expect(price(2)).toBe(4);'));
  // Broken on purpose: it only fails if it runs, which it shouldn't unless label.js changes.
  write('test/label.test.js', test('trims', "import { label } from '../src/label.js';", "expect(label(' a ')).toBe('b');"));
  write('test/files.test.js', test('reads', "import { existsSync } from 'node:fs';", "expect(existsSync('package.json')).toBe(true);"));
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'start');
  git('checkout', '-qb', 'feature');
  write('src/price.js', 'export const price = (n) => n + n;\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the vitest-touched command', { timeout: 30_000 }, () => {
  it('prints the plan grouped by reason, without running anything', () => {
    const { code, out } = run('--dry-run', '--base', 'main');
    expect(code).toBe(0);
    expect(out).toContain('would run 2 test files, compared with main.');
    expect(out).toMatch(/Changed files \(1\)\n {4}src\/price\.js/);
    expect(out).toMatch(/Imports a changed file \(1\)\n {4}test\/price\.test\.js/);
    expect(out).toMatch(/Reads the disk or runs commands, so always runs \(1\)\n {4}test\/files\.test\.js/);
    expect(out).not.toContain('Test Files');
    expect(out).not.toContain('\x1b['); // no colour when the output isn't a terminal
  });

  it('runs only the touched tests and passes on Vitest exit code', () => {
    const touched = run('--base', 'main', '--', '--reporter=verbose');
    expect(touched.out).toContain('running the tests that import 1 changed file since main, plus 1 test that reads');
    expect(touched.out).toContain('2 passed');
    expect(touched.out).toContain('doubles'); // test names show, so --reporter=verbose got through
    expect(touched.code).toBe(0); // the broken label test didn't run

    write('src/label.js', 'export const label = (s) => s;\n');
    const broken = run('--base', 'main');
    expect(broken.code).toBe(1);
    git('checkout', '-q', 'src/label.js');
  });

  it('leaves a deleted file out of the Vitest call', () => {
    rmSync(path.join(dir, 'src/label.js'));
    const { code, out } = run('--base', 'main');
    expect(out).toContain('2 changed files');
    expect(code).toBe(0);
    git('checkout', '-q', 'src/label.js');
  });

  it('colours the plan only when asked or on a terminal, and NO_COLOR wins', () => {
    expect(run('--dry-run', '--base', 'main').out).not.toContain('\x1b[');
    expect(runWith({ FORCE_COLOR: '1' }, '--dry-run', '--base', 'main').out).toContain('\x1b[');
    expect(runWith({ FORCE_COLOR: '1', NO_COLOR: '1' }, '--dry-run', '--base', 'main').out).not.toContain('\x1b[');
  });

  it('runs every test when a shared file changes or it cannot tell', () => {
    write('package.json', JSON.stringify({ name: 'demo', type: 'module', version: '1.0.0' }));
    expect(run('--dry-run', '--base', 'main').out).toContain('would run every test, because package.json changed.');
    git('checkout', '-q', 'package.json');
    expect(run('--dry-run').out).toContain("would run every test, because couldn't tell what changed (no base ref found");
  });

  it('reads extra rules from package.json, and refuses a typo', () => {
    // Commit the config, then compare with that commit so package.json itself isn't a change.
    write('package.json', JSON.stringify({ name: 'demo', type: 'module', vitestTouched: { runEverything: ['src/price.js'] } }));
    git('commit', '-qm', 'config', 'package.json');
    expect(run('--dry-run', '--base', 'HEAD').out).toContain('would run every test, because src/price.js changed.');

    write('package.json', JSON.stringify({ name: 'demo', vitestTouched: { runEverthing: [] } }));
    const bad = run('--dry-run');
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('unknown key "vitestTouched.runEverthing"');
    git('checkout', '-q', 'package.json');
  });

  it('exits cleanly when no test was touched', () => {
    // Limit the tests to two that read nothing, so nothing has to run every time.
    write('package.json', JSON.stringify({ name: 'demo', type: 'module', vitestTouched: { tests: 'test/{price,label}.test.js' } }));
    git('commit', '-qm', 'tests', 'package.json');
    git('checkout', '-q', 'src/price.js');
    const clean = run('--base', 'HEAD');
    expect(clean.out).toContain('nothing changed since HEAD');
    expect(clean.code).toBe(0);

    write('notes.md', 'hello\n'); // a change no test imports
    const docs = run('--base', 'HEAD');
    expect(docs.out).not.toContain('label.test');
    expect(docs.code).toBe(0);
  });

  it('answers --help, --version, bad options and a missing Vitest', () => {
    expect(run('--help').out).toContain('Examples:');
    expect(run('--version').out.trim()).toBe(pkg.version);
    const elsewhere = realpathSync(mkdtempSync(path.join(tmpdir(), 'vitest-touched-novitest-')));
    const missing = spawnSync(process.execPath, [cli, '--dry-run'], { cwd: elsewhere, encoding: 'utf8', env: shellEnv() });
    rmSync(elsewhere, { recursive: true, force: true });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("couldn't find Vitest");

    const bad = run('--reporter', 'dot');
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("Put Vitest's own arguments after --");
  });
});
