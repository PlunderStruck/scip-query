import { describe, expect, it } from 'vitest';
import {
  parseSkillCommands,
  renderAgentContractCatalogMarkdown,
  renderAgentSetupCommandCatalogSource,
  renderSkillCommandsMarkdown,
  validateSkillCommand,
} from '../../scripts/render-command-reference.js';

// Plan 3, 19.1: the per-skill `commands:` frontmatter is validated against
// commandDescriptors and rendered into a marker-delimited body block. These
// tests cover the parse/validate/render pure functions in isolation —
// end-to-end coverage (every bundled skill, idempotency) lives in the
// `npm run docs:commands && git diff --exit-code skills/` validation step.

const SKILL_MD_WITH_COMMANDS = `---
name: example-skill
description: An example skill.
commands:
  - template: "scip-query refs <symbol>"
    when: "Find consumers before editing."
  - template: "scip-query twin-drift -s <scope> --json"
    when: "Run the detector over the scope."
---

# example-skill

Body text.
`;

const SKILL_MD_WITHOUT_COMMANDS = `---
name: no-commands-skill
description: A skill with no commands frontmatter.
---

# no-commands-skill
`;

// Regression fixture: prettier's YAML formatter rewrites frontmatter string
// quoting to single quotes by default, double only when the value itself
// contains an apostrophe (mixed quoting in one file, as seen live in
// a former TLA+ workflow skill after `npm run format`). A `--write` run
// must not silently empty a skill's parsed commands list.
const SKILL_MD_WITH_MIXED_QUOTES = `---
name: mixed-quote-skill
description: A skill whose frontmatter prettier reformatted to single quotes.
commands:
  - template: 'scip-query refs <symbol>'
    when: 'Find consumers before editing.'
  - template: 'scip-query tla verify <spec>'
    when: "Checks the model's Next relation."
---

# mixed-quote-skill
`;

describe('parseSkillCommands', () => {
  it('parses template/when pairs from frontmatter', () => {
    const entries = parseSkillCommands(SKILL_MD_WITH_COMMANDS, 'skills/example-skill/SKILL.md');
    expect(entries).toEqual([
      { template: 'scip-query refs <symbol>', when: 'Find consumers before editing.' },
      { template: 'scip-query twin-drift -s <scope> --json', when: 'Run the detector over the scope.' },
    ]);
  });

  it('returns an empty list when the skill declares no commands', () => {
    expect(parseSkillCommands(SKILL_MD_WITHOUT_COMMANDS, 'skills/no-commands-skill/SKILL.md')).toEqual([]);
  });

  it('parses single-quoted and mixed-quote frontmatter (prettier YAML reformat regression)', () => {
    const entries = parseSkillCommands(SKILL_MD_WITH_MIXED_QUOTES, 'skills/mixed-quote-skill/SKILL.md');
    expect(entries).toEqual([
      { template: 'scip-query refs <symbol>', when: 'Find consumers before editing.' },
      { template: 'scip-query tla verify <spec>', when: "Checks the model's Next relation." },
    ]);
  });

  it('throws when a commands entry is missing a when clause', () => {
    const raw = `---
name: broken-skill
description: broken
commands:
  - template: "scip-query refs <symbol>"
---
`;
    expect(() => parseSkillCommands(raw, 'skills/broken-skill/SKILL.md')).toThrow(/missing when/);
  });

  it('rejects a nested list item that a YAML parser would not accept as another command', () => {
    const raw = `---
name: broken-skill
description: broken
commands:
  - template: 'scip-query refs <symbol>'
    when: 'Find consumers.'
    - template: 'scip-query outline <file>'
    when: 'Locate constructs.'
---
`;
    expect(() => parseSkillCommands(raw, 'skills/broken-skill/SKILL.md')).toThrow(/malformed commands frontmatter/);
  });
});

describe('validateSkillCommand', () => {
  it('accepts a template whose base command and flags exist in commandDescriptors', () => {
    expect(() =>
      validateSkillCommand(
        { template: 'scip-query refs <symbol> --full --json', when: 'x' },
        'skills/example-skill/SKILL.md',
      ),
    ).not.toThrow();
  });

  it('accepts a multi-word descriptor command by its first token (tla subcommands)', () => {
    expect(() =>
      validateSkillCommand({ template: 'scip-query tla fetch-tools', when: 'x' }, 'skills/example-skill/SKILL.md'),
    ).not.toThrow();
  });

  it('fails on an unknown command', () => {
    expect(() =>
      validateSkillCommand({ template: 'scip-query not-a-real-command', when: 'x' }, 'skills/example-skill/SKILL.md'),
    ).toThrow(/unknown command/);
  });

  it('fails on an unknown flag for a known command', () => {
    expect(() =>
      validateSkillCommand(
        { template: 'scip-query refs <symbol> --not-a-flag', when: 'x' },
        'skills/example-skill/SKILL.md',
      ),
    ).toThrow(/unknown flag/);
  });
});

describe('renderSkillCommandsMarkdown', () => {
  it('renders a concise marker-delimited command chooser', () => {
    const markdown = renderSkillCommandsMarkdown([
      { template: 'scip-query refs <symbol>', when: 'Find consumers before editing.' },
    ]);
    expect(markdown).toContain('<!-- BEGIN GENERATED SKILL COMMANDS -->');
    expect(markdown).toContain('<!-- END GENERATED SKILL COMMANDS -->');
    expect(markdown).toContain('`scip-query refs <symbol>`');
    expect(markdown).toContain('| Command | When |');
    expect(markdown).not.toContain('referencing file paths; reference line numbers grouped by file');
    expect(markdown).toContain('Find consumers before editing.');
    expect(markdown).toContain("Run a command's `--help` only when a named uncertainty needs another option.");
  });
});

describe('renderAgentContractCatalogMarkdown', () => {
  it('renders descriptor-owned questions, returned units, and coverage', () => {
    const markdown = renderAgentContractCatalogMarkdown([
      {
        id: 'example',
        command: 'example <symbol>',
        description: 'Example command',
        evidence: 'graph-fact',
        renderShape: 'custom',
        budget: 'fast',
        handler: () => undefined,
        agent: {
          answers: ['Who references this symbol?'],
          returns: ['referencing files'],
          inputs: ['symbol'],
          coverage: 'bounded',
          operation: {
            defaultRole: 'repository-observation',
          },
        },
      },
    ]);

    expect(markdown).toContain('<!-- BEGIN GENERATED AGENT CONTRACT CATALOG -->');
    expect(markdown).toContain('`scip-query example <symbol>`');
    expect(markdown).toContain('Who references this symbol?');
    expect(markdown).toContain('referencing files');
    expect(markdown).toContain('`repository-observation`');
    expect(markdown).toContain('`bounded`');
    expect(markdown).toContain('<!-- END GENERATED AGENT CONTRACT CATALOG -->');
  });
});

describe('renderAgentSetupCommandCatalogSource', () => {
  it('generates the canonical nondeprecated catalogue from command descriptors', () => {
    const source = renderAgentSetupCommandCatalogSource();

    expect(source).toContain('scip-query evidence`');
    expect(source).toContain('scip-query inspect');
    expect(source).toContain('GENERATED_EXPLORATION_CONTROLS');
    expect(source.toLowerCase()).toContain('typed edges only to each registered provider ceiling');
    expect(source).toContain('Choose graph controls explicitly:');
    expect(source).not.toContain('appendEvent');
    expect(source).not.toContain('scip-query anchors');
    expect(source).not.toContain('scip-query system-map');
  });
});
