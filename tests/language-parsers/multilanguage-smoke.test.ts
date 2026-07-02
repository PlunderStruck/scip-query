import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { getSourceExports, getSourceImports } from '../../src/language-parsers/index.js';
import { ScipDatabase } from '../../src/storage/db.js';
import { evidenceFixtureDb, writeFixtureFiles } from '../fixtures/evidence-fixture.js';

describe('multi-language parser smoke coverage', () => {
  it('extracts imports from Ruby, PHP, Dart, .NET, JVM, and C-like fixtures', () => {
    withParserFixture((db) => {
      expect(getSourceImports(db, 'app/main.rb')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ importedName: 'Widget', localName: 'Widget', sourcePath: 'app/widget.rb' }),
          expect.objectContaining({ importedName: 'json', kind: 'side-effect' }),
        ]),
      );

      expect(getSourceImports(db, 'php/App.php')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ importedName: 'Client', localName: 'HttpClient' }),
          expect.objectContaining({ importedName: 'Logger', localName: 'Logger' }),
        ]),
      );

      expect(getSourceImports(db, 'lib/main.dart')).toEqual([
        expect.objectContaining({
          importedName: './model.dart',
          localName: 'model',
          sourcePath: 'lib/model.dart',
          usedMembers: ['Thing'],
        }),
      ]);
      expect(getSourceExports(db, 'lib/main.dart')).toEqual([
        expect.objectContaining({ specifier: './public.dart', sourcePath: 'lib/public.dart' }),
      ]);

      expect(getSourceImports(db, 'dotnet/App.cs')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ importedName: 'Linq', localName: 'LinqAlias', kind: 'namespace' }),
          expect.objectContaining({ importedName: 'Text', localName: 'Text' }),
        ]),
      );

      expect(getSourceImports(db, 'jvm/App.java')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ importedName: 'List', localName: 'List' }),
          expect.objectContaining({ importedName: 'Paths', localName: 'Paths' }),
          expect.objectContaining({ importedName: '*', kind: 'namespace' }),
        ]),
      );

      expect(getSourceImports(db, 'native/main.c')).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ importedName: 'widget.h', localName: 'widget', sourcePath: 'native/widget.h' }),
          expect.objectContaining({ importedName: 'stdio.h', localName: 'stdio' }),
        ]),
      );
    });
  });
});

function withParserFixture(run: (db: ScipDatabase) => void): void {
  const tempDir = mkdtempSync(join(tmpdir(), 'scip-query-parser-smoke-'));
  try {
    const projectRoot = join(tempDir, 'project');
    const dbPath = join(tempDir, 'index.db');
    writeFixtureFiles(projectRoot, {
      'app/main.rb': [
        "require 'json'",
        "require_relative './widget'",
        '',
        'class Runner',
        '  def call',
        '    Widget.new.to_json',
        '  end',
        'end',
      ],
      'app/widget.rb': ['class Widget', 'end'],
      'php/App.php': [
        '<?php',
        'namespace Demo;',
        'use Demo\\Http\\Client as HttpClient;',
        'use Psr\\Log\\Logger;',
        '$client = new HttpClient();',
        '$logger = new Logger();',
      ],
      'php/Http/Client.php': ['<?php', 'namespace Demo\\Http;', 'class Client {}'],
      'lib/main.dart': [
        "import './model.dart' as model;",
        "export './public.dart';",
        '',
        'final thing = model.Thing();',
      ],
      'lib/model.dart': ['class Thing {}'],
      'lib/public.dart': ['class PublicThing {}'],
      'dotnet/App.cs': [
        'using LinqAlias = System.Linq;',
        'using System.Text;',
        '',
        'class App {',
        '  object Value = LinqAlias.Enumerable.Empty<string>();',
        '  Text.StringBuilder Builder = new Text.StringBuilder();',
        '}',
      ],
      'jvm/App.java': [
        'package demo;',
        'import java.util.List;',
        'import java.nio.file.Paths;',
        'import demo.helpers.*;',
        '',
        'class App { List<String> names = List.of(Paths.get(".")); }',
      ],
      'native/main.c': ['#include "widget.h"', '#include <stdio.h>', '', 'int main(void) { return widget(); }'],
      'native/widget.h': ['int widget(void);'],
    });

    evidenceFixtureDb(dbPath)
      .document(1, 'ruby', 'app/main.rb')
      .document(2, 'ruby', 'app/widget.rb')
      .document(3, 'php', 'php/App.php')
      .document(4, 'php', 'php/Http/Client.php')
      .document(5, 'dart', 'lib/main.dart')
      .document(6, 'dart', 'lib/model.dart')
      .document(7, 'dart', 'lib/public.dart')
      .document(8, 'csharp', 'dotnet/App.cs')
      .document(9, 'java', 'jvm/App.java')
      .document(10, 'c', 'native/main.c')
      .document(11, 'c', 'native/widget.h')
      .write();

    const db = new ScipDatabase({
      projectRoot,
      dbPath,
      indexPath: join(tempDir, 'index.scip'),
    });
    try {
      run(db);
    } finally {
      db.close();
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
