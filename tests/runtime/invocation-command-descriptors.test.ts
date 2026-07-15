import { describe, expect, it } from 'vitest';
import {
  directNavigationCommandEligible,
  loadInvocationCommandDescriptors,
} from '../../src/runtime/commands/invocation-command-descriptors.js';

describe('invocation command descriptors', () => {
  it('loads one independently-backed descriptor for direct navigation commands', async () => {
    for (const commandName of ['code', 'outline', 'refs']) {
      expect(directNavigationCommandEligible(commandName)).toBe(true);
      await expect(loadInvocationCommandDescriptors(commandName)).resolves.toEqual([
        expect.objectContaining({ id: commandName }),
      ]);
    }
  });

  it('keeps the complete catalog for help, unknown commands, and library imports', async () => {
    expect(directNavigationCommandEligible('--help')).toBe(false);
    expect(directNavigationCommandEligible(undefined)).toBe(false);
    const descriptors = await loadInvocationCommandDescriptors('--help');
    expect(descriptors.length).toBeGreaterThan(3);
    expect(descriptors.map((descriptor) => descriptor.id)).toEqual(expect.arrayContaining(['code', 'outline', 'refs']));
  });
});
