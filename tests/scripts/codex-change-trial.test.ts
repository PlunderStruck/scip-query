import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { runChangeTrial } from '../../scripts/codex-change-trial.mjs';

describe.skipIf(process.platform === 'win32')('Codex change trial execution', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  function environment(body: string) {
    const root = mkdtempSync(join(tmpdir(), 'codex-change-test-'));
    roots.push(root);
    const tool = join(root, 'tool');
    mkdirSync(tool);
    const cli = join(tool, 'cli.js');
    writeFileSync(cli, '// Tool fingerprint fixture.\n');
    const codex = join(root, 'codex');
    writeFileSync(
      codex,
      `#!${process.execPath}\nif (process.argv.includes('--version')) { console.log('test-codex'); process.exit(0); }\n${body}\n`,
    );
    chmodSync(codex, 0o755);
    return {
      output: join(root, 'result'),
      cli,
      codex,
      task: 'shared-rule',
      mode: 'control',
      model: 'gpt-5.6-sol',
      reasoning: 'medium',
    };
  }
  it('grades source instead of a claimed successful answer, captures usage, and removes private worktrees', async () => {
    const options = environment(
      `console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Everything is correct.'}}));\nconsole.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,cached_input_tokens:2,output_tokens:3,reasoning_output_tokens:1}}));`,
    );
    const result = await runChangeTrial(options);
    expect(result.status).toBe('completed');
    expect(result.phases).toHaveLength(2);
    expect(result.phases.every((phase: { evaluation: { pass: boolean } }) => !phase.evaluation.pass)).toBe(true);
    expect(result.phases[0].execution.usage.inputTokens).toBe(10);
    expect(result.model).toBe('gpt-5.6-sol');
    expect(result.reasoning).toBe('medium');
    expect(result.isolation.cleaned).toBe(true);
    expect(existsSync(result.isolation.repository)).toBe(false);
    expect(existsSync(result.isolation.sourceRepository)).toBe(false);
    expect(readFileSync(join(options.output, 'initial/agent.jsonl'), 'utf8')).toContain('Everything is correct');
    expect(existsSync(join(options.output, 'initial/source/index.ts'))).toBe(true);
    await expect(runChangeTrial(options)).rejects.toThrow('overwrite');
  }, 30_000);
  it('keeps failed executions and their raw logs visible', async () => {
    const options = environment("console.error('deliberate runner failure'); process.exit(7);");
    const result = await runChangeTrial(options);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('exited 7');
    expect(result.isolation.cleaned).toBe(true);
    expect(readFileSync(join(options.output, 'initial/agent.stderr.log'), 'utf8')).toContain(
      'deliberate runner failure',
    );
    expect(JSON.parse(readFileSync(join(options.output, 'trial.json'), 'utf8')).status).toBe('failed');
  }, 30_000);
  it('terminates an overdue model process without dropping the failed trial', async () => {
    const options = environment('setInterval(() => {}, 10000);');
    const result = await runChangeTrial({ ...options, timeoutMs: 200 });
    expect(result.status).toBe('failed');
    expect(result.error).toContain('timedOut=true');
    expect(result.isolation.cleaned).toBe(true);
  }, 30_000);
});
