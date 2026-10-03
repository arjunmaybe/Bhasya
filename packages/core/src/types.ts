/** Canonical domain contracts (frozen model, TS execution of shared core). */
export type NodeType =
  | 'document' | 'heading' | 'section' | 'paragraph'
  | 'list' | 'list_item' | 'quote' | 'code' | 'figure' | 'caption';

export interface CanonicalNode {
  id: string;
  parentId: string | null;
  nodeType: NodeType;
  ordinal: number;
  depth: number;
  structuralPath: string;
  text: string;
  attrs: Record<string, unknown>;
}

export interface CanonicalPassage {
  nodeId: string;
  ordinal: number;
  structuralPath: string;
  text: string;
  textHash: string;
}

export interface CanonicalDocument {
  title: string;
  lang: string;
  nodes: CanonicalNode[];
  passages: CanonicalPassage[];
  contentHash: string;
}

export interface WebLocator {
  kind: 'web-html';
  passageId?: string;
  nodePath: string;
  startOffset: number;
  endOffset: number;
  prefix: string;
  suffix: string;
  cssHint?: string;
}

export interface AnchorContract {
  documentVersionId: string;
  nodeId: string;
  passageId?: string;
  selectedText: string;
  startOffset: number;
  endOffset: number;
  textHash: string;
  structuralPath: string;
  contextFingerprint: string;
  locator: WebLocator;
}

export type ScopeLevel = 'L0' | 'L1' | 'L2' | 'L3';
