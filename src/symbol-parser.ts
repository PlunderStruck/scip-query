import type { ScipSymbol, ScipDescriptor, ScipLocalSymbol, DescriptorSuffix } from './types.js';

/**
 * SCIP Symbol Grammar (from the SCIP spec):
 *
 *   <symbol>     ::= <scheme> ' ' <package> ' ' <descriptor>+ | 'local ' <local-id>
 *   <package>    ::= <manager> ' ' <package-name> ' ' <version> ' '
 *   <descriptor> ::= <name> <suffix>
 *
 * Suffix characters:
 *   /    namespace
 *   #    type (class, interface, enum)
 *   .    term (variable, field, property)
 *   ().  method
 *   [    type parameter
 *   ()   parameter
 *   :    meta
 *   !    macro
 *
 * Names may be backtick-escaped: `some.weird/name`
 */

const SUFFIX_MAP: Record<string, DescriptorSuffix> = {
  '/': 'namespace',
  '#': 'type',
  '.': 'term',
  '[': 'type-param',
  ':': 'meta',
  '!': 'macro',
};

/**
 * Parse a SCIP symbol string into its structured components.
 * Works for any SCIP-indexed language (TypeScript, Java, Rust, Python, etc.)
 */
export function parseSymbol(raw: string): ScipSymbol | ScipLocalSymbol {
  if (raw.startsWith('local ')) {
    return { kind: 'local', id: raw.slice(6), raw };
  }

  // Split: <scheme> <manager> <package-name> <version> <descriptors...>
  // The tricky part: package-name can contain spaces if backtick-escaped
  const parts = raw.split(' ');
  if (parts.length < 4) {
    // Malformed — return a best-effort parse
    return {
      scheme: parts[0] ?? '',
      manager: parts[1] ?? '',
      packageName: parts[2] ?? '',
      version: '',
      descriptors: [],
      raw,
    };
  }

  const scheme = parts[0]!;
  const manager = parts[1]!;

  // Package name and version: package name might be backtick-escaped
  // After scheme + manager, we need to find package + version + descriptor string
  let restAfterManager = raw.slice(scheme.length + 1 + manager.length + 1);

  // Parse package name (may be backtick-escaped)
  let packageName: string;
  if (restAfterManager.startsWith('`')) {
    const closingTick = restAfterManager.indexOf('`', 1);
    if (closingTick === -1) {
      packageName = restAfterManager.slice(1);
      restAfterManager = '';
    } else {
      packageName = restAfterManager.slice(1, closingTick);
      restAfterManager = restAfterManager.slice(closingTick + 2); // skip ` and space
    }
  } else {
    const spaceIdx = restAfterManager.indexOf(' ');
    if (spaceIdx === -1) {
      packageName = restAfterManager;
      restAfterManager = '';
    } else {
      packageName = restAfterManager.slice(0, spaceIdx);
      restAfterManager = restAfterManager.slice(spaceIdx + 1);
    }
  }

  // Parse version
  let version: string;
  const versionSpaceIdx = restAfterManager.indexOf(' ');
  if (versionSpaceIdx === -1) {
    version = restAfterManager;
    restAfterManager = '';
  } else {
    version = restAfterManager.slice(0, versionSpaceIdx);
    restAfterManager = restAfterManager.slice(versionSpaceIdx + 1);
  }

  // Parse descriptors from the remaining string
  const descriptors = parseDescriptors(restAfterManager);

  return { scheme, manager, packageName, version, descriptors, raw };
}

/**
 * Parse the descriptor chain from a SCIP symbol.
 *
 * Descriptors are a sequence of <name><suffix> pairs.
 * Names can be backtick-escaped: `some/name.with.dots`
 * Method suffix is special: ().  (two chars that look like one)
 */
