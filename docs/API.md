# Programmatic API

Every CLI command is also available as a TypeScript function. The `queries` namespace exports cover the public commands, including the `top*` variants of `fan-in`, `fan-out`, and `coupling`, plus `similarAll` for the cross-codebase mode of `similar`.

```typescript
import { ScipDatabase, createGitignoreFilter } from 'scip-query';
import {
  health,
  affected,
  changeSurface,
  diffImpact,
  hotspots,
  similar,
  dead,
  convergence,
} from 'scip-query/queries';

const filter = createGitignoreFilter('/path/to/project');
const db = new ScipDatabase(
  {
    dbPath: '/path/to/index.db',
    indexPath: '/path/to/index.scip',
    projectRoot: '/path/to/project',
  },
  filter,
);

const report = health(db);
console.log(`Score: ${report.score}/100`);
console.log(`Actions: ${report.actions.length}`);

const blast = affected(db, 'login', { maxDepth: 3 });
const brief = changeSurface(db, 'auth.service.ts');
const impact = diffImpact(db, { base: 'main' });

const pairs = similar(db, 'myFunction', { minSimilarity: 0.5 });
const recipe = convergence(db, 'funcA', 'funcB');

db.close();
```
