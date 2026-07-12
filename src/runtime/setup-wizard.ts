import { emitKeypressEvents } from 'node:readline';
import type { ReadStream, WriteStream } from 'node:tty';

export interface SetupWizardChoice {
  id: string;
  scope: 'project' | 'checkout' | 'user' | 'analysis';
  label: string;
  reason: string;
  selected: boolean;
}

export interface SetupWizardState {
  cursor: number;
  selected: Set<string>;
}

export type SetupWizardKey = 'up' | 'down' | 'toggle';

export function initialSetupWizardState(choices: readonly SetupWizardChoice[]): SetupWizardState {
  return {
    cursor: 0,
    selected: new Set(choices.filter((choice) => choice.selected).map((choice) => choice.id)),
  };
}

export function updateSetupWizardState(
  state: SetupWizardState,
  key: SetupWizardKey,
  choices: readonly SetupWizardChoice[],
): SetupWizardState {
  if (choices.length === 0) return state;
  if (key === 'up') return { ...state, cursor: (state.cursor - 1 + choices.length) % choices.length };
  if (key === 'down') return { ...state, cursor: (state.cursor + 1) % choices.length };
  const id = choices[state.cursor]?.id;
  if (!id) return state;
  const selected = new Set(state.selected);
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  return { ...state, selected };
}

export async function promptSetupChecklist(
  choices: readonly SetupWizardChoice[],
  input: ReadStream = process.stdin,
  output: WriteStream = process.stdout,
): Promise<Set<string>> {
  if (choices.length === 0) return new Set();
  let state = initialSetupWizardState(choices);
  emitKeypressEvents(input);
  const wasRaw = input.isRaw;
  input.setRawMode(true);
  input.resume();

  const render = (first = false): void => {
    if (!first) output.write(`\u001B[${choices.length + 3}A`);
    output.write('scip-query setup\n');
    output.write('Use ↑/↓ to move, space to toggle, enter to start. Ctrl-C cancels.\n\n');
    choices.forEach((choice, index) => {
      const cursor = index === state.cursor ? '›' : ' ';
      const checked = state.selected.has(choice.id) ? '●' : '○';
      output.write(`${cursor} ${checked} ${choice.label} [${choice.scope}]\u001B[K\n`);
    });
    output.write('\u001B[K');
  };

  render(true);
  try {
    return await new Promise<Set<string>>((resolve, reject) => {
      const onKeypress = (_value: string, key: { name?: string; ctrl?: boolean }): void => {
        if (key.ctrl && key.name === 'c') {
          cleanup();
          reject(new Error('Setup cancelled.'));
          return;
        }
        if (key.name === 'return' || key.name === 'enter') {
          cleanup();
          output.write('\n');
          resolve(state.selected);
          return;
        }
        const action = key.name === 'up' ? 'up' : key.name === 'down' ? 'down' : key.name === 'space' ? 'toggle' : null;
        if (!action) return;
        state = updateSetupWizardState(state, action, choices);
        render();
      };
      const cleanup = (): void => {
        input.off('keypress', onKeypress);
      };
      input.on('keypress', onKeypress);
    });
  } finally {
    input.setRawMode(Boolean(wasRaw));
    input.pause();
  }
}