function parseDescriptors(input: string): ScipDescriptor[] {
  const descriptors: ScipDescriptor[] = [];
  let i = 0;

  while (i < input.length) {
    let name: string;

    // Parse name (possibly backtick-escaped)
    if (input[i] === '`') {
      const closingTick = input.indexOf('`', i + 1);
      if (closingTick === -1) {
        // Malformed — take the rest
        name = input.slice(i + 1);
        i = input.length;
        descriptors.push({ name, suffix: 'term' });
        break;
      }
      name = input.slice(i + 1, closingTick);
      i = closingTick + 1;
    } else {
      // Read until we hit a suffix character
      const start = i;
      while (i < input.length && !isSuffixChar(input[i]!)) {
        i++;
      }
      name = input.slice(start, i);
    }

    // Parse suffix
    if (i >= input.length) {
      if (name) descriptors.push({ name, suffix: 'term' });
      break;
    }

    const char = input[i]!;

    // Check for method suffix: ().
    if (char === '(' && i + 2 <= input.length && input[i + 1] === ')') {
      if (input[i + 2] === '.') {
        // Method: ().
        descriptors.push({ name, suffix: 'method' });
        i += 3;
      } else {
        // Parameter: ()
        descriptors.push({ name, suffix: 'parameter' });
        i += 2;
      }
    } else {
      const suffix = SUFFIX_MAP[char];
      if (suffix) {
        descriptors.push({ name, suffix });
        i += 1;
      } else {
        // Unknown suffix — skip
        i += 1;
      }
    }
  }

  return descriptors;
}

function isSuffixChar(c: string): boolean {
  return c === '/' || c === '#' || c === '.' || c === '(' || c === '[' || c === ':' || c === '!';
}

/**
 * Convert a parsed SCIP symbol to a short, human-readable name.
 * Language-agnostic: works for any SCIP-indexed language.
 *
 * Examples:
 *   "scip-typescript npm @vega/api 0.1.3 src/modules/auth/auth.service.ts/AuthService#login()."
 *   → "auth.service:AuthService:login()"
 *
 *   "scip-java maven com.example/mylib 1.0.0 com/example/MyClass#doStuff()."
 *   → "MyClass:doStuff()"
 *
 *   "rust-analyzer cargo my-crate 0.1.0 src/lib.rs/MyStruct#new()."
 *   → "lib:MyStruct:new()"
 */
export function shortenSymbol(raw: string): string {
  const parsed = parseSymbol(raw);
  if ('kind' in parsed && parsed.kind === 'local') {
    return `local:${parsed.id}`;
  }

  const sym = parsed as ScipSymbol;
  if (sym.descriptors.length === 0) return sym.raw;

  const parts: string[] = [];
  for (const desc of sym.descriptors) {
    // Strip file extensions from namespace descriptors (the file path parts)
    let name = desc.name;
    if (desc.suffix === 'namespace') {
      // Remove common file extensions
      name = name
        .replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '')
        .replace(/\.(py|pyi)$/, '')
        .replace(/\.(rs)$/, '')
        .replace(/\.(java|scala|kt|kts)$/, '')
        .replace(/\.(rb)$/, '')
        .replace(/\.(go)$/, '')
        .replace(/\.(cs|vb)$/, '')
        .replace(/\.(dart)$/, '')
        .replace(/\.(php)$/, '')
        .replace(/\.(c|cc|cpp|cxx|h|hpp)$/, '');
    }

    // Skip empty names (can happen with trailing suffixes)
    if (!name) continue;

    // For methods, append () for clarity
    if (desc.suffix === 'method') {
      parts.push(`${name}()`);
    } else {
      parts.push(name);
    }
  }

  return parts.join(':');
}

/**
 * Extract just the leaf name from a SCIP symbol.
 * Useful when you only need the function/class/variable name without path context.
 */
export function leafName(raw: string): string {
  const parsed = parseSymbol(raw);
  if ('kind' in parsed && parsed.kind === 'local') {
    return parsed.id;
  }

  const sym = parsed as ScipSymbol;
  if (sym.descriptors.length === 0) return '';

  const last = sym.descriptors[sym.descriptors.length - 1]!;
  return last.name;
}
