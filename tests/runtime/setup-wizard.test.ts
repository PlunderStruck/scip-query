import { describe, expect, it } from 'vitest';
import {
  initialSetupWizardState,
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
});
