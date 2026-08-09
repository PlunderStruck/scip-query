import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const COMMAND_BOUNDARY = String.raw`(?:^|[\s'";&|()])`;
const COMMAND_END = String.raw`(?=[\s'"]|$)`;
const SHELL_COMMAND_POSITION = String.raw`(?:^|(?:\|\||&&|[;|])\s*|(?:-lc|-c)\s+["']?)`;
const NATIVE_SEARCH = new RegExp(
  `${COMMAND_BOUNDARY}(?:rg|grep|find|fd|ls|tree|ps|pgrep|git\\s+(?:grep|ls-files))${COMMAND_END}`,
  'iu',
);
const NATIVE_READ = new RegExp(
  `${COMMAND_BOUNDARY}(?:cat|sed|awk|head|tail|nl|bat|less|more|perl|git\\s+show)${COMMAND_END}`,
  'iu',
);
const SCRIPTED_READ = /(?:readFile(?:Sync)?|read_text|\.read\(|open\s*\()/u;
const SCIP_QUERY = new RegExp(`${COMMAND_BOUNDARY}(?:[^\\s'"]*/)?scip-query${COMMAND_END}`, 'iu');
const MIXED_NATIVE_SEARCH = new RegExp(
  `${SHELL_COMMAND_POSITION}(?:rg|grep|find|fd|ls|tree|ps|pgrep|git\\s+(?:grep|ls-files))${COMMAND_END}`,
  'iu',
);
const MIXED_NATIVE_READ = new RegExp(
  `${SHELL_COMMAND_POSITION}(?:cat|sed|awk|head|tail|nl|bat|less|more|perl|git\\s+show)${COMMAND_END}`,
  'iu',
);

export function treatmentPrompt(question) {
  return treatmentBenchmarkPrompt(question);
}

export function minimalTreatmentPrompt(question) {
  return treatmentBenchmarkPrompt(question);
}

export function directGraphTreatmentPrompt(question) {
  return treatmentBenchmarkPrompt(
    question,
    'When the answer depends on code relationships, use the explicit evidence family and direction taught by the repository guidance.',
  );
}

export function pathWithoutExecutable(pathValue, executable) {
  const executableNames = [executable, `${executable}.cmd`, `${executable}.exe`, `${executable}.bat`];
  return pathValue
    .split(delimiter)
    .filter((directory) => directory !== '')
    .filter((directory) => !executableNames.some((name) => existsSync(join(directory, name))))
    .join(delimiter);
}

export function codexExplorationExecArgs({ repository, model, reasoning }) {
  return [
    'exec',
    '--ephemeral',
    '--json',
    '--ignore-user-config',
    '--ignore-rules',
    '-m',
    model,
    '-c',
    `model_reasoning_effort=${JSON.stringify(reasoning)}`,
    '-s',
    'danger-full-access',
    '-C',
    repository,
    '-',
  ];
}

function treatmentBenchmarkPrompt(question, additionalGuidance = '') {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:

${question}

Use scip-query as the only repository exploration surface for tracked nonbinary content and follow the installed repository scip-query guidance. Do not use native repository search or source-reading tools. Do not edit files or inspect benchmark definitions, evaluation fixtures, rubrics, or recorded answers. There is no query-count correctness cutoff; continue while the installed guidance identifies a material, recoverable gap. ${additionalGuidance}

Return a concise explanation with concrete symbol and file/line evidence and state any material coverage limitation.`;
}

export function controlPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:\n\n${question}\n\nDo not run scip-query. Explore the repository with the native shell search and source-reading tools you would normally use. Do not edit files. Return a concise explanation with concrete symbol and file/line evidence and state any material limitation.`;
}

export function disciplinedControlPrompt(question) {
  return `You are running a read-only codebase-exploration benchmark. Answer this question accurately:\n\n${question}\n\nDo not run scip-query. Explore the repository with native shell search and source-reading tools. Do not edit files or inspect benchmark definitions, evaluation fixtures, rubrics, or recorded answers. Privately reduce the question to the few material claims the answer must establish. Locate the smallest relevant implementation owners, follow the direct entry-to-effect path, and treat source already returned as read. Batch independent searches and reads, avoid documentation, examples, tests, and unrelated helpers unless a named material gap requires them, and stop when every material claim is established. Before sending, audit the draft itself against those claims.\n\nReturn a concise explanation with concrete symbol and file/line evidence and state any material coverage limitation.`;
}

export function parseCodexJsonl(jsonl, metadata = {}) {
  const events = [];
  for (const [index, line] of jsonl.split(/\r?\n/u).entries()) {
    if (line.trim() === '') continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(
        `invalid Codex JSONL event on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  const calls = [];
  let answer = '';
  let usage;
  let threadId;
  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') threadId = event.thread_id;
    if (event.type === 'turn.completed') usage = parseUsage(event.usage);
    if (event.type !== 'item.completed' || !event.item || typeof event.item !== 'object') continue;
    if (event.item.type === 'agent_message' && typeof event.item.text === 'string') answer = event.item.text;
    if (!['command_execution', 'shell_command'].includes(event.item.type)) continue;
    const command = commandText(event.item.command);
    const output = outputText(event.item);
    calls.push({
      ...classifyExplorationCommand(command),
      command,
      output: '',
      outputCharacters: output.length,
      outputSha256: createHash('sha256').update(output).digest('hex'),
      preconditionRefusal: /NAVIGATION MAP REQUIRED|NAVIGATION MAP ALREADY RUNNING|MAP TRANSPORT INCOMPLETE/u.test(
        output,
      ),
      exitCode: Number.isSafeInteger(event.item.exit_code) ? event.item.exit_code : null,
    });
  }

  if (answer.trim() === '') throw new Error('Codex JSONL contained no completed agent answer');
  if (!usage) throw new Error('Codex JSONL contained no turn.completed usage');
  return {
    ...metadata,
    answer,
    calls,
    usage,
    codexThreadId: threadId ?? null,
    rawEventCount: events.length,
  };
}

export function classifyExplorationCommand(command) {
  if (isSkillInstructionRead(command)) return { surface: 'other', kind: 'other' };
  const scipQuery = SCIP_QUERY.test(command);
  // Classify the primary exploration surface before scanning its quoted
  // arguments. Natural-language anchor questions can contain words such as
  // "find" without executing the native find command.
  if (scipQuery) {
    if (MIXED_NATIVE_SEARCH.test(command)) return { surface: 'native-search', kind: 'query' };
    if (MIXED_NATIVE_READ.test(command)) return { surface: 'native-read', kind: 'query' };
    if (/\bscip-query\s+status\b/iu.test(command)) return { surface: 'scip-query', kind: 'status' };
    if (/\bscip-query\s+continue\b/iu.test(command) || /--output-cursor\b/u.test(command)) {
      return { surface: 'scip-query', kind: 'continuation' };
    }
    return { surface: 'scip-query', kind: 'query' };
  }
  if (NATIVE_SEARCH.test(command)) return { surface: 'native-search', kind: 'query' };
  if (NATIVE_READ.test(command) || SCRIPTED_READ.test(command)) return { surface: 'native-read', kind: 'query' };
  return { surface: 'other', kind: 'other' };
}

function isSkillInstructionRead(command) {
  const fileOperands = command.match(/skills\/[A-Za-z0-9_.:-]+\/SKILL\.md/giu) ?? [];
  if (fileOperands.length === 0) return false;
  const withoutSkillPaths = fileOperands.reduce((remaining, operand) => remaining.replace(operand, ' '), command);
  return !/(?:^|\s)(?:src|tests|scripts|docs|benchmarks)\//u.test(withoutSkillPaths);
}

function commandText(value) {
  if (typeof value === 'string' && value.trim() !== '') return value;
  if (Array.isArray(value) && value.length > 0) return value.map(String).join(' ');
  throw new Error('completed command event has no command text');
}

function outputText(item) {
  for (const value of [item.aggregated_output, item.output, item.stdout]) {
    if (typeof value === 'string') return value;
  }
  return '';
}

function parseUsage(value) {
  if (!value || typeof value !== 'object') throw new Error('turn.completed has no usage object');
  return {
    inputTokens: tokenCount(value.input_tokens, 'input_tokens'),
    cachedInputTokens: tokenCount(value.cached_input_tokens, 'cached_input_tokens'),
    outputTokens: tokenCount(value.output_tokens, 'output_tokens'),
    reasoningOutputTokens: tokenCount(value.reasoning_output_tokens, 'reasoning_output_tokens'),
  };
}

function tokenCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid Codex usage ${label}`);
  return value;
}
