import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const root = process.cwd();
const failures = [];

for (const file of markdownFiles(join(root, 'skills'))) {
  checkMarkdownLinks(file);
}

for (const file of markdownFiles(join(root, '.agents', 'skills'))) {
  checkMarkdownLinks(file);
}

for (const skill of builtinSkills()) {
  const metadataPath = join(root, 'skills', skill, 'agents', 'openai.yaml');
  if (!existsSync(metadataPath)) {
    failures.push(`missing Codex metadata: skills/${skill}/agents/openai.yaml`);
    continue;
  }
  const metadata = readFileSync(metadataPath, 'utf8');
  if (!/\bdefault_prompt\s*:/.test(metadata)) {
    failures.push(`missing default_prompt: skills/${skill}/agents/openai.yaml`);
  }
}

if (failures.length > 0) {
  console.error(failures.map((failure) => `- ${failure}`).join('\n'));
  process.exit(1);
}

function markdownFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}

function checkMarkdownLinks(file) {
  const content = readFileSync(file, 'utf8');
  const linkPattern = /\[[^\]]+\]\(([^)]+\.md(?:#[^)]+)?)\)/g;
  for (const match of content.matchAll(linkPattern)) {
    const rawTarget = match[1].trim().replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|#|\/)/.test(rawTarget)) continue;
    const [relativePath] = rawTarget.split('#');
    const target = resolve(dirname(file), relativePath);
    if (!existsSync(target)) {
      failures.push(`broken markdown link in ${relative(file)}: ${rawTarget}`);
    }
  }
}

function builtinSkills() {
  const source = readFileSync(join(root, 'src', 'runtime', 'setup.ts'), 'utf8');
  const match = source.match(/export const BUILTIN_SKILLS = \[([\s\S]*?)\] as const/);
  if (!match) {
    failures.push('could not parse BUILTIN_SKILLS from src/runtime/setup.ts');
    return [];
  }
  return [...match[1].matchAll(/'([^']+)'/g)].map((entry) => entry[1]);
}

function relative(path) {
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
