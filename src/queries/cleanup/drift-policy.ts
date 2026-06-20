export type LayerPolicyVerdict = 'ok' | 'violation';

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
    return isAllowedSrcLayerDependency(fromSrc, toSrc) ? 'ok' : 'violation';
  }

  return genericLayerPolicy(fromLayer, toLayer);
}

export function isKnownProjectLayerDependency(filePath: string, depPath: string): boolean {
  const fromSrc = srcLayerName(getArchitecturalLayer(filePath));
  const toSrc = srcLayerName(getArchitecturalLayer(depPath));
  return !!fromSrc && !!toSrc;
}

function srcLayerName(layer: string): string | null {
  const match = /^src\/([^/]+)$/.exec(layer);
  return match?.[1] ?? null;
}

function isAllowedSrcLayerDependency(from: string, to: string): boolean {
  if (to === 'domain') return true;
  if (from === 'domain') return false;

  const allowed: Record<string, ReadonlySet<string>> = {
    analysis: new Set(['domain', 'source', 'storage', 'symbols']),
    core: new Set(['analysis', 'domain', 'resolution', 'source', 'storage', 'symbols']),
    'language-parsers': new Set(['domain', 'resolution', 'source', 'storage']),
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
    reindex: new Set([
      'domain',
      'language-parsers',
      'resolution',
      'runtime',
      'semantic',
      'source',
      'storage',
      'symbols',
    ]),
    resolution: new Set(['domain', 'source', 'storage', 'symbols']),
    runtime: new Set(['domain', 'queries', 'reindex', 'resolution', 'semantic', 'source', 'storage', 'symbols']),
    semantic: new Set(['domain', 'resolution', 'storage', 'symbols']),
    source: new Set(['domain', 'storage']),
    storage: new Set(['domain', 'source']),
    symbols: new Set(['analysis', 'domain', 'language-parsers', 'resolution', 'semantic', 'source', 'storage']),
  };

  return allowed[from]?.has(to) ?? false;
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
