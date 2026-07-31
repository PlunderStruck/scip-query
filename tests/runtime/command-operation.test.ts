import { describe, expect, it } from 'vitest';
import {
  commandOperation,
  commandOperationRoles,
  operationObservesRepository,
  resolveCommandOperationRole,
} from '../../src/runtime/command-operation.js';

describe('command operation roles', () => {
  it('selects the first matching parsed-invocation rule and otherwise uses the declared default', () => {
    const selector = commandOperation('mutation', [
      { when: { kind: 'option', name: 'dryRun', equals: true }, role: 'repository-preview' },
      { when: { kind: 'option-present', name: 'profileOut' }, role: 'composite' },
      { when: { kind: 'argument', index: 0, equals: 'inspect' }, role: 'repository-observation' },
    ]);

    expect(resolveCommandOperationRole(selector, { args: [], options: {} })).toBe('mutation');
    expect(resolveCommandOperationRole(selector, { args: [], options: { dryRun: true } })).toBe('repository-preview');
    expect(resolveCommandOperationRole(selector, { args: [], options: { profileOut: 'bench.cpuprofile' } })).toBe(
      'composite',
    );
    expect(resolveCommandOperationRole(selector, { args: ['inspect'], options: {} })).toBe('repository-observation');
    expect(commandOperationRoles(selector)).toEqual([
      'mutation',
      'repository-preview',
      'composite',
      'repository-observation',
    ]);
  });

  it('keeps repository observation independent from mutation and tool/environment information', () => {
    expect(operationObservesRepository('repository-observation')).toBe(true);
    expect(operationObservesRepository('repository-preview')).toBe(true);
    expect(operationObservesRepository('composite')).toBe(true);
    expect(operationObservesRepository('mutation')).toBe(false);
    expect(operationObservesRepository('environment-observation')).toBe(false);
    expect(operationObservesRepository('tool-information')).toBe(false);
  });
});
