"""Exercise all six frontend CLI producers on positive source fixtures."""
import json
import os
from pathlib import Path
import subprocess

REPO = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent / 'frontend'
OUT.mkdir(exist_ok=True)
ROOT = Path((OUT.parent / 'controls/project.txt').read_text())
ENV = {k: v for k, v in os.environ.items() if not k.startswith('SCIP_QUERY_')}
ENV.update(SCIP_QUERY_PROJECT_ROOT=str(ROOT), SCIP_QUERY_CACHE_DIR=str(ROOT / '.cache'), SCIP_QUERY_SKIP_WATCH_SERVICE='1', SCIP_QUERY_SKIP_AUTO_INSTALL='1')
claims = []

def invoke(name, args, json_result=True):
    output = OUT / (name + '.json')
    p = subprocess.run(['node', str(REPO / 'dist/cli.js'), *args, *(['--json', '--json-output', str(output)] if json_result else [])], cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=180)
    (OUT / (name + '.log')).write_text(p.stdout + p.stderr)
    claims.append({'case': name, 'passed': p.returncode == 0, 'exit': p.returncode})
    return json.loads(output.read_text())['result'] if json_result and p.returncode == 0 else None

config = json.loads((ROOT / 'tsconfig.json').read_text())
config['compilerOptions']['jsx'] = 'preserve'
config['include'] = ['src/**/*.ts', 'src/**/*.tsx']
(ROOT / 'tsconfig.json').write_text(json.dumps(config))
folder = ROOT / 'src/frontend'
folder.mkdir(exist_ok=True)
(folder / 'ambient.d.ts').write_text('declare namespace JSX { interface IntrinsicElements { [name: string]: any } }\ndeclare module "react" { export function useState<T>(value: T): [T, (value: T) => void]; export function useEffect(callback: () => void, deps: unknown[]): void; }\n')
props = ' '.join(f'data-shared-{i}="value"' for i in range(9))
for name in ['Alpha', 'Beta']:
    react = ['import { useState, useEffect } from "react";', f'export function {name}() {{', '  const [invoice, setInvoice] = useState(0);', '  const [customer, setCustomer] = useState(0);', '  const [loading, setLoading] = useState(false);', '  useEffect(() => { fetch("/invoices"); }, []);', '  function saveInvoice() { setInvoice(invoice + 1); }', '  function updateCustomer() { setCustomer(customer + 1); }', '  function submitOrder() { setLoading(true); }', *[f'  const pad{n} = {n};' for n in range(310)], f'  return <section {props}><input value={{invoice}} onChange={{saveInvoice}} /><button onClick={{submitOrder}}>Save</button></section>;', '}']
    (folder / (name + '.tsx')).write_text('\n'.join(react) + '\n')
    vue = ['<script setup lang="ts">', 'import { ref, onMounted } from "vue";', 'const invoice = ref(0);', 'const customer = ref(0);', 'const loading = ref(false);', 'onMounted(() => { fetch("/invoices"); });', 'function saveInvoice() { invoice.value++; }', 'function updateCustomer() { customer.value++; }', 'function submitOrder() { loading.value = true; }', '</script>', '<template>', f'<section {props}><input v-model="invoice" @change="saveInvoice" /><button @click="submitOrder">Save</button></section>', '</template>', '<style scoped>', *[f'.pad{n} {{ color: red; }}' for n in range(820)], '</style>']
    (folder / (name + '.vue')).write_text('\n'.join(vue) + '\n')
try:
    invoke('reindex', ['reindex', '--language', 'typescript', '--force', '--trust-project-tools'], False)
    invoke('augment', ['augment-sources'], False)
    for command in ['react-component-duplicates', 'react-hook-candidates', 'react-large-component-pressure', 'vue-component-duplicates', 'vue-composable-candidates', 'vue-large-view-pressure']:
        result = invoke(command, [command, '--scope', 'src/frontend'])
        claims.append({'claim': command + ' returns a positive finding for the intended files', 'passed': isinstance(result, list) and len(result) > 0 and all((r.get('file') or r.get('fileA', '')).startswith('src/frontend/') for r in result)})
        if command == 'react-large-component-pressure' and isinstance(result, list):
            claims.append({'claim': 'React pressure reports the exact constructed component and file line counts', 'passed': len(result) == 2 and all(r['componentLines'] == 320 and r['fileLines'] == 322 for r in result)})
        if command == 'vue-large-view-pressure' and isinstance(result, list):
            claims.append({'claim': 'Vue pressure reports the exact constructed SFC and style line counts', 'passed': len(result) == 2 and all(r['sfcLines'] == 836 and r['styleLines'] == 822 and r['dominantPressure'] == 'style' for r in result)})
        if isinstance(result, list) and result and 'tokenCountA' in result[0]:
            row = result[0]
            claims.append({'claim': command + ' accounts for all shared and unique tokens', 'passed': row['tokenCountA'] == len(row['sharedTokens']) + len(row['uniqueToA']) and row['tokenCountB'] == len(row['sharedTokens']) + len(row['uniqueToB'])})
            if 'component-duplicates' in command:
                denominator = len(row['sharedTokens']) + len(row['uniqueToA']) + len(row['uniqueToB'])
                claims.append({'claim': command + ' reports reproducible Jaccard similarity', 'passed': abs(row['similarity'] - len(row['sharedTokens']) / denominator) < 1e-8})
        negative = invoke(command + '-missing', [command, '--scope', 'missing-directory/'])
        claims.append({'claim': command + ' excludes unrelated files', 'passed': negative == []})
finally:
    (OUT / 'results.json').write_text(json.dumps(claims, indent=2) + '\n')
print(json.dumps({'cases': len(claims), 'failed': [c for c in claims if not c['passed']]}, indent=2))
raise SystemExit(int(any(not c['passed'] for c in claims)))
