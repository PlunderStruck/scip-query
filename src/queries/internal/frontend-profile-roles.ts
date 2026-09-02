/**
 * Frontend profile roles — which structural role a React or Vue source file
 * plays for the duplicate, behavior, and pressure detectors.
 *
 * A profile's role decides whether structural overlap can be product
 * duplication at all:
 *   - `test`: scaffolding copied between test files is fixture reuse, never a
 *     product finding.
 *   - `ui-kit`: vendored design-system primitives are similar by
 *     construction (see `analysis/ui-kit-surface`).
 *   - `framework-route`: files a router discovers by convention share the
 *     framework's scaffolding by design.
 *   - `product`: everything else.
 *
 * Pair contexts refine the verdict for two product-relevant profiles: two
 * route entries, an intercepting route and its target, or two kit files.
 */
import { classifyFile, isFrameworkEntrypointPath } from '../../analysis/file-classifier.js';
import { isInterceptingRoutePair, isNextRouteEntryFile } from '../../analysis/frontend-route-conventions.js';
import { uiKitDirectoryFor } from '../../analysis/ui-kit-surface.js';
import type { ScipDatabase } from '../../storage/db.js';

export type FrontendProfileRole = 'product' | 'test' | 'ui-kit' | 'framework-route';
export type FrontendPairContext = 'product' | 'framework-route-pair' | 'intercepting-route-pair' | 'ui-kit-pair';

export interface FrontendPolicyExclusion {
  /** Stable identifier for the policy that excluded the rows. */
  reason: string;
  /** Reviewer-facing explanation of what was excluded and why. */
  detail: string;
  count: number;
}

export interface FrontendProfileRolePolicy {
  roleOf(file: string): FrontendProfileRole;
  pairContext(fileA: string, fileB: string): FrontendPairContext;
}

export function frontendProfileRolePolicy(db: ScipDatabase): FrontendProfileRolePolicy {
  const roles = new Map<string, FrontendProfileRole>();
  const roleOf = (file: string): FrontendProfileRole => {
    const cached = roles.get(file);
    if (cached) return cached;
    const role = computeRole(db, file);
    roles.set(file, role);
    return role;
  };
  return {
    roleOf,
    pairContext: (fileA, fileB) => {
      const roleA = roleOf(fileA);
      const roleB = roleOf(fileB);
      if (roleA === 'ui-kit' && roleB === 'ui-kit') return 'ui-kit-pair';
      if (fileA !== fileB && isInterceptingRoutePair(fileA, fileB)) return 'intercepting-route-pair';
      if (roleA === 'framework-route' && roleB === 'framework-route' && fileA !== fileB) return 'framework-route-pair';
      return 'product';
    },
  };
}

function computeRole(db: ScipDatabase, file: string): FrontendProfileRole {
  if (classifyFile(file) === 'test') return 'test';
  if (uiKitDirectoryFor(db, file)) return 'ui-kit';
  if (isNextRouteEntryFile(file) || isFrameworkEntrypointPath(file)) return 'framework-route';
  return 'product';
}

/** Accumulates policy exclusions by reason so detectors can disclose them. */
export class FrontendPolicyExclusions {
  private readonly counts = new Map<string, FrontendPolicyExclusion>();

  record(reason: string, detail: string, count = 1): void {
    if (count <= 0) return;
    const existing = this.counts.get(reason);
    if (existing) {
      existing.count += count;
      return;
    }
    this.counts.set(reason, { reason, detail, count });
  }

  list(): FrontendPolicyExclusion[] {
    return [...this.counts.values()].sort((left, right) => left.reason.localeCompare(right.reason));
  }
}

export const FRONTEND_EXCLUSION_DETAILS = {
  testFiles: 'components defined in test files (fixture scaffolding, not product code)',
  uiKitPairs: 'pairs where both components are vendored UI-kit primitives (similar by construction)',
  uiKitFiles: 'components defined in vendored UI-kit directories',
  hookComponentPairs: 'pairs that mix a hook with a component (a hook is already the extraction target)',
} as const;

export function pairContextReason(context: FrontendPairContext): string | null {
  switch (context) {
    case 'framework-route-pair':
      return 'both files are framework route entries; route files share framework scaffolding by design';
    case 'intercepting-route-pair':
      return 'intercepting route and its target route are meant to render the same view';
    case 'ui-kit-pair':
      return 'both files are vendored UI-kit primitives';
    case 'product':
      return null;
  }
}
