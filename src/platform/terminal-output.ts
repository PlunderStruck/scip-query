const REPLACEMENT_CHARACTER = '\uFFFD';
const CONTROL_PICTURES = new Map<number, string>([
  [0x08, '\u2408'],
  [0x09, '\u2409'],
  [0x0a, '\u2424'],
  [0x0d, '\u240D'],
]);

export interface TerminalSanitizationOptions {
  allowNewlines?: boolean;
  allowTabs?: boolean;
}

/**
 * Make an untrusted string inert in a human terminal.
 *
 * Escape-driven terminal protocols are removed as complete units. Remaining
 * C0/C1 and bidirectional formatting controls become visible replacement
 * characters, except for explicitly permitted line feeds and tabs.
 */
export function sanitizeTerminalText(value: string, opts: TerminalSanitizationOptions = {}): string {
  const allowNewlines = opts.allowNewlines ?? true;
  const allowTabs = opts.allowTabs ?? true;
  let output = '';

  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      index = consumeEscapeSequence(value, index);
      continue;
    }
    if (code === 0x9b) {
      index = consumeControlSequence(value, index + 1);
      continue;
    }
    if (code === 0x90 || code === 0x98 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = consumeControlString(value, index + 1);
      continue;
    }
    if (isTerminalControl(code)) {
      if (code === 0x0a && allowNewlines) output += '\n';
      else if (code === 0x09 && allowTabs) output += '\t';
      else output += CONTROL_PICTURES.get(code) ?? REPLACEMENT_CHARACTER;
      index += 1;
      continue;
    }
    if (isBidirectionalFormattingControl(code)) {
      output += REPLACEMENT_CHARACTER;
      index += 1;
      continue;
    }
    output += value[index];
    index += 1;
  }

  return output;
}

/** Render one logical row without allowing embedded line or tab structure. */
export function sanitizeTerminalLine(value: string): string {
  return sanitizeTerminalText(value, { allowNewlines: false, allowTabs: false });
}

/**
 * Write already-serialized JSON without human-display rewriting.
 * JSON escaping is the control boundary; preserving its bytes preserves data.
 */
export function writeSerializedJson(
  serialized: string,
  write: (value: string) => void = (value) => process.stdout.write(value),
): void {
  write(`${serialized}\n`);
}

interface TerminalConsole {
  log(...values: unknown[]): void;
  error(...values: unknown[]): void;
  warn(...values: unknown[]): void;
}

/**
 * Install the final human-output backstop for console-based CLI rendering.
 * The returned function restores the exact prior methods for test isolation.
 */
export function installTerminalConsoleSanitizer(target: TerminalConsole = console): () => void {
  const original = {
    log: target.log.bind(target),
    error: target.error.bind(target),
    warn: target.warn.bind(target),
  };
  target.log = (...values: unknown[]) => original.log(...values.map(sanitizeConsoleValue));
  target.error = (...values: unknown[]) => original.error(...values.map(sanitizeConsoleValue));
  target.warn = (...values: unknown[]) => original.warn(...values.map(sanitizeConsoleValue));
  return () => {
    target.log = original.log;
    target.error = original.error;
    target.warn = original.warn;
  };
}

function sanitizeConsoleValue(value: unknown): unknown {
  return typeof value === 'string' ? sanitizeTerminalText(value) : value;
}

function consumeEscapeSequence(value: string, escapeIndex: number): number {
  const introducer = value.charCodeAt(escapeIndex + 1);
  if (Number.isNaN(introducer)) return value.length;
  if (introducer === 0x5b) return consumeControlSequence(value, escapeIndex + 2);
  if (introducer === 0x50 || introducer === 0x58 || introducer === 0x5d || introducer === 0x5e || introducer === 0x5f) {
    return consumeControlString(value, escapeIndex + 2);
  }

  let index = escapeIndex + 1;
  while (index < value.length && isEscapeIntermediate(value.charCodeAt(index))) index += 1;
  return index < value.length && isEscapeFinal(value.charCodeAt(index)) ? index + 1 : escapeIndex + 1;
}

function consumeControlSequence(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return value.length;
}

function consumeControlString(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x07 || code === 0x9c) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    index += 1;
  }
  return value.length;
}

function isEscapeIntermediate(code: number): boolean {
  return code >= 0x20 && code <= 0x2f;
}

function isEscapeFinal(code: number): boolean {
  return code >= 0x30 && code <= 0x7e;
}

function isTerminalControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function isBidirectionalFormattingControl(code: number): boolean {
  return (
    code === 0x061c ||
    code === 0x200e ||
    code === 0x200f ||
    (code >= 0x202a && code <= 0x202e) ||
    (code >= 0x2066 && code <= 0x2069)
  );
}
