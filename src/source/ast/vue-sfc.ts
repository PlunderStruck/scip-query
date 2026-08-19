import { createRequire } from 'node:module';
import { posix } from 'node:path';
import type {
  parse as parseVueSfcCompiler,
  SFCBlock,
  SFCScriptBlock,
  SFCStyleBlock,
  SFCTemplateBlock,
} from '@vue/compiler-sfc';
import type { AstLanguage } from './ast-language.js';
import { getSourceText } from '../primitives/source-text.js';
import type { ScipDatabase } from '../../storage/db.js';
import { createSourceFileCache } from '../../storage/per-db-cache.js';

export type VueSfcBlockKind = 'template' | 'script' | 'style' | 'custom';

export interface VueSfcResolvedBlock {
  kind: VueSfcBlockKind;
  ownerPath: string;
  sourcePath: string;
  external: boolean;
  src?: string;
  attrs: Record<string, string | true>;
  lang: string | null;
  body: string;
  startLine: number;
  endLine: number;
  errors: string[];
}

export interface VueSfcScriptBlock extends VueSfcResolvedBlock {
  kind: 'script';
  setup: boolean;
  astLanguage: AstLanguage | null;
}

export interface VueSfcUnit {
  relativePath: string;
  template: VueSfcResolvedBlock | null;
  scripts: VueSfcScriptBlock[];
  styles: VueSfcResolvedBlock[];
  customBlocks: VueSfcResolvedBlock[];
  errors: string[];
}

const VUE_SFC_UNIT_CACHE = createSourceFileCache<VueSfcUnit>('vue-sfc-units');
type VueSfcCompiler = { parse: typeof parseVueSfcCompiler };
const requireVueSfcCompiler = createRequire(import.meta.url);
let loadedVueSfcCompiler: VueSfcCompiler | undefined;

function vueSfcCompiler(): VueSfcCompiler {
  return (loadedVueSfcCompiler ??= requireVueSfcCompiler('@vue/compiler-sfc') as VueSfcCompiler);
}

export function parseVueSfc(...args: Parameters<VueSfcCompiler['parse']>): ReturnType<VueSfcCompiler['parse']> {
  return vueSfcCompiler().parse(...args);
}

export function getVueSfcUnit(db: ScipDatabase, relativePath: string): VueSfcUnit {
  const normalized = normalizeProjectPath(relativePath);
  const source = getSourceText(db, normalized);
  return VUE_SFC_UNIT_CACHE.get(db, normalized, source, () => buildVueSfcUnit(db, normalized, source));
}

export function normalizeProjectPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function astLanguageFromVueScriptLang(lang: string | null): AstLanguage | null {
  const normalized = lang?.toLowerCase();
  if (!normalized || normalized === 'js' || normalized === 'javascript' || normalized === 'jsx') {
    return 'javascript';
  }
  if (normalized === 'ts' || normalized === 'typescript') return 'typescript';
  if (normalized === 'tsx') return 'tsx';
  return null;
}

export function vueBlockLineCount(block: VueSfcResolvedBlock | null | undefined): number {
  if (!block || block.body.length === 0) return 0;
  return block.body.split('\n').length;
}

export function buildVueSfcUnit(db: ScipDatabase, relativePath: string, source: string): VueSfcUnit {
  const unit: VueSfcUnit = {
    relativePath,
    template: null,
    scripts: [],
    styles: [],
    customBlocks: [],
    errors: [],
  };
  if (!source) return unit;

  let parsed: ReturnType<typeof parseVueSfc>;
  try {
    parsed = parseVueSfc(source, { filename: relativePath });
  } catch (error) {
    unit.errors.push(errorMessage(error));
    return unit;
  }

  unit.errors.push(...parsed.errors.map(errorMessage));
  const { descriptor } = parsed;
  if (descriptor.template) {
    unit.template = resolveBlock(db, relativePath, 'template', descriptor.template);
  }
  if (descriptor.script) {
    unit.scripts.push(resolveScriptBlock(db, relativePath, descriptor.script, false));
  }
  if (descriptor.scriptSetup) {
    unit.scripts.push(resolveScriptBlock(db, relativePath, descriptor.scriptSetup, true));
  }
  unit.styles = descriptor.styles.map((style) => resolveBlock(db, relativePath, 'style', style));
  unit.customBlocks = descriptor.customBlocks.map((block) => resolveBlock(db, relativePath, 'custom', block));
  unit.errors.push(
    ...[unit.template, ...unit.scripts, ...unit.styles, ...unit.customBlocks].flatMap((block) => block?.errors ?? []),
  );
  return unit;
}

function resolveScriptBlock(
  db: ScipDatabase,
  ownerPath: string,
  block: SFCScriptBlock,
  setup: boolean,
): VueSfcScriptBlock {
  const resolved = resolveBlock(db, ownerPath, 'script', block);
  return {
    ...resolved,
    kind: 'script',
    setup,
    astLanguage: astLanguageFromVueScriptLang(resolved.lang),
  };
}

function resolveBlock(
  db: ScipDatabase,
  ownerPath: string,
  kind: VueSfcBlockKind,
  block: SFCBlock | SFCScriptBlock | SFCStyleBlock | SFCTemplateBlock,
): VueSfcResolvedBlock {
  const attrs = cloneAttrs(block.attrs);
  const lang = typeof attrs['lang'] === 'string' ? attrs['lang'] : null;
  const src = typeof attrs['src'] === 'string' ? attrs['src'] : typeof block.src === 'string' ? block.src : undefined;
  if (src) {
    const resolvedPath = resolveVueBlockSourcePath(ownerPath, src);
    if (!resolvedPath) {
      return {
        kind,
        ownerPath,
        sourcePath: ownerPath,
        external: true,
        src,
        attrs,
        lang,
        body: '',
        startLine: 0,
        endLine: 0,
        errors: [`Could not resolve Vue ${kind} block source: ${src}`],
      };
    }
    const body = getSourceText(db, resolvedPath);
    const endLine = body ? Math.max(0, body.split('\n').length - 1) : 0;
    return {
      kind,
      ownerPath,
      sourcePath: resolvedPath,
      external: true,
      src,
      attrs,
      lang,
      body,
      startLine: 0,
      endLine,
      errors: body ? [] : [`Vue ${kind} block source not found: ${resolvedPath}`],
    };
  }

  const startLine = Math.max(0, block.loc.start.line - 1);
  return {
    kind,
    ownerPath,
    sourcePath: ownerPath,
    external: false,
    attrs,
    lang,
    body: block.content,
    startLine,
    endLine: Math.max(startLine, block.loc.end.line - 1),
    errors: [],
  };
}

function resolveVueBlockSourcePath(ownerPath: string, src: string): string | null {
  const clean = src.split(/[?#]/, 1)[0];
  if (!clean || clean.startsWith('/') || clean.includes('://')) return null;
  const resolved = normalizeProjectPath(posix.normalize(posix.join(posix.dirname(ownerPath), clean)));
  if (resolved === '..' || resolved.startsWith('../')) return null;
  return resolved;
}

function cloneAttrs(attrs: Record<string, string | true>): Record<string, string | true> {
  return { ...attrs };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
