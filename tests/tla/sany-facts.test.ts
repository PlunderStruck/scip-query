import { describe, expect, it } from 'vitest';
import { exportSanyXml, parseSanyXmlFacts } from '../../src/tla/sany-facts.js';

describe('SANY XML facts', () => {
  it('extracts variables, operators, reads, primed writes, and UNCHANGED runs from real-grammar XML', () => {
    // Shape verified against tla2tools v1.8.0 XMLExporter output: context
    // entries with UID + child-element uniquename/kind; operator bodies
    // reference declarations by UID; prime is a BuiltInKindRef to `'`.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<modules>
  <context>
    <entry><UID>10</UID><BuiltInKind><uniquename>'</uniquename></BuiltInKind></entry>
    <entry><UID>11</UID><BuiltInKind><uniquename>UNCHANGED</uniquename></BuiltInKind></entry>
    <entry><UID>12</UID><BuiltInKind><uniquename>$Tuple</uniquename></BuiltInKind></entry>
    <entry><UID>13</UID><BuiltInKind><uniquename>=</uniquename></BuiltInKind></entry>
    <entry><UID>20</UID><OpDeclNode><uniquename>queue</uniquename><arity>0</arity><kind>3</kind></OpDeclNode></entry>
    <entry><UID>21</UID><OpDeclNode><uniquename>clock</uniquename><arity>0</arity><kind>3</kind></OpDeclNode></entry>
    <entry><UID>22</UID><OpDeclNode><uniquename>MaxLen</uniquename><arity>0</arity><kind>2</kind></OpDeclNode></entry>
    <entry><UID>30</UID><UserDefinedOpKind><uniquename>Enqueue</uniquename><body>
      <OpApplNode><BuiltInKindRef><UID>13</UID></BuiltInKindRef>
        <OpDeclNodeRef><UID>20</UID></OpDeclNodeRef>
        <OpApplNode><BuiltInKindRef><UID>10</UID></BuiltInKindRef>
          <OpDeclNodeRef><UID>20</UID></OpDeclNodeRef></OpApplNode>
        <OpApplNode><BuiltInKindRef><UID>11</UID></BuiltInKindRef>
          <OpApplNode><BuiltInKindRef><UID>12</UID></BuiltInKindRef>
            <OpDeclNodeRef><UID>21</UID></OpDeclNodeRef></OpApplNode></OpApplNode>
      </OpApplNode></body></UserDefinedOpKind></entry>
    <entry><UID>31</UID><UserDefinedOpKind><uniquename>Tick</uniquename><body>
      <OpApplNode><BuiltInKindRef><UID>10</UID></BuiltInKindRef>
        <OpDeclNodeRef><UID>21</UID></OpDeclNodeRef></OpApplNode></body></UserDefinedOpKind></entry>
  </context>
</modules>`;

    expect(parseSanyXmlFacts(xml)).toEqual({
      modelParse: 'sany',
      // MaxLen is kind 2 (CONSTANT): not a variable.
      variables: ['clock', 'queue'],
      operators: ['Enqueue', 'Tick'],
      actions: [
        // queue read (guard) + queue primed (write); clock under UNCHANGED
        // is neither a read nor a write.
        { name: 'Enqueue', reads: ['queue'], writes: ['queue'] },
        { name: 'Tick', reads: [], writes: ['clock'] },
      ],
    });
  });

  it('invokes XMLExporter in offline mode and captures XML from stdout', () => {
    const calls: { binary: string; args: string[] }[] = [];
    const fake = ((binary: string, args: string[]) => {
      calls.push({ binary, args });
      return { status: 0, signal: null, stdout: '<?xml version="1.0"?><modules></modules>', stderr: '' };
    }) as never;
    const xml = exportSanyXml({ specPath: '/tmp/specs/Queue.tla', jarPath: '/tmp/tools.jar', spawnSync: fake });
    expect(xml).toContain('<?xml');
    expect(calls[0]?.args).toEqual(['-cp', '/tmp/tools.jar', 'tla2sany.xml.XMLExporter', '-o', '/tmp/specs/Queue.tla']);
  });

  it('returns null when XMLExporter fails or emits no XML', () => {
    const fail = (() => ({ status: 1, signal: null, stdout: '', stderr: 'ERROR' })) as never;
    expect(exportSanyXml({ specPath: '/s/Q.tla', jarPath: '/j.jar', spawnSync: fail })).toBeNull();
    const noise = (() => ({ status: 0, signal: null, stdout: 'not xml', stderr: '' })) as never;
    expect(exportSanyXml({ specPath: '/s/Q.tla', jarPath: '/j.jar', spawnSync: noise })).toBeNull();
  });
});
