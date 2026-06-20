import type { ScipDatabase } from '../storage/db.js';
import { getSourceFiles } from './source-fileset.js';
import { getSourceLines } from './source-text.js';
import type { VueTemplateFacts } from './vue-template.js';
import { getVueTemplateFacts } from './vue-template.js';
import type { VueScriptFacts } from './vue-script-facts.js';
import { buildVueScriptFacts } from './vue-script-facts.js';
import type { VueSfcUnit } from './vue-sfc.js';
import { getVueSfcUnit, vueBlockLineCount } from './vue-sfc.js';

export interface VueComponentBehaviorProfile {
  file: string;
  sfc: VueSfcUnit;
  templateFacts: VueTemplateFacts;
  scriptFacts: VueScriptFacts;
  templateTokens: Set<string>;
  behaviorTokens: Set<string>;
  templateBindingNames: string[];
  templateLocalNames: string[];
  componentNames: string[];
  sfcLines: number;
  totalLines: number;
  templateLines: number;
  scriptLines: number;
  styleLines: number;
  externalScriptLines: number;
  externalScriptPaths: string[];
  customBlockLines: number;
}

export interface VueComponentProfileOptions {
  scope?: string;
  minTemplateTokens?: number;
  minBehaviorTokens?: number;
  scanLimit?: number;
}

const TEMPLATE_LOCAL_STOP_WORDS = new Set(['in', 'key', 'of']);
const BEHAVIOR_FUNCTION_STOP_WORDS = new Set([
  'computed',
  'defineEmits',
  'defineProps',
  'reactive',
  'ref',
  'watch',
  'watchEffect',
]);

export function buildVueComponentBehaviorProfiles(
  db: ScipDatabase,
  opts: VueComponentProfileOptions = {},
): VueComponentBehaviorProfile[] {
  const files = getSourceFiles(db, { extensions: ['.vue'] })
    .filter((file) => !opts.scope || file.includes(opts.scope))
    .sort();
  const limitedFiles = typeof opts.scanLimit === 'number' && opts.scanLimit > 0
    ? files.slice(0, opts.scanLimit)
    : files;

  return limitedFiles
    .map((file) => buildVueComponentBehaviorProfile(db, file))
    .filter((profile) =>
      (opts.minTemplateTokens === undefined || profile.templateTokens.size >= opts.minTemplateTokens)
      && (opts.minBehaviorTokens === undefined || profile.behaviorTokens.size >= opts.minBehaviorTokens));
}

export function buildVueComponentBehaviorProfile(
  db: ScipDatabase,
  relativePath: string,
): VueComponentBehaviorProfile {
  const file = relativePath.replace(/\\/g, '/');
  const sfc = getVueSfcUnit(db, file);
  const templateFacts = getVueTemplateFacts(db, file);
  const scriptFacts = buildVueScriptFacts(sfc);
  const templateLocalNames = templateLocalIdentifiers(templateFacts);
  const templateBindingNames = templateFacts.expressionIdentifiers
    .map((identifier) => identifier.name)
    .filter((name) => !templateLocalNames.includes(name))
    .filter((name, index, arr) => arr.indexOf(name) === index)
    .sort();
  const componentNames = templateFacts.componentTags
    .map((tag) => tag.normalized)
    .filter((name, index, arr) => arr.indexOf(name) === index)
    .sort();
  const sfcLines = getSourceLines(db, file).length;
  const templateLines = vueBlockLineCount(sfc.template);
  const scriptLines = scriptFacts.lineCount;
  const styleLines = sfc.styles.reduce((sum, block) => sum + vueBlockLineCount(block), 0);
  const customBlockLines = sfc.customBlocks.reduce((sum, block) => sum + vueBlockLineCount(block), 0);

  return {
    file,
    sfc,
    templateFacts,
    scriptFacts,
    templateTokens: new Set(templateFacts.structuralTokens),
    behaviorTokens: buildBehaviorTokens(templateFacts, scriptFacts, templateBindingNames),
    templateBindingNames,
    templateLocalNames,
    componentNames,
    sfcLines,
    totalLines: sfcLines + scriptFacts.externalLineCount,
    templateLines,
    scriptLines,
    styleLines,
    externalScriptLines: scriptFacts.externalLineCount,
    externalScriptPaths: scriptFacts.externalScriptPaths,
    customBlockLines,
  };
}

function buildBehaviorTokens(
  templateFacts: VueTemplateFacts,
  scriptFacts: VueScriptFacts,
  templateBindingNames: readonly string[],
): Set<string> {
  const tokens = new Set<string>();
  for (const name of scriptFacts.composables) tokens.add(`composable:${name}`);
  for (const name of scriptFacts.stores) tokens.add(`store:${name}`);
  for (const name of scriptFacts.reactivity) tokens.add(`reactivity:${name}`);
  for (const name of scriptFacts.lifecycle) tokens.add(`lifecycle:${name}`);
  for (const name of scriptFacts.requests) tokens.add(`request:${name}`);
  for (const name of scriptFacts.macros) tokens.add(`macro:${name}`);
  for (const fn of scriptFacts.functions) {
    if (BEHAVIOR_FUNCTION_STOP_WORDS.has(fn.name)) continue;
    tokens.add(`function:${fn.name}`);
    const verb = /^[a-z]+/.exec(fn.name)?.[0] ?? null;
    if (verb && verb.length > 2 && verb !== fn.name) tokens.add(`function-verb:${verb}`);
  }
  for (const event of templateFacts.events) tokens.add(`template-event:${event.name}`);
  for (const binding of templateBindingNames) tokens.add(`template-binding:${binding}`);
  return tokens;
}

function templateLocalIdentifiers(facts: VueTemplateFacts): string[] {
  const locals = new Set<string>();
  for (const directive of facts.directives) {
    if (directive.name === 'for' && directive.value) {
      for (const name of vForLocalNames(directive.value)) locals.add(name);
    }
  }
  for (const slot of facts.slots) {
    if (!slot.value) continue;
    for (const name of identifiersInPattern(slot.value)) locals.add(name);
  }
  return [...locals].sort();
}

function vForLocalNames(expression: string): string[] {
  const match = /^(.*?)\s+(?:in|of)\s+/.exec(expression.trim());
  if (!match) return [];
  return identifiersInPattern(match[1] ?? '');
}

function identifiersInPattern(pattern: string): string[] {
  const names: string[] = [];
  for (const match of pattern.matchAll(/\b[A-Za-z_$][\w$]*\b/g)) {
    const name = match[0];
    if (!TEMPLATE_LOCAL_STOP_WORDS.has(name)) names.push(name);
  }
  return names;
}
