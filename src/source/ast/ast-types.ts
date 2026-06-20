export interface Tree {
  rootNode: SyntaxNode;
}

export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  childCount: number;
  namedChildCount: number;
  children: SyntaxNode[];
  namedChildren: SyntaxNode[];
  parent: SyntaxNode | null;
  child(index: number): SyntaxNode | null;
  namedChild(index: number): SyntaxNode | null;
  childForFieldName(name: string): SyntaxNode | null;
  descendantsOfType(type: string | string[]): SyntaxNode[];
}

export interface QueryInstance {
  captures(node: SyntaxNode): Array<{ name: string; node: SyntaxNode }>;
  matches(node: SyntaxNode): Array<{ pattern: number; captures: Array<{ name: string; node: SyntaxNode }> }>;
}
