import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ReadStream, WriteStream } from 'node:tty';
import {
  initialSetupWizardState,
  promptSetupChecklist,
  updateSetupWizardState,
  type SetupWizardChoice,
} from '../../src/runtime/setup-wizard.js';

const choices: SetupWizardChoice[] = [
  { id: 'typescript', scope: 'project', label: 'TypeScript', reason: 'detected', selected: true },
  { id: 'health', scope: 'analysis', label: 'Full health audit', reason: 'optional', selected: false },
];

describe('setup wizard state', () => {
  it('starts with recommended choices selected', () => {
    expect([...initialSetupWizardState(choices).selected]).toEqual(['typescript']);
  });

  it('wraps navigation and toggles the focused choice', () => {
    let state = initialSetupWizardState(choices);
    state = updateSetupWizardState(state, 'up', choices);
    expect(state.cursor).toBe(1);
    state = updateSetupWizardState(state, 'toggle', choices);
    expect([...state.selected]).toEqual(['typescript', 'health']);
    state = updateSetupWizardState(state, 'down', choices);
    expect(state.cursor).toBe(0);
  });

  it('handles terminal keys and restores raw mode after confirmation', async () => {
    const input = new EventEmitter() as EventEmitter & {
      isRaw: boolean;
      setRawMode(value: boolean): void;
      resume(): void;
      pause(): void;
    };
    input.isRaw = false;
    const rawModes: boolean[] = [];
    input.setRawMode = (value) => {
      input.isRaw = value;
      rawModes.push(value);
    };
    input.resume = () => undefined;
    input.pause = () => undefined;
    const writes: string[] = [];
    const output = {
      write: (value: string) => {
        writes.push(value);
        return true;
      },
    } as unknown as WriteStream;

    const resultPromise = promptSetupChecklist(choices, input as unknown as ReadStream, output);
    input.emit('keypress', '', { name: 'down' });
    input.emit('keypress', '', { name: 'space' });
    input.emit('keypress', '', { name: 'return' });

    await expect(resultPromise).resolves.toEqual(new Set(['typescript', 'health']));
    expect(rawModes).toEqual([true, false]);
    expect(input.listenerCount('keypress')).toBe(0);
    expect(writes).toContain('\u001B[5A');
    expect(writes).not.toContain('\u001B[6A');
  });
});
