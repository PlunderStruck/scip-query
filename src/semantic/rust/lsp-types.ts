export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspLocation {
  uri: string;
  range: LspRange;
}

export interface LspLocationLink {
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
  originSelectionRange?: LspRange;
}

export interface LspTextDocumentIdentifier {
  uri: string;
}

export interface LspReferenceContext {
  includeDeclaration: boolean;
}

export interface LspReferenceParams {
  textDocument: LspTextDocumentIdentifier;
  position: LspPosition;
  context: LspReferenceContext;
}

export interface LspTextDocumentPositionParams {
  textDocument: LspTextDocumentIdentifier;
  position: LspPosition;
}

export interface LspCallHierarchyItem {
  name: string;
  kind: number;
  uri: string;
  range: LspRange;
  selectionRange: LspRange;
  detail?: string;
  data?: unknown;
}

export interface LspCallHierarchyOutgoingCall {
  to: LspCallHierarchyItem;
  fromRanges: LspRange[];
}

export type LspMarkedString = string | { language: string; value: string };

export interface LspMarkupContent {
  kind: 'plaintext' | 'markdown';
  value: string;
}

export interface LspHover {
  contents: LspMarkupContent | LspMarkedString | LspMarkedString[];
  range?: LspRange;
}

export interface LspInitializeParams {
  processId?: number | null;
  rootUri: string | null;
  capabilities?: Record<string, unknown>;
  initializationOptions?: Record<string, unknown>;
}

export interface LspInitializeResult {
  capabilities: {
    referencesProvider?: boolean | Record<string, unknown>;
    definitionProvider?: boolean | Record<string, unknown>;
    callHierarchyProvider?: boolean | Record<string, unknown>;
    hoverProvider?: boolean | Record<string, unknown>;
    [key: string]: unknown;
  };
}
