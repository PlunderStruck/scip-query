import { describe, expect, it } from 'vitest';
import { rustCompilerEngineIdentity, rustSemanticEngineIdentity } from '../../../src/semantic/rust/engine-identity.js';

const SCIP_OCCURRENCE_MODE_ENV = 'SCIP_RUST_SCIP_OCCURRENCE_REFERENCE_MODE';

describe('Rust engine identity roles', () => {
  it('keeps compiler identity independent of SCIP occurrence routing', () => {
    const previousMode = process.env[SCIP_OCCURRENCE_MODE_ENV];
    try {
      process.env[SCIP_OCCURRENCE_MODE_ENV] = 'safe';
      const safe = rustCompilerEngineIdentity(process.cwd());
      process.env[SCIP_OCCURRENCE_MODE_ENV] = 'all';
      const all = rustCompilerEngineIdentity(process.cwd());

      expect(all).toEqual(safe);
      expect(Object.keys(all).sort()).toEqual(['engine', 'resolvedBinary', 'version']);
    } finally {
      restoreEnv(SCIP_OCCURRENCE_MODE_ENV, previousMode);
    }
  });

  it('keeps SCIP occurrence routing in the broader semantic/cache identity', () => {
    const previousMode = process.env[SCIP_OCCURRENCE_MODE_ENV];
    try {
      process.env[SCIP_OCCURRENCE_MODE_ENV] = 'all';
      expect(rustSemanticEngineIdentity(process.cwd()).scipOccurrenceReferenceMode).toBe('all');
    } finally {
      restoreEnv(SCIP_OCCURRENCE_MODE_ENV, previousMode);
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
