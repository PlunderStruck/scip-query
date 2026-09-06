"""Create disposable, compiler-indexable inputs for the follow-up audit."""
import json
import pathlib
import subprocess
import tempfile

root = pathlib.Path(tempfile.mkdtemp(prefix='scip-followup-audit-'))
(root / 'src').mkdir()
(root / 'package.json').write_text(json.dumps({'name': 'accuracy-followup', 'version': '1.0.0', 'private': True}))
(root / 'tsconfig.json').write_text(json.dumps({'compilerOptions': {'target': 'ES2022', 'module': 'CommonJS', 'strict': True}, 'include': ['src/**/*.ts']}))
(root / '.scipquery.json').write_text(json.dumps({'watch': {'enabled': False}}))
(root / 'src/calls.ts').write_text('''export function helper(value: number) { return value + 1; }
export function returnedReference() { return helper; }
export function arrayReference() { return [helper]; }
export function actualCall() { return helper(2); }
export function nestedOwner() {
  function nested() { return helper(3); }
  return nested;
}
export function nullish(value: number | null) { return value ?? 0; }
export function nestedMetric(value: number) {
  function nested(x: number) { if (x) return 1; return 0; }
  return nested;
}
export function sameLineBranches(x: boolean) { if (x) return 1; return 0; }
''')
(root / 'src/flow.ts').write_text('''export function aggregateAlias(state: { value: number }, input: number) {
  const holder = { ref: state };
  holder.ref.value = input;
  return state.value;
}
export function arrayAlias(state: { value: number }, input: number) {
  const holder = [state];
  holder[0].value = input;
  return state.value;
}
export function deleteMutation(state: { value?: number }, input: number) {
  state.value = input;
  delete state.value;
  return state.value;
}
export function compoundLogical(state: { value: number }, input: number) {
  let value = state.value;
  value ||= input;
  return value;
}
export function mutate(state: { value: number }, input: number) { state.value = input; }
export function callMutation(state: { value: number }, input: number) {
  mutate(state, input);
  return state.value;
}
''')
(root / 'src/first.ts').write_text('export function sharedName(value: number) { return value; }\n')
(root / 'src/second.ts').write_text('export function sharedName(value: number) { if (value) return 1; return 0; }\n')
for args in (['init', '-q'], ['add', '.'], ['-c', 'user.name=Audit', '-c', 'user.email=audit@example.com', 'commit', '-qm', 'audit baseline']):
    subprocess.run(['git', *args], cwd=root, check=True, capture_output=True)
print(root)
