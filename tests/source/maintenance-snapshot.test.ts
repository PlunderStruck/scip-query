import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { currentSourceSnapshot } from '../../src/source/maintenance-snapshot.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('covers an ordinary source inventory larger than the former 5000-file default', () => {
  const root = mkdtempSync(join(tmpdir(), 'scip-large-source-'));
  roots.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  mkdirSync(join(root, 'src'));
  for (let index = 0; index < 5001; index++) writeFileSync(join(root, 'src', `${index}.ts`), 'export {};');
  const complete = currentSourceSnapshot(root);
  expect(complete.files.size).toBe(5001);
  expect(complete.problems).toEqual([]);
  const bounded = currentSourceSnapshot(root, { maxFiles: 5 });
  expect(bounded.eligibleFiles).toBe(5001);
  expect(bounded.files.size).toBe(5);
  expect(bounded.problems.join()).toContain('4996 eligible files omitted');
}, 20_000);
