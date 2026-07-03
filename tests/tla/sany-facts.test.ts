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

  it('expands a user-defined operator reference transitively into the referencing action (I2 / followup #24)', () => {
    // Shape verified against tla2tools v1.8.0 XMLExporter output for:
    //   VARIABLES x, y
    //   Helper == x' = 1 /\ UNCHANGED y
    //   Act == Helper
    // A reference to a user-defined operator is a `UserDefinedOpKindRef`
    // pointing at that operator's own context-entry UID (not an
    // `OpDeclNodeRef`, which is reserved for VARIABLE/CONSTANT
    // declarations) — Act's body carries only that one ref, so without
    // expansion Act reports writes: none.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<modules>
  <context>
    <entry><UID>4</UID><BuiltInKind><uniquename>=</uniquename></BuiltInKind></entry>
    <entry><UID>13</UID><BuiltInKind><uniquename>'</uniquename></BuiltInKind></entry>
    <entry><UID>19</UID><BuiltInKind><uniquename>\\land</uniquename></BuiltInKind></entry>
    <entry><UID>67</UID><BuiltInKind><uniquename>UNCHANGED</uniquename></BuiltInKind></entry>
    <entry><UID>155</UID><OpDeclNode><uniquename>x</uniquename><arity>0</arity><kind>3</kind></OpDeclNode></entry>
    <entry><UID>156</UID><OpDeclNode><uniquename>y</uniquename><arity>0</arity><kind>3</kind></OpDeclNode></entry>
    <entry><UID>164</UID><UserDefinedOpKind><location><filename>Helper</filename></location><uniquename>Helper</uniquename><body>
      <OpApplNode><operator><BuiltInKindRef><UID>19</UID></BuiltInKindRef></operator>
        <operands>
          <OpApplNode><operator><BuiltInKindRef><UID>4</UID></BuiltInKindRef></operator>
            <operands>
              <OpApplNode><operator><BuiltInKindRef><UID>13</UID></BuiltInKindRef></operator>
                <operands><OpApplNode><operator><OpDeclNodeRef><UID>155</UID></OpDeclNodeRef></operator><operands/></OpApplNode></operands>
              </OpApplNode>
              <NumeralNode><IntValue>1</IntValue></NumeralNode>
            </operands>
          </OpApplNode>
          <OpApplNode><operator><BuiltInKindRef><UID>67</UID></BuiltInKindRef></operator>
            <operands><OpApplNode><operator><OpDeclNodeRef><UID>156</UID></OpDeclNodeRef></operator><operands/></OpApplNode></operands>
          </OpApplNode>
        </operands>
      </OpApplNode>
    </body></UserDefinedOpKind></entry>
    <entry><UID>166</UID><UserDefinedOpKind><location><filename>Helper</filename></location><uniquename>Act</uniquename><body>
      <OpApplNode><operator><UserDefinedOpKindRef><UID>164</UID></UserDefinedOpKindRef></operator><operands/></OpApplNode>
    </body></UserDefinedOpKind></entry>
  </context>
</modules>`;

    const facts = parseSanyXmlFacts(xml);

    expect(facts.actions).toEqual(
      expect.arrayContaining([
        { name: 'Helper', reads: [], writes: ['x'] },
        // Act delegates entirely to Helper — the write of x propagates, and
        // y stays neither a read nor a write (UNCHANGED inside Helper).
        { name: 'Act', reads: [], writes: ['x'] },
      ]),
    );
  });

  it('does not expand a user-defined operator reference from a different module (I2 / followup #24)', () => {
    // Same shape as the transitive-expansion fixture, except Helper's own
    // entry declares a different <filename> than Act's — same-module-only
    // expansion must not cross that boundary.
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<modules>
  <context>
    <entry><UID>13</UID><BuiltInKind><uniquename>'</uniquename></BuiltInKind></entry>
    <entry><UID>155</UID><OpDeclNode><uniquename>x</uniquename><arity>0</arity><kind>3</kind></OpDeclNode></entry>
    <entry><UID>164</UID><UserDefinedOpKind><location><filename>OtherModule</filename></location><uniquename>Helper</uniquename><body>
      <OpApplNode><operator><BuiltInKindRef><UID>13</UID></BuiltInKindRef></operator>
        <operands><OpApplNode><operator><OpDeclNodeRef><UID>155</UID></OpDeclNodeRef></operator><operands/></OpApplNode></operands>
      </OpApplNode>
    </body></UserDefinedOpKind></entry>
    <entry><UID>166</UID><UserDefinedOpKind><location><filename>Helper</filename></location><uniquename>Act</uniquename><body>
      <OpApplNode><operator><UserDefinedOpKindRef><UID>164</UID></UserDefinedOpKindRef></operator><operands/></OpApplNode>
    </body></UserDefinedOpKind></entry>
  </context>
</modules>`;

    const facts = parseSanyXmlFacts(xml);

    expect(facts.actions).toEqual(expect.arrayContaining([{ name: 'Act', reads: [], writes: [] }]));
  });

  it('stays cycle-safe when user-defined operators reference each other (I2 / followup #24)', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<modules>
  <context>
    <entry><UID>13</UID><BuiltInKind><uniquename>'</uniquename></BuiltInKind></entry>
    <entry><UID>155</UID><OpDeclNode><uniquename>x</uniquename><arity>0</arity><kind>3</kind></OpDeclNode></entry>
    <entry><UID>200</UID><UserDefinedOpKind><location><filename>Cyclic</filename></location><uniquename>A</uniquename><body>
      <OpApplNode><operator><UserDefinedOpKindRef><UID>201</UID></UserDefinedOpKindRef></operator><operands/></OpApplNode>
    </body></UserDefinedOpKind></entry>
    <entry><UID>201</UID><UserDefinedOpKind><location><filename>Cyclic</filename></location><uniquename>B</uniquename><body>
      <OpApplNode><operator><BuiltInKindRef><UID>13</UID></BuiltInKindRef></operator>
        <operands><OpApplNode><operator><OpDeclNodeRef><UID>155</UID></OpDeclNodeRef></operator><operands/></OpApplNode></operands>
      </OpApplNode>
      <OpApplNode><operator><UserDefinedOpKindRef><UID>200</UID></UserDefinedOpKindRef></operator><operands/></OpApplNode>
    </body></UserDefinedOpKind></entry>
  </context>
</modules>`;

    const facts = parseSanyXmlFacts(xml);

    // A -> B -> A: must terminate and still surface the real write of x
    // discovered on the way, without hanging or duplicating indefinitely.
    expect(facts.actions).toEqual(
      expect.arrayContaining([
        { name: 'A', reads: [], writes: ['x'] },
        { name: 'B', reads: [], writes: ['x'] },
      ]),
    );
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
