import { describe, it, expect } from 'vitest';
import {
  parseSymbol,
  shortenSymbol,
  leafName,
  isFunctionLikeSymbol,
  isModuleLikeSymbol,
  isDirectChildSymbol,
} from '../../src/symbols/symbol-parser.js';

describe('parseSymbol', () => {
  it('parses a TypeScript class method symbol', () => {
    const raw = 'scip-typescript npm @vega/api 0.1.3 src/modules/auth/`auth.service.ts`/AuthService#login().';
    const result = parseSymbol(raw);

    expect(result).not.toHaveProperty('kind');
    if (!('kind' in result)) {
      expect(result.scheme).toBe('scip-typescript');
      expect(result.manager).toBe('npm');
      expect(result.packageName).toBe('@vega/api');
      expect(result.version).toBe('0.1.3');
      // src/ + modules/ + auth/ + `auth.service.ts`/ + AuthService# + login().
      expect(result.descriptors).toHaveLength(6);
      expect(result.descriptors[0]).toEqual({ name: 'src', suffix: 'namespace' });
      expect(result.descriptors[1]).toEqual({ name: 'modules', suffix: 'namespace' });
      expect(result.descriptors[2]).toEqual({ name: 'auth', suffix: 'namespace' });
      expect(result.descriptors[3]).toEqual({ name: 'auth.service.ts', suffix: 'namespace' });
      expect(result.descriptors[4]).toEqual({ name: 'AuthService', suffix: 'type' });
      expect(result.descriptors[5]).toEqual({ name: 'login', suffix: 'method' });
    }
  });

  it('parses a Rust symbol', () => {
    const raw = 'rust-analyzer cargo my-crate 0.1.0 src/`lib.rs`/MyStruct#new().';
    const result = parseSymbol(raw);

    if (!('kind' in result)) {
      expect(result.scheme).toBe('rust-analyzer');
      expect(result.manager).toBe('cargo');
      expect(result.packageName).toBe('my-crate');
      // src/ + `lib.rs`/ + MyStruct# + new().
      expect(result.descriptors).toHaveLength(4);
      expect(result.descriptors[0]).toEqual({ name: 'src', suffix: 'namespace' });
      expect(result.descriptors[1]).toEqual({ name: 'lib.rs', suffix: 'namespace' });
      expect(result.descriptors[2]).toEqual({ name: 'MyStruct', suffix: 'type' });
      expect(result.descriptors[3]).toEqual({ name: 'new', suffix: 'method' });
    }
  });

  it('parses a Java symbol', () => {
    const raw = 'scip-java maven com.example/mylib 1.0.0 com/example/MyClass#doStuff().';
    const result = parseSymbol(raw);

    if (!('kind' in result)) {
      expect(result.scheme).toBe('scip-java');
      expect(result.manager).toBe('maven');
      expect(result.packageName).toBe('com.example/mylib');
      expect(result.version).toBe('1.0.0');
    }
  });

  it('parses a Python symbol', () => {
    const raw = 'scip-python pip my-package 1.0.0 my_module/`utils.py`/helper_function.';
    const result = parseSymbol(raw);

    if (!('kind' in result)) {
      expect(result.scheme).toBe('scip-python');
      expect(result.manager).toBe('pip');
      expect(result.packageName).toBe('my-package');
    }
  });

  it('parses a local symbol', () => {
    const raw = 'local 42';
    const result = parseSymbol(raw);

    expect(result).toHaveProperty('kind', 'local');
    if ('kind' in result) {
      expect(result.id).toBe('42');
    }
  });

  it('parses a symbol with type parameters', () => {
    // Type param uses bracket-wrap syntax: [T]
    const raw = 'scip-typescript npm pkg 1.0.0 `file.ts`/Generic#[T]';
    const result = parseSymbol(raw);

    if (!('kind' in result)) {
      const last = result.descriptors[result.descriptors.length - 1];
      expect(last).toEqual({ name: 'T', suffix: 'type-param' });
    }
  });

  it('handles a property/term symbol', () => {
    const raw = 'scip-typescript npm pkg 1.0.0 `file.ts`/MyClass#myProp.';
    const result = parseSymbol(raw);

    if (!('kind' in result)) {
      expect(result.descriptors[result.descriptors.length - 1]).toEqual({
        name: 'myProp',
        suffix: 'term',
      });
    }
    expect(isFunctionLikeSymbol(raw)).toBe(false);
  });

  it('keeps non-TypeScript term symbols function-like for source-backed languages', () => {
    expect(isFunctionLikeSymbol('scip-clojure deps.edn demo . `demo.core`/greet.')).toBe(true);
  });

  it('handles parameter descriptors', () => {
    // Parameter uses paren-wrap syntax: (paramName)
    const raw = 'scip-typescript npm pkg 1.0.0 `file.ts`/MyClass#method().(param)';
    const result = parseSymbol(raw);

    if (!('kind' in result)) {
      const last = result.descriptors[result.descriptors.length - 1];
      expect(last).toEqual({ name: 'param', suffix: 'parameter' });
    }
  });
});

