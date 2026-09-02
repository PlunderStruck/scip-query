import type { ScipDatabase } from '../../storage/db.js';
import { getSourceLines, suppressionCommentCategory } from '../../source/primitives/source-text.js';

export interface BoundaryEvidenceSurface {
  label: string;
  value: string | null | undefined;
  /**
   * Which side of the relationship the surface describes. A token present on
   * both sides (`toBaseRate` forwarding to `parseBaseRate`; a wrapper and its
   * caller both under `lib/auth/`) is the vocabulary the two share, not a
   * boundary between them, so once every surface names a side only the
   * asymmetric tokens count.
   */
  side?: 'self' | 'other';
}

export function boundaryEvidenceForSurfaces(
  db: ScipDatabase,
  relativePath: string,
  startLine: number,
  ignoreCategory: string,
  ignoreLabel: string,
  surfaces: readonly BoundaryEvidenceSurface[],
): string[] {
  const evidence = new Set<string>();
  if (hasCleanupIgnoreComment(db, relativePath, startLine, ignoreCategory)) {
    evidence.add(ignoreLabel);
  }
  const shared = sharedBoundaryTokens(surfaces);
  for (const surface of surfaces) {
    if (!surface.value) continue;
    collectBoundaryTokenEvidence(evidence, surface.label, surface.value, shared);
  }
  return [...evidence].slice(0, 6);
}

/** Tokens that occur on both sides of a sided surface set; empty when a side is unnamed. */
function sharedBoundaryTokens(surfaces: readonly BoundaryEvidenceSurface[]): Set<string> {
  const bySide = { self: new Set<string>(), other: new Set<string>() };
  let sided = 0;
  for (const surface of surfaces) {
    if (!surface.side || !surface.value) continue;
    sided += 1;
    for (const token of boundaryTokens(surface.value)) bySide[surface.side].add(token);
  }
  if (sided === 0 || bySide.self.size === 0 || bySide.other.size === 0) return new Set();
  return new Set([...bySide.self].filter((token) => bySide.other.has(token)));
}

function collectBoundaryTokenEvidence(
  evidence: Set<string>,
  surface: string,
  value: string,
  shared: ReadonlySet<string>,
): void {
  const tokens = boundaryTokens(value);
  if (surface.endsWith('name') && hasTypeGuardBoundaryShape(tokens)) {
    evidence.add(`${surface} has type-guard boundary shape`);
  }
  for (const token of tokens) {
    if (shared.has(token)) continue;
    const label = BOUNDARY_TOKEN_LABELS.get(token);
    if (!label) continue;
    evidence.add(`${surface} has ${label} term: ${token}`);
  }
}

function hasCleanupIgnoreComment(db: ScipDatabase, relativePath: string, startLine: number, category: string): boolean {
  if (startLine <= 0) return false;
  const lines = getSourceLines(db, relativePath);
  if (lines.length === 0) return false;

  for (let i = startLine - 1; i >= 0 && i >= startLine - 5; i -= 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    if (suppressionCommentCategory(line) === category) return true;
    if (
      !line.startsWith('//') &&
      !line.startsWith('*') &&
      !line.startsWith('/*') &&
      !line.startsWith('@') &&
      !line.startsWith('#')
    ) {
      return false;
    }
  }
  return false;
}

