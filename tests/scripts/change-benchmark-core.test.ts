import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import {
  changePrompt,
  changeSuite,
  compareChangeTrials,
  directoryDigest,
  evaluateChange,
  materializeChangeFixture,
} from '../../scripts/change-benchmark-core.mjs';
import { applyFlawedPatch, applyReferencePatch } from '../../benchmarks/change/reference-patches.mjs';

describe('change benchmark obligations', () => {
  const roots: string[] = [];
  function fixture(task: string): string {
    const parent = mkdtempSync(join(tmpdir(), 'change-benchmark-test-'));
    roots.push(parent);
    const root = join(parent, 'repository');
    materializeChangeFixture(root, task);
    return root;
  }
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  for (const task of changeSuite().tasks) {
    it(`${task.id}: accepts valid initial and follow-up implementations`, () => {
      const root = fixture(task.id);
      applyReferencePatch(root, task.id);
      const initial = evaluateChange(root, task.id, 'initial');
      expect(initial.obligations.filter((item: { pass: boolean }) => !item.pass)).toEqual([]);
      applyReferencePatch(root, task.id, 'follow-up');
      const followUp = evaluateChange(root, task.id, 'follow-up');
      expect(followUp.obligations.filter((item: { pass: boolean }) => !item.pass)).toEqual([]);
    }, 30_000);
    it(`${task.id}: rejects unchanged code and deliberately flawed patches in both phases`, () => {
      const root = fixture(task.id);
      expect(evaluateChange(root, task.id, 'initial').pass).toBe(false);
      for (const phase of ['initial', 'follow-up']) {
        const broken = fixture(task.id);
        applyFlawedPatch(broken, task.id, phase);
        expect(evaluateChange(broken, task.id, phase).pass).toBe(false);
      }
    }, 30_000);
  }

  it('accepts an alternative shared quote owner and arrow-function adapters', () => {
    const root = fixture('separate-responsibilities');
    applyReferencePatch(root, 'separate-responsibilities');
    const original = join(root, 'src/pricing/quote.ts');
    writeFileSync(
      join(root, 'src/pricing/total.ts'),
      readFileSync(original, 'utf8').replace('function quote(', 'function calculateTotal('),
    );
    rmSync(original);
    for (const [path, name] of [
      ['checkout-quote', 'checkoutQuote'],
      ['support-quote', 'supportQuote'],
    ]) {
      writeFileSync(
        join(root, `src/adapters/${path}.ts`),
        `import { calculateTotal } from '../pricing/total.js';\nexport const ${name} = (unitPrice: number, quantity: number): number => calculateTotal(unitPrice, quantity);\n`,
      );
    }
    expect(evaluateChange(root, 'separate-responsibilities', 'initial').pass).toBe(true);
  });

  it('rejects a shared predicate that leaves cancellation writes in an adapter', () => {
    const root = fixture('shared-rule');
    applyFlawedPatch(root, 'shared-rule');
    const path = join(root, 'src/adapters/cancellation-job.ts');
    const source = readFileSync(path, 'utf8')
      .replace('import type', "import { canCancel } from '../reservations/policy.js';\nimport type")
      .replace("reservation.status === 'cancelled' || reservation.startsAt <= now", '!canCancel(reservation, now)');
    writeFileSync(path, source);
    const result = evaluateChange(root, 'shared-rule', 'initial');
    expect(result.obligations.find((item: { id: string }) => item.id === 'cancellation-job')?.pass).toBe(true);
    expect(result.obligations.find((item: { id: string }) => item.id === 'cancellation-write-owner')?.pass).toBe(false);
  });

  it('holds investigation discipline constant and varies only the available exploration surface', () => {
    const task = changeSuite().tasks[0];
    const control = changePrompt(task, 'control', 'initial');
    const treatment = changePrompt(task, 'treatment', 'initial');
    expect(control).toContain(task.request);
    expect(treatment).toContain(task.request);
    expect(control.split('Explore using native')[0]).toBe(treatment.split('Use scip-query as the primary')[0]);
    expect(control).toContain('Do not invoke scip-query');
    expect(treatment).toContain('Drain every printed Continue exactly');
    expect(changePrompt(task, 'control', 'follow-up')).toContain('You may update tests added during an earlier phase');
  });

  it('detects stale agent-added tests and permits updating them for the follow-up requirement', () => {
    const root = fixture('shared-rule');
    applyReferencePatch(root, 'shared-rule');
    const path = join(root, 'test/window.test.mjs');
    const test =
      "import assert from 'node:assert/strict';\nimport { canCancel } from '../build/index.js';\nassert.equal(canCancel({id:'r',status:'confirmed',locked:false,startsAt:24*60*60*1000},0),true);\n";
    writeFileSync(path, test);
    expect(evaluateChange(root, 'shared-rule', 'initial').pass).toBe(true);
    applyReferencePatch(root, 'shared-rule', 'follow-up');
    const stale = evaluateChange(root, 'shared-rule', 'follow-up');
    expect(stale.obligations.find((item: { id: string }) => item.id === 'submitted-tests')?.pass).toBe(false);
    writeFileSync(path, test.replace('24*60', '48*60'));
    expect(evaluateChange(root, 'shared-rule', 'follow-up').pass).toBe(true);
  });

  it('binds comparison pairs to the same inputs and retains failed trials', () => {
    const trial = {
      suiteId: 'suite',
      suiteDigest: 'frozen',
      evaluatorDigest: 'checks',
      toolDigest: 'tool',
      baselineCommit: 'commit',
      taskId: 'task',
      model: 'gpt-5.6-sol',
      reasoning: 'medium',
      repetition: 1,
      timeoutMs: 1000,
      status: 'failed',
      phases: [],
      indexDurationMs: null,
    };
    const compared = compareChangeTrials([
      { ...trial, mode: 'control' },
      { ...trial, mode: 'treatment' },
    ]);
    expect(compared[0].control).toMatchObject({ completed: false, initialPass: false, inputTokens: null });
    expect(() =>
      compareChangeTrials([
        { ...trial, mode: 'control' },
        { ...trial, mode: 'treatment', reasoning: 'low' },
      ]),
    ).toThrow('matched');
    expect(() =>
      compareChangeTrials([
        { ...trial, mode: 'control' },
        { ...trial, mode: 'control' },
      ]),
    ).toThrow('Duplicate');
  });

  it('fingerprints source bytes and rejects deleted policy even when behavior passes', () => {
    const root = fixture('shared-rule');
    const before = directoryDigest(root);
    applyReferencePatch(root, 'shared-rule');
    expect(directoryDigest(root)).not.toBe(before);
    rmSync(join(root, '.scipquery.json'));
    expect(
      evaluateChange(root, 'shared-rule', 'initial').obligations.find(
        (item: { id: string }) => item.id === 'preserved:.scipquery.json',
      )?.pass,
    ).toBe(false);
  });
});
