export const FRONTEND_IDENTIFIER_STOP_WORDS = new Set([
  'children',
  'className',
  'data',
  'e',
  'err',
  'error',
  'ev',
  'event',
  'false',
  'id',
  'idx',
  'index',
  'item',
  'key',
  'null',
  'props',
  'res',
  'result',
  'state',
  'style',
  'true',
  'undefined',
  'val',
  'value',
]);

export function isFrontendIdentifierStopWord(name: string): boolean {
  return name.length <= 2 || FRONTEND_IDENTIFIER_STOP_WORDS.has(name);
}
