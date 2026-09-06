"""Create a disposable repository with known source facts; prints its root."""
import json
from pathlib import Path
import subprocess
import tempfile

root = Path(tempfile.mkdtemp(prefix='scip-full-audit-fixture-')).resolve()
(root / 'src').mkdir()
(root / 'tests').mkdir()
files = {
    'package.json': json.dumps({'name': 'audit-fixture', 'version': '1.0.0', 'type': 'module', 'exports': './src/main.ts'}),
    '.gitignore': '.cache/\n.scipquery/\nnode_modules/\n',
    '.scipquery.json': json.dumps({'schemaVersion': 2, 'watch': {'enabled': False, 'autoStart': False}}),
    'tsconfig.json': json.dumps({'compilerOptions': {'module': 'NodeNext', 'moduleResolution': 'NodeNext', 'target': 'ES2022', 'skipLibCheck': True}, 'include': ['src/**/*.ts', 'tests/**/*.ts']}),
    'src/math.ts': 'export function choose(x: number) {\n  if (x > 0) return 1;\n  else if (x < 0) return -1;\n  return 0;\n}\nexport function outer(x: number) {\n  function inner() { if (x) return 1; return 0; }\n  return inner;\n}\nexport function nullable(x?: {value: number}) { return x?.value ?? 0; }\n',
    'src/main.ts': "import { choose } from './math.js';\nexport function run(x: number) { return choose(x); }\n",
    'src/flow.ts': 'export function calculate(input: number, discarded: number) {\n  let value = discarded;\n  value = input + 1;\n  const unrelated = discarded * 2;\n  return value;\n}\n',
    'src/stub.ts': "export function validateAlways(value: unknown) { return true; }\nexport function unbuilt() { throw new Error('not implemented'); }\nexport function entry(value: unknown) { if (validateAlways(value)) return unbuilt(); return false; }\n",
    'src/deleted.ts': 'export const gone = 1;\n',
    'tests/assertion-free.test.ts': "declare function test(name: string, run: () => void): void;\ntest('does no assertion', () => { const value = 1 + 2; });\n",
}
for name, content in files.items():
    (root / name).write_text(content)
subprocess.run(['git', 'init', '-q'], cwd=root, check=True)
subprocess.run(['git', 'add', '.'], cwd=root, check=True)
subprocess.run(['git', '-c', 'user.name=Audit', '-c', 'user.email=audit@example.invalid', 'commit', '-qm', 'audit fixture'], cwd=root, check=True)
print(root)
