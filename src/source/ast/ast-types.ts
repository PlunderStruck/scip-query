export interface Tree {
  rootNode: SyntaxNode;
  /**
   * Cursor traversal reads node types and text without materializing a
   * wrapper object per node. Prefer it for whole-file sweeps: every node
   * object pins native cache memory that a synchronous sweep cannot release
   * before it finishes.
   */
  walk(): TreeCursor;
}

export interface TreeCursor {
  nodeType: string;
  nodeText: string;
  /** Materializes a node object for the cursor position; costs native cache memory, so read `nodeType` first. */
  readonly currentNode: SyntaxNode;
  gotoFirstChild(): boolean;
  gotoNextSibling(): boolean;
  gotoParent(): boolean;
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
  walk(): TreeCursor;
}

export interface QueryInstance {
  captures(node: SyntaxNode): Array<{ name: string; node: SyntaxNode }>;
  matches(node: SyntaxNode): Array<{ pattern: number; captures: Array<{ name: string; node: SyntaxNode }> }>;
}
