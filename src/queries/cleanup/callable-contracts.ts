import type { IndexedDefinition } from '../../domain/types.js';
import { getAst } from '../../source/ast.js';
import type { ScipDatabase } from '../../storage/db.js';

const REACT_CLASS_LIFECYCLE_METHODS = new Set([
  'componentDidCatch',
  'componentDidMount',
  'componentDidUpdate',
  'componentWillUnmount',
  'getDerivedStateFromError',
  'getDerivedStateFromProps',
  'getSnapshotBeforeUpdate',
  'render',
  'shouldComponentUpdate',
  'UNSAFE_componentWillMount',
  'UNSAFE_componentWillReceiveProps',
  'UNSAFE_componentWillUpdate',
]);

export function isFrameworkContractCallable(db: ScipDatabase, definition: IndexedDefinition): boolean {
  if (!definition.parentTypeName || !/\.[cm]?[jt]sx?$/.test(definition.relativePath)) return false;
  const tree = getAst(db, definition.relativePath);
  if (!tree) return false;

  const method = tree.rootNode
    .descendantsOfType('method_definition')
    .find((node) => node.startPosition.row <= definition.startLine && node.endPosition.row >= definition.endLine);
  if (!method) return false;
  if (/\boverride\b/.test(method.text.slice(0, Math.max(0, method.text.indexOf('{'))))) return true;

  let container = method.parent;
  while (container && container.type !== 'class_declaration' && container.type !== 'class')
    container = container.parent;
  if (!container) return false;
  const header = container.text.slice(0, Math.max(0, container.text.indexOf('{')));
  if (/\bimplements\b/.test(header)) return true;
  // A derived class can satisfy a runtime protocol without spelling
  // `override` (many framework base classes predate noImplicitOverride).
  // Static call graphs cannot prove those dispatch edges, so methods on a
  // derived class are not safe "unreferenced" candidates.
  if (/\bextends\b/.test(header)) return true;
  return (
    REACT_CLASS_LIFECYCLE_METHODS.has(definition.leaf) &&
    /\bextends\s+(?:React\.)?(?:Component|PureComponent)\b/.test(header)
  );
}
