import { getIndexerConfig } from '../../reindex/indexers.js';
import { getIndexerDependencyStatus } from '../../reindex/install.js';

// scip-query: ignore-stale — named Rust semantic capability payload rendered
// by status/doctor and used by the provider to report LSP availability.
export interface RustSemanticStatus {
  available: boolean;
  dependencyAvailable: boolean;
  resolvedBinary?: string;
  reason?: string;
}

export function getRustSemanticStatus(projectRoot: string): RustSemanticStatus {
  const status = getIndexerDependencyStatus(getIndexerConfig('rust'), projectRoot);
  const dependencyAvailable = status.runnable;
  return {
    available: dependencyAvailable,
    dependencyAvailable,
    resolvedBinary: status.resolvedBinary ?? undefined,
    reason: dependencyAvailable
      ? 'rust-analyzer semantic reference queries are enabled.'
      : 'rust-analyzer is not runnable; Rust semantic checks will use SCIP/source evidence only.',
  };
}
