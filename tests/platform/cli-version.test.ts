import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cliBuildIdentity, packageRuntimeIdentity } from '../../src/platform/cli-version.js';

const roots: string[] = [];
function installation(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'scip-build-identity-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"name":"scip-query","version":"1.0.0"}');
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, content);
  }
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('package runtime identity', () => {
  it('invalidates a fixed launcher when its implementation or a nested chunk changes', () => {
    const root = installation({
      'dist/cli.js': 'import "./cli-main.js";',
      'dist/cli-main.js': 'export const detector = 1;',
      'dist/chunks/shared.js': 'export const shared = 1;',
    });
    const first = packageRuntimeIdentity(root, 'dist');
    writeFileSync(join(root, 'dist/cli-main.js'), 'export const detector = 2;');
    const second = packageRuntimeIdentity(root, 'dist');
    expect(second).not.toBe(first);
    writeFileSync(join(root, 'dist/chunks/shared.js'), 'export const shared = 2;');
    expect(packageRuntimeIdentity(root, 'dist')).not.toBe(second);
  });

  it('is stable across relocation and creation order, excluding source maps and declarations', () => {
    const a = installation({ 'dist/z.js': 'z', 'dist/a.js': 'a' });
    const b = installation({ 'dist/a.js': 'a', 'dist/z.js': 'z', 'dist/a.js.map': 'map', 'dist/a.d.ts': 'types' });
    expect(packageRuntimeIdentity(a, 'dist')).toBe(packageRuntimeIdentity(b, 'dist'));
    writeFileSync(join(b, 'package.json'), '{"name":"scip-query","version":"2.0.0"}');
    expect(packageRuntimeIdentity(a, 'dist')).not.toBe(packageRuntimeIdentity(b, 'dist'));
  });

  it('tracks source execution independently of a stale dist build', () => {
    const root = installation({ 'src/owner.ts': 'export const value = 1;', 'dist/cli.js': 'old' });
    const first = packageRuntimeIdentity(root, 'src');
    writeFileSync(join(root, 'src/owner.ts'), 'export const value = 2;');
    expect(packageRuntimeIdentity(root, 'src')).not.toBe(first);
  });

  it('rejects incomplete, empty, linked, and oversized runtime inputs instead of hashing a partial tree', () => {
    const root = installation({ 'dist/cli.js': 'ok' });
    expect(() => packageRuntimeIdentity(root, 'src')).toThrow();
    mkdirSync(join(root, 'src'));
    expect(() => packageRuntimeIdentity(root, 'src')).toThrow('empty');
    symlinkSync(join(root, 'dist/cli.js'), join(root, 'dist/linked.js'));
    expect(() => packageRuntimeIdentity(root, 'dist')).toThrow('Unsupported runtime entry');
    rmSync(join(root, 'dist/linked.js'));
    writeFileSync(join(root, 'dist/large.js'), Buffer.alloc(8 * 1024 * 1024 + 1));
    expect(() => packageRuntimeIdentity(root, 'dist')).toThrow('safety limit');
  });

  it('identifies the package independently of the caller executable and memoizes it', () => {
    const original = process.argv[1];
    try {
      process.argv[1] = '/does-not-exist/application.js';
      const identity = cliBuildIdentity();
      expect(identity).toMatch(/^[a-f0-9]{16}$/);
      process.argv[1] = '/another/application.js';
      expect(cliBuildIdentity()).toBe(identity);
    } finally {
      process.argv[1] = original;
    }
  });
});