describe('shortenSymbol', () => {
  it('shortens a TypeScript class method', () => {
    const raw = 'scip-typescript npm @vega/api 0.1.3 src/modules/auth/`auth.service.ts`/AuthService#login().';
    const short = shortenSymbol(raw);
    // Each / creates a separate namespace descriptor, file ext gets stripped
    expect(short).toBe('src:modules:auth:auth.service:AuthService:login()');
  });

  it('shortens a Rust symbol', () => {
    const raw = 'rust-analyzer cargo my-crate 0.1.0 src/`lib.rs`/MyStruct#new().';
    const short = shortenSymbol(raw);
    expect(short).toBe('src:lib:MyStruct:new()');
  });

  it('shortens a local symbol', () => {
    const short = shortenSymbol('local 42');
    expect(short).toBe('local:42');
  });

  it('strips file extensions from namespace parts', () => {
    const raw = 'scip-python pip pkg 1.0.0 my_module/`utils.py`/helper.';
    const short = shortenSymbol(raw);
    expect(short).toBe('my_module:utils:helper');
  });

  it('strips Java file extensions', () => {
    const raw = 'scip-java maven pkg 1.0.0 com/example/`MyClass.java`/MyClass#doStuff().';
    const short = shortenSymbol(raw);
    expect(short).toBe('com:example:MyClass:MyClass:doStuff()');
  });
});

describe('leafName', () => {
  it('extracts the last descriptor name', () => {
    const raw = 'scip-typescript npm @vega/api 0.1.3 src/modules/auth/`auth.service.ts`/AuthService#login().';
    expect(leafName(raw)).toBe('login');
  });

  it('extracts from a simple symbol', () => {
    const raw = 'scip-typescript npm pkg 1.0.0 `file.ts`/myFunction.';
    expect(leafName(raw)).toBe('myFunction');
  });

  it('handles local symbols', () => {
    expect(leafName('local 42')).toBe('42');
  });
});

describe('symbol helpers', () => {
  it('recognizes function-like vs module-like symbols', () => {
    const fn = 'scip-typescript npm pkg 1.0.0 src/reindex/`index.ts`/reindex().';
    const mod = 'scip-typescript npm pkg 1.0.0 src/reindex/`index.ts`/';

    expect(isFunctionLikeSymbol(fn)).toBe(true);
    expect(isModuleLikeSymbol(fn)).toBe(false);
    expect(isModuleLikeSymbol(mod)).toBe(true);
    expect(isFunctionLikeSymbol(mod)).toBe(false);
  });

  it('detects direct child relationships in descriptor chains', () => {
    const parent = 'scip-typescript npm pkg 1.0.0 src/`watch.ts`/Watcher#';
    const child = 'scip-typescript npm pkg 1.0.0 src/`watch.ts`/Watcher#start().';
    const grandchild = 'scip-typescript npm pkg 1.0.0 src/`watch.ts`/Watcher#start().(opts)';

    expect(isDirectChildSymbol(parent, child)).toBe(true);
    expect(isDirectChildSymbol(parent, grandchild)).toBe(false);
  });
});
