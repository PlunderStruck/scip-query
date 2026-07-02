export type LayerPolicyVerdict = 'ok' | 'violation';

const SRC_LAYER_DEPENDENCIES: Record<string, ReadonlySet<string>> = {
  analysis: new Set(['domain', 'source', 'storage', 'symbols']),
  core: new Set(['analysis', 'domain', 'resolution', 'source', 'storage', 'symbols']),
  domain: new Set([]),
  instrumentation: new Set([]),
  'language-parsers': new Set(['core', 'domain', 'resolution', 'source', 'storage']),
  queries: new Set([
    'analysis',
    'core',
    'domain',
    'language-parsers',
    'resolution',
    'semantic',
    'source',
    'storage',
    'symbols',
  ]),
  reindex: new Set(['domain', 'language-parsers', 'resolution', 'runtime', 'semantic', 'source', 'storage', 'symbols']),
  resolution: new Set(['domain', 'source', 'storage', 'symbols']),
  runtime: new Set([
    'core',
    'domain',
    'queries',
    'reindex',
    'resolution',
    'semantic',
    'source',
    'storage',
    'symbols',
    'tla',
  ]),
  semantic: new Set(['core', 'domain', 'resolution', 'storage', 'symbols']),
  // `core` depends on `source` (production-callables.ts reads source-text.js), so this
  // is a deliberate two-way edge for one zero-dependency primitive (escapeRegex,
  // src/core/regex-utils.ts) that source-stripper.ts itself needs — not a real cycle
  // at the file-import level, only at the coarse layer-policy level.
  source: new Set(['core', 'domain', 'storage']),
  storage: new Set(['domain', 'source']),
  symbols: new Set(['analysis', 'domain', 'language-parsers', 'resolution', 'semantic', 'source', 'storage']),
  tla: new Set(['core', 'domain', 'queries', 'source', 'storage', 'symbols']),
};

export function getArchitecturalLayer(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);

  if (parts.length <= 1) {
    return '(root)';
  }

  if (parts.length >= 3 && ['src', 'lib', 'app', 'server', 'client'].includes(parts[0]!)) {
    return `${parts[0]!}/${parts[1]!}`;
  }

  return parts[0]!;
}

export function layerPolicyForEdge(fromLayer: string, toLayer: string): LayerPolicyVerdict | null {
  if (fromLayer === toLayer) return 'ok';

  const fromSrc = srcLayerName(fromLayer);
  const toSrc = srcLayerName(toLayer);
  if (fromSrc && toSrc) {
    if (!isKnownSrcLayer(fromSrc) || !isKnownSrcLayer(toSrc)) return null;
    return isAllowedSrcLayerDependency(fromSrc, toSrc) ? 'ok' : 'violation';
  }

  return genericLayerPolicy(fromLayer, toLayer);
}

export function isKnownProjectLayerDependency(filePath: string, depPath: string): boolean {
  const fromSrc = srcLayerName(getArchitecturalLayer(filePath));
  const toSrc = srcLayerName(getArchitecturalLayer(depPath));
  return !!fromSrc && !!toSrc && isKnownSrcLayer(fromSrc) && isKnownSrcLayer(toSrc);
}

export function isUnknownSrcLayerEdge(fromLayer: string, toLayer: string): boolean {
  const fromSrc = srcLayerName(fromLayer);
  const toSrc = srcLayerName(toLayer);
  return !!fromSrc && !!toSrc && (!isKnownSrcLayer(fromSrc) || !isKnownSrcLayer(toSrc));
}

function srcLayerName(layer: string): string | null {
  const match = /^src\/([^/]+)$/.exec(layer);
  return match?.[1] ?? null;
}

function isAllowedSrcLayerDependency(from: string, to: string): boolean {
  if (to === 'instrumentation') return true;
  if (to === 'domain') return true;
  if (from === 'domain') return false;
  return SRC_LAYER_DEPENDENCIES[from]?.has(to) ?? false;
}

function isKnownSrcLayer(layer: string): boolean {
  return Object.hasOwn(SRC_LAYER_DEPENDENCIES, layer);
}

/** Sorted layer names with an explicit policy row — the coverage regression
 *  test compares this against the actual src/ directory listing so a new
 *  top-level directory can never silently default to "violation" again. */
export function knownSrcLayers(): string[] {
  return Object.keys(SRC_LAYER_DEPENDENCIES).sort();
}

function genericLayerPolicy(fromLayer: string, toLayer: string): LayerPolicyVerdict | null {
  if (toLayer === 'shared') return 'ok';

  const allowed: Record<string, ReadonlySet<string>> = {
    app: new Set(['core', 'shared', 'ui']),
    core: new Set(['shared']),
    infra: new Set(['core', 'shared']),
    ui: new Set(['core', 'shared']),
  };

  if (allowed[fromLayer]) {
    return allowed[fromLayer].has(toLayer) ? 'ok' : 'violation';
  }
  return null;
}
