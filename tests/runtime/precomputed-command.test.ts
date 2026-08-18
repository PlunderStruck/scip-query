import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ObservationReceiptV2 } from '../../src/runtime/observation-receipt.js';
import { precomputedSectionedReportCommand } from '../../src/runtime/command-kit/command-execution.js';

describe('precomputed command execution', () => {
  afterEach(() => vi.restoreAllMocks());

  it('renders the precomputed result without invoking the database fallback', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const fallback = vi.fn();
    const resolve = vi.fn(() => ({
      result: { matchingLines: 3 },
      generationIdentity: 'generation-a',
      observationReceipt: {} as ObservationReceiptV2,
    }));
    const handler = precomputedSectionedReportCommand(
      { commandName: 'precomputed-test', sections: () => [] },
      resolve,
      fallback,
    );

    handler('needle', { json: true, resultOnly: true, compact: true });

    expect(resolve).toHaveBeenCalledWith({
      args: ['needle'],
      opts: { json: true, resultOnly: true, compact: true },
    });
    expect(fallback).not.toHaveBeenCalled();
    expect(write).toHaveBeenCalledWith('{"matchingLines":3}\n');
  });

  it('delegates the unchanged invocation when no precomputed result is available', () => {
    const fallback = vi.fn();
    const options = { json: true };
    const handler = precomputedSectionedReportCommand(
      { commandName: 'precomputed-test', sections: () => [] },
      () => null,
      fallback,
    );

    handler('needle', options);

    expect(fallback).toHaveBeenCalledWith('needle', options);
  });
});