function boundaryTokens(value: string): string[] {
  return value
    .replace(/([A-Z])([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function hasTypeGuardBoundaryShape(tokens: string[]): boolean {
  return (
    tokens.some((token) => TYPE_GUARD_PREFIX_TOKENS.has(token)) &&
    tokens.some((token) => TYPE_GUARD_BOUNDARY_TOKENS.has(token))
  );
}

const BOUNDARY_TOKEN_LABELS = new Map([
  ['access', 'access policy'],
  ['accessible', 'access policy'],
  ['adapter', 'adapter'],
  ['adapters', 'adapter'],
  ['allow', 'access policy'],
  ['allowed', 'access policy'],
  ['animation', 'animation calculation'],
  ['api', 'api surface'],
  ['apply', 'settings/application'],
  ['audit', 'side-effect boundary'],
  ['auth', 'authorization'],
  ['authorize', 'authorization'],
  ['audio', 'audio side-effect'],
  ['can', 'access policy'],
  ['capabilities', 'capability boundary'],
  ['capability', 'capability boundary'],
  ['boundary', 'boundary'],
  ['begin', 'lifecycle'],
  ['bridge', 'bridge'],
  ['bridges', 'bridge'],
  ['cache', 'state cache'],
  ['chase', 'gameplay action'],
  ['command', 'command boundary'],
  ['context', 'context policy'],
  ['cooldown', 'temporal state'],
  ['cooldowns', 'temporal state'],
  ['controller', 'controller'],
  ['controllers', 'controller'],
  ['diagnostic', 'diagnostics'],
  ['diagnostics', 'diagnostics'],
  ['effect', 'side-effect boundary'],
  ['effects', 'side-effect boundary'],
  ['energy', 'gameplay calculation'],
  ['expired', 'temporal state'],
  ['facade', 'facade'],
  ['facades', 'facade'],
  ['fire', 'gameplay action'],
  ['gateway', 'gateway'],
  ['gateways', 'gateway'],
  ['guard', 'guard'],
  ['guards', 'guard'],
  ['haptic', 'haptic side-effect'],
  ['haptics', 'haptic side-effect'],
  ['head', 'sequence boundary'],
  ['history', 'state history'],
  ['input', 'input boundary'],
  ['jump', 'gameplay action'],
  ['keyboard', 'input boundary'],
  ['log', 'side-effect boundary'],
  ['logger', 'side-effect boundary'],
  ['lock', 'coordination boundary'],
  ['middleware', 'middleware'],
  ['multiplier', 'gameplay calculation'],
  ['mute', 'audio side-effect'],
  ['normalize', 'normalization'],
  ['normalise', 'normalization'],
  ['normalizer', 'normalization'],
  ['oscillate', 'animation calculation'],
  ['oscillation', 'animation calculation'],
  ['overlap', 'collision predicate'],
  ['performance', 'diagnostics'],
  ['permission', 'access policy'],
  ['permissions', 'access policy'],
  ['policy', 'policy'],
  ['pool', 'state pool'],
  ['pooled', 'state pool'],
  ['pools', 'state pool'],
  ['predict', 'prediction'],
  ['presenter', 'presenter'],
  ['presenters', 'presenter'],
  ['projectile', 'gameplay entity'],
  ['provider', 'provider boundary'],
  ['providers', 'provider boundary'],
  ['public', 'public surface'],
  ['quality', 'settings/application'],
  ['rate', 'calculation'],
  ['register', 'registry'],
  ['registry', 'registry'],
  ['relay', 'relay'],
  ['relays', 'relay'],
  ['reseed', 'state lifecycle'],
  ['reset', 'state lifecycle'],
  ['respond', 'response boundary'],
  ['response', 'response boundary'],
  ['resolve', 'resolution'],
  ['resolver', 'resolution'],
  ['route', 'route boundary'],
  ['routes', 'route boundary'],
  ['run', 'lifecycle'],
  ['sample', 'diagnostics'],
  ['score', 'gameplay calculation'],
  ['scope', 'scope policy'],
  ['scroll', 'position state'],
  ['scrolled', 'position state'],
  ['seed', 'state lifecycle'],
  ['seeded', 'state lifecycle'],
  ['segment', 'segment boundary'],
  ['segments', 'segment boundary'],
  ['setting', 'settings/application'],
  ['settings', 'settings/application'],
  ['spawn', 'gameplay lifecycle'],
  ['spawning', 'gameplay lifecycle'],
  ['speed', 'gameplay calculation'],
  ['surface', 'public surface'],
  ['tail', 'sequence boundary'],
  ['tick', 'temporal state'],
  ['transaction', 'transaction'],
  ['transactional', 'transaction'],
  ['transform', 'transformation'],
  ['transformer', 'transformation'],
  ['translate', 'translation'],
  ['translator', 'translation'],
  ['try', 'fallible action'],
  ['validate', 'validation'],
  ['validation', 'validation'],
  ['validator', 'validation'],
  ['visual', 'diagnostics'],
  ['window', 'settings/application'],
  ['socket', 'transport boundary'],
  ['websocket', 'transport boundary'],
]);

const TYPE_GUARD_PREFIX_TOKENS = new Set(['can', 'has', 'is', 'should']);
const TYPE_GUARD_BOUNDARY_TOKENS = new Set([
  'access',
  'api',
  'auth',
  'collision',
  'expired',
  'input',
  'keyboard',
  'overlap',
  'permission',
  'permissions',
  'policy',
  'projectile',
  'response',
  'route',
  'routes',
  'scope',
]);
