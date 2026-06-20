import type { AstLanguage } from './ast-language.js';
import { parse as parseSfc } from '@vue/compiler-sfc';
import { astLanguageFromVueScriptLang } from './vue-sfc.js';

export interface VueScriptBlock {
  body: string;
  startLine: number;
  language: AstLanguage;
}

export function extractVueScriptBlock(source: string): VueScriptBlock | null {
  const parsed = parseSfc(source);
  const preferred = parsed.descriptor.scriptSetup ?? parsed.descriptor.script;
  if (!preferred || preferred.src) return null;
  const language = astLanguageFromVueScriptLang(preferred.lang ?? null);
  if (!language) return null;

  return {
    body: preferred.content,
    startLine: Math.max(0, preferred.loc.start.line - 1),
    language,
  };
}
