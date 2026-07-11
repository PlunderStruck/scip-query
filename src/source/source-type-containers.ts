import type { AstLanguage } from './ast/ast-language.js';
import type { SyntaxNode, Tree } from './ast/ast-types.js';

export function buildTypeContainerMap(tree: Tree, language: AstLanguage): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  const link = (child: string, container: string): void => {
    if (child === container) return;
    let bucket = result.get(child);
    if (!bucket) {
      bucket = new Set();
      result.set(child, bucket);
    }
    bucket.add(container);
  };

  const refTypes = language === 'python' ? new Set(['identifier']) : new Set(['type_identifier']);
  const collectChildren = (root: SyntaxNode, container: string): void => {
    const walk = (node: SyntaxNode): void => {
      if (refTypes.has(node.type) && node.text !== container) {
        link(node.text, container);
      }
      for (const child of node.children) walk(child);
    };
    for (const child of root.children) walk(child);
  };

  if (language === 'rust') {
    for (const node of tree.rootNode.descendantsOfType(['struct_item', 'enum_item', 'union_item', 'type_item'])) {
      const name = node.namedChildren.find((child) => child.type === 'type_identifier')?.text;
      if (!name) continue;
      const body = node.namedChildren.find(
        (child) =>
          child.type === 'field_declaration_list' ||
          child.type === 'enum_variant_list' ||
          child.type === 'ordered_field_declaration_list',
      );
      if (body) collectChildren(body, name);
      if (node.type === 'type_item') collectChildren(node, name);
    }
  } else if (language === 'python') {
    for (const cls of tree.rootNode.descendantsOfType('class_definition')) {
      const name = cls.namedChildren.find((child) => child.type === 'identifier')?.text;
      if (!name) continue;
      // Python base classes are type consumers too. A framework/schema class
      // commonly stays live only because another model subclasses it, so
      // omitting the class header makes the base look unreferenced.
      const superclasses = cls.childForFieldName('superclasses');
      if (superclasses) collectChildren(superclasses, name);
      const body = cls.namedChildren.find((child) => child.type === 'block');
      if (!body) continue;
      for (const typeNode of body.descendantsOfType('type')) {
        for (const id of typeNode.descendantsOfType('identifier')) {
          if (id.text !== name) link(id.text, name);
        }
      }
    }
  } else {
    for (const node of tree.rootNode.descendantsOfType([
      'interface_declaration',
      'type_alias_declaration',
      'class_declaration',
    ])) {
      const name = node.namedChildren.find((child) => child.type === 'type_identifier')?.text;
      if (!name) continue;
      collectChildren(node, name);
    }
  }

  return result;
}
