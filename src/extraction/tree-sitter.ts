/**
 * Tree-sitter Parser Wrapper
 *
 * Handles parsing source code and extracting structural information.
 */

import { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import * as path from 'path';
import {
  Language,
  Node,
  Edge,
  NodeKind,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
} from '../types';
import { getParser, detectLanguage, isLanguageSupported } from './grammars';
import { generateNodeId, getNodeText, getChildByField, getPrecedingDocstring } from './tree-sitter-helpers';
import type { LanguageExtractor, ExtractorContext } from './tree-sitter-types';
import { EXTRACTORS } from './languages';
import { LiquidExtractor } from './liquid-extractor';
import { SvelteExtractor } from './svelte-extractor';
import { DfmExtractor } from './dfm-extractor';
import { VueExtractor } from './vue-extractor';
import {
  getAllFrameworkResolvers,
  getApplicableFrameworks,
} from '../resolution/frameworks';

// Re-export for backward compatibility
export { generateNodeId } from './tree-sitter-helpers';

/**
 * Extract the name from a node based on language
 */
function extractName(node: SyntaxNode, source: string, extractor: LanguageExtractor): string {
  // Try field name first
  const nameNode = getChildByField(node, extractor.nameField);
  if (nameNode) {
    // Unwrap pointer_declarator(s) for C/C++ pointer return types
    let resolved = nameNode;
    while (resolved.type === 'pointer_declarator') {
      const inner = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      if (!inner) break;
      resolved = inner;
    }
    // Handle complex declarators (C/C++)
    if (resolved.type === 'function_declarator' || resolved.type === 'declarator') {
      const innerName = getChildByField(resolved, 'declarator') || resolved.namedChild(0);
      return innerName ? getNodeText(innerName, source) : getNodeText(resolved, source);
    }
    // Lua: `function t.f()` / `function t:m()` — the name node is a dot/method
    // index expression; the simple name is the trailing field/method (the table
    // receiver is captured separately via getReceiverType).
    if (resolved.type === 'dot_index_expression') {
      const field = getChildByField(resolved, 'field');
      if (field) return getNodeText(field, source);
    }
    if (resolved.type === 'method_index_expression') {
      const method = getChildByField(resolved, 'method');
      if (method) return getNodeText(method, source);
    }
    return getNodeText(resolved, source);
  }

  // For Dart method_signature, look inside inner signature types
  if (node.type === 'method_signature') {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (
        child.type === 'function_signature' ||
        child.type === 'getter_signature' ||
        child.type === 'setter_signature' ||
        child.type === 'constructor_signature' ||
        child.type === 'factory_constructor_signature'
      )) {
        // Find identifier inside the inner signature
        for (let j = 0; j < child.namedChildCount; j++) {
          const inner = child.namedChild(j);
          if (inner?.type === 'identifier') {
            return getNodeText(inner, source);
          }
        }
      }
    }
  }

  // Arrow/function expressions get their name from the parent variable_declarator,
  // not from identifiers in their body. Without this, single-expression arrow
  // functions like `const fn = () => someIdentifier` get named "someIdentifier"
  // instead of "fn", because the fallback below finds the body identifier.
  if (node.type === 'arrow_function' || node.type === 'function_expression') {
    return '<anonymous>';
  }

  // Fall back to first identifier child
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (
      child &&
      (child.type === 'identifier' ||
        child.type === 'type_identifier' ||
        child.type === 'simple_identifier' ||
        child.type === 'constant')
    ) {
      return getNodeText(child, source);
    }
  }

  return '<anonymous>';
}

/**
 * Tree-sitter node kinds that represent constructor invocations
 * (`new Foo()` and friends). Used by extractInstantiation to emit
 * an `instantiates` reference targeting the class name.
 */
const INSTANTIATION_KINDS: ReadonlySet<string> = new Set([
  'new_expression',                  // typescript / javascript / tsx / jsx
  'object_creation_expression',      // java / c#
  'instance_creation_expression',    // some grammars
]);

/**
 * TreeSitterExtractor - Main extraction class
 */
export class TreeSitterExtractor {
  private filePath: string;
  private language: Language;
  private source: string;
  private tree: Tree | null = null;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];
  private extractor: LanguageExtractor | null = null;
  private nodeStack: string[] = []; // Stack of parent node IDs
  private methodIndex: Map<string, string> | null = null; // lookup key → node ID for Pascal defProc lookup
  private _callEnrich: Map<string, Set<string>> | undefined; // callerId → callee names for FTS enrichment
  private isExtractingPattern = false; // true while inside extractPatternReferences via match/if-let/matches!

  constructor(filePath: string, source: string, language?: Language) {
    this.filePath = filePath;
    this.source = source;
    this.language = language || detectLanguage(filePath, source);
    this.extractor = EXTRACTORS[this.language] || null;
  }

  /**
   * Parse and extract from the source code
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    if (!isLanguageSupported(this.language)) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Unsupported language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'unsupported_language',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    const parser = getParser(this.language);
    if (!parser) {
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [
          {
            message: `Failed to get parser for language: ${this.language}`,
            filePath: this.filePath,
            severity: 'error',
            code: 'parser_error',
          },
        ],
        durationMs: Date.now() - startTime,
      };
    }

    try {
      this.tree = parser.parse(this.source) ?? null;
      if (!this.tree) {
        throw new Error('Parser returned null tree');
      }

      // Create file node representing the source file
      const fileNode: Node = {
        id: `file:${this.filePath}`,
        kind: 'file',
        name: path.basename(this.filePath),
        qualifiedName: this.filePath,
        filePath: this.filePath,
        language: this.language,
        startLine: 1,
        endLine: this.source.split('\n').length,
        startColumn: 0,
        endColumn: 0,
        isExported: false,
        updatedAt: Date.now(),
      };
      this.nodes.push(fileNode);

      // Push file node onto stack so top-level declarations get contains edges
      this.nodeStack.push(fileNode.id);
      this.visitNode(this.tree.rootNode);
      this.nodeStack.pop();

      // Bevy framework fallback: regex-scan chained add_systems patterns
      // that the AST walker may miss (deeply nested field_expression chains).
      if (this.language === 'rust') {
        this.scanBevyPatternsFallback();
      }

      // Flush call enrichment: append tracked external method calls to
      // caller node signatures so they are FTS-searchable.
      if (this._callEnrich && this._callEnrich.size > 0) {
        for (const [callerId, callees] of this._callEnrich) {
          const node = this.nodes.find(n => n.id === callerId);
          if (node && callees.size > 0) {
            const calls = [...callees].sort().join(', ');
            const entry = `calls: ${calls}`;
            node.signature = node.signature ? `${node.signature}; ${entry}` : entry;
          }
        }
        this._callEnrich.clear();
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);

      // WASM memory errors leave the module in a corrupted state — all subsequent
      // parses would also fail. Re-throw so the worker can detect and crash,
      // forcing a clean restart with a fresh heap.
      if (msg.includes('memory access out of bounds') || msg.includes('out of memory')) {
        throw error;
      }

      this.errors.push({
        message: `Parse error: ${msg}`,
        filePath: this.filePath,
        severity: 'error',
        code: 'parse_error',
      });
    } finally {
      // Free tree-sitter WASM memory immediately — trees hold native heap memory
      // invisible to V8's GC that accumulates across thousands of files.
      if (this.tree) {
        this.tree.delete();
        this.tree = null;
      }
      // Release source string to reduce GC pressure
      this.source = '';
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Visit a node and extract information
   */
  private visitNode(node: SyntaxNode): void {
    if (!this.extractor) return;

    const nodeType = node.type;
    let skipChildren = false;

    // Language-specific custom visitor hook
    if (this.extractor.visitNode) {
      const ctx = this.makeExtractorContext();
      const handled = this.extractor.visitNode(node, ctx);
      if (handled) return;
    }

    // Pascal-specific AST handling
    if (this.language === 'pascal') {
      skipChildren = this.visitPascalNode(node);
      if (skipChildren) return;
    }

    // Check for function declarations
    // For Python/Ruby, function_definition inside a class should be treated as method
    if (this.extractor.functionTypes.includes(nodeType)) {
      if (this.isInsideClassLikeNode() && this.extractor.methodTypes.includes(nodeType)) {
        // Inside a class - treat as method
        this.extractMethod(node);
        skipChildren = true; // extractMethod visits children via visitFunctionBody
      } else {
        this.extractFunction(node);
        skipChildren = true; // extractFunction visits children via visitFunctionBody
      }
    }
    // Check for class declarations
    else if (this.extractor.classTypes.includes(nodeType)) {
      // Some languages reuse class_declaration for structs/enums (e.g. Swift)
      const classification = this.extractor.classifyClassNode?.(node) ?? 'class';
      if (classification === 'struct') {
        this.extractStruct(node);
      } else if (classification === 'enum') {
        this.extractEnum(node);
      } else if (classification === 'interface') {
        this.extractInterface(node);
      } else if (classification === 'trait') {
        this.extractClass(node, 'trait');
      } else {
        this.extractClass(node);
      }
      skipChildren = true; // extractClass visits body children
    }
    // Extra class node types (e.g. Dart mixin_declaration, extension_declaration)
    else if (this.extractor.extraClassNodeTypes?.includes(nodeType)) {
      this.extractClass(node);
      skipChildren = true;
    }
    // Check for method declarations (only if not already handled by functionTypes)
    else if (this.extractor.methodTypes.includes(nodeType)) {
      this.extractMethod(node);
      skipChildren = true; // extractMethod visits children via visitFunctionBody
    }
    // Check for interface/protocol/trait declarations
    else if (this.extractor.interfaceTypes.includes(nodeType)) {
      this.extractInterface(node);
      skipChildren = true; // extractInterface visits body children
    }
    // Check for struct declarations
    else if (this.extractor.structTypes.includes(nodeType)) {
      this.extractStruct(node);
      skipChildren = true; // extractStruct visits body children
    }
    // Check for enum declarations
    else if (this.extractor.enumTypes.includes(nodeType)) {
      this.extractEnum(node);
      skipChildren = true; // extractEnum visits body children
    }
    // Check for type alias declarations (e.g. `type X = ...` in TypeScript)
    // For Go, type_spec wraps struct/interface definitions — resolveTypeAliasKind
    // detects these and extractTypeAlias creates the correct node kind.
    else if (this.extractor.typeAliasTypes.includes(nodeType)) {
      skipChildren = this.extractTypeAlias(node);
    }
    // Check for class properties (e.g. C# property_declaration)
    else if (this.extractor.propertyTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractProperty(node);
      skipChildren = true;
    }
    // Check for class fields (e.g. Java field_declaration, C# field_declaration)
    else if (this.extractor.fieldTypes?.includes(nodeType) && this.isInsideClassLikeNode()) {
      this.extractField(node);
      skipChildren = true;
    }
    // Check for variable declarations (const, let, var, etc.)
    // Only extract top-level variables (not inside functions/methods)
    else if (this.extractor.variableTypes.includes(nodeType) && !this.isInsideClassLikeNode()) {
      this.extractVariable(node);
      skipChildren = true; // extractVariable handles children
    }
    // `export_statement` itself is not extracted — the walker descends
    // into children, where the inner declaration (lexical_declaration,
    // function_declaration, class_declaration, etc.) is dispatched to
    // its own extractor. `isExported` walks the parent chain, so the
    // exported flag is preserved automatically.
    //
    // Calling extractExportedVariables here AND descending caused every
    // `export const X = ...` to produce two nodes for the same symbol —
    // one kind:'variable' from extractExportedVariables and one
    // kind:'constant' from extractVariable. The dedicated dispatch is
    // the correct one (it picks kind from isConst, captures the
    // initializer signature, and walks type annotations); the
    // export-statement helper was redundant.
    // Check for imports
    else if (this.extractor.importTypes.includes(nodeType)) {
      this.extractImport(node);
    }
    // Check for function calls
    else if (this.extractor.callTypes.includes(nodeType)) {
      this.extractCall(node);
    }
    // `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
    // produce an `instantiates` reference. Children still walked so
    // nested calls inside the constructor args (`new Foo(bar())`) get
    // their own `calls` refs.
    else if (INSTANTIATION_KINDS.has(nodeType)) {
      this.extractInstantiation(node);
    }
    // (Decorator handling lives inside the symbol-creating extractors
    // — extractClass / extractFunction / extractProperty — because the
    // decorator node sits BEFORE the symbol in the AST and the walker
    // would otherwise see the wrong nodeStack head.)
    // Rust: `impl Trait for Type { ... }` — creates implements edge from Type to Trait
    else if (nodeType === 'impl_item') {
      this.extractRustImplItem(node);
    }
    // match expressions: extract enum variant references from match arms.
    // Flag is saved/restored so child recursion sees isExtractingPattern=true
    // and skips scoped_identifier duplicate extraction.
    else if (nodeType === 'match_expression') {
      const saved = this.isExtractingPattern;
      this.isExtractingPattern = true;
      this.extractMatchReferences(node);
      // Visit children with flag still true so scoped_identifiers in patterns are skipped
      if (!skipChildren) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) this.visitNode(child);
        }
      }
      this.isExtractingPattern = saved;
      return;
    }
    // if let expressions: extract enum variant references from the pattern
    else if (nodeType === 'if_let_expression') {
      const saved = this.isExtractingPattern;
      this.isExtractingPattern = true;
      this.extractIfLetReferences(node);
      if (!skipChildren) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) this.visitNode(child);
        }
      }
      this.isExtractingPattern = saved;
      return;
    }
    // macro_invocation: for `matches!` extract pattern references from the
    // second argument. For other macros, walk token_tree args to capture
    // PascalCase identifiers that may be enum variants passed to the macro.
    else if (nodeType === 'macro_invocation') {
      const saved = this.isExtractingPattern;
      this.isExtractingPattern = true;
      this.extractMacroCall(node);
      this.extractMatchesMacroReferences(node);
      // For non-matches! macros, also walk token_tree args for variant refs
      this.extractMacroInvocationArgs(node);
      if (!skipChildren) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) this.visitNode(child);
        }
      }
      this.isExtractingPattern = saved;
      return;
    }
    // scoped_identifier in expression context (e.g. Enum::Variant as a value,
    // function argument, or method receiver). Pattern contexts set
    // isExtractingPattern and are skipped — they emit pattern_match edges separately.
    else if (nodeType === 'scoped_identifier' && !this.isExtractingPattern && this.nodeStack.length > 0) {
      this.extractScopedValueReference(node);
    }
    // Extract type references from generic_type and scoped_type_identifier
    // wherever they appear (signatures AND expression bodies). Captures type
    // arguments like `Action<导航上>` and turbofish `Action::<导航上>::new()`.
    else if ((nodeType === 'generic_type' || nodeType === 'scoped_type_identifier') && this.nodeStack.length > 0) {
      // Skip if direct child of impl_item — extractRustImplItem handles type refs
      if (node.parent?.type !== 'impl_item') {
        const fromNodeId = this.nodeStack[this.nodeStack.length - 1];
        if (fromNodeId && !fromNodeId.startsWith('file:')) {
          this.extractTypeRefsFromSubtree(node, fromNodeId);
        }
      }
    }
    // type_arguments in expression context (e.g., turbofish Action::<导航上>::new())
    // — the type_arguments node is a direct child of scoped_identifier here, not
    // nested under generic_type, so the generic_type handler above misses it.
    else if (nodeType === 'type_arguments' && this.language === 'rust' && this.nodeStack.length > 0) {
      const parent = node.parent;
      if (parent && (parent.type === 'generic_type' || parent.type === 'scoped_type_identifier')) {
        // Already handled by the parent node handler via extractTypeRefsFromSubtree
      } else {
        const fromNodeId = this.nodeStack[this.nodeStack.length - 1];
        if (fromNodeId && !fromNodeId.startsWith('file:')) {
          this.extractTypeRefsFromSubtree(node, fromNodeId, true);
        }
        skipChildren = true;
      }
    }
    // macro_definition: extract pattern_match references from token_tree bodies.
    // macro_rules! bodies often contain hardcoded match arms with Enum::Variant
    // references (scoped_identifier) that are invisible to standard match_expression
    // extraction because tree-sitter parses them as raw tokens, not structured AST.
    else if (nodeType === 'macro_definition') {
      const macroNameNode = getChildByField(node, 'name');
      const macroName = macroNameNode ? getNodeText(macroNameNode, this.source) : '<unknown>';
      const macroNode = this.createNode('function', macroName, node);
      if (macroNode) {
        this.nodeStack.push(macroNode.id);
        this.extractMacroTokenTreePatterns(node, macroNode.id);
        this.nodeStack.pop();
      }
      skipChildren = true;
    }

    // Visit children (unless the extract method already visited them)
    if (!skipChildren) {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          this.visitNode(child);
        }
      }
    }
  }

  /**
   * Create a Node object
   */
  private createNode(
    kind: NodeKind,
    name: string,
    node: SyntaxNode,
    extra?: Partial<Node>
  ): Node | null {
    // Skip nodes with empty/missing names — they are not meaningful symbols
    // and would cause FK violations when edges reference them (see issue #42)
    if (!name) {
      return null;
    }

    const id = generateNodeId(this.filePath, kind, name, node.startPosition.row + 1);

    // Some grammars (e.g. Dart) model a function/method body as a *sibling* of
    // the signature node, so the declaration node's own range is just the
    // signature line. Extend endLine to the resolved body when it sits beyond
    // the node so the node spans its body — required for any body-level analysis
    // (callees, the callback synthesizer's body scan, context slices). Guarded to
    // only ever extend: for child-body grammars the body is within range (no-op).
    let endLine = node.endPosition.row + 1;
    if (kind === 'function' || kind === 'method') {
      const body = this.extractor?.resolveBody?.(node, this.extractor.bodyField);
      if (body && body.endPosition.row + 1 > endLine) {
        endLine = body.endPosition.row + 1;
      }
    }

    const newNode: Node = {
      id,
      kind,
      name,
      qualifiedName: this.buildQualifiedName(name),
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      updatedAt: Date.now(),
      ...extra,
    };

    this.nodes.push(newNode);

    // Add containment edge from parent
    if (this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.edges.push({
          source: parentId,
          target: id,
          kind: 'contains',
        });
      }
    }

    return newNode;
  }

  /**
   * Find first named child whose type is in the given list.
   * Used to locate inner type nodes (e.g. enum_specifier inside a typedef).
   */
  private findChildByTypes(node: SyntaxNode, types: string[]): SyntaxNode | null {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && types.includes(child.type)) return child;
    }
    return null;
  }

  /**
   * Build qualified name from node stack
   */
  private buildQualifiedName(name: string): string {
    // Build a qualified name from the semantic hierarchy only (no file path).
    // The file path is stored separately in filePath and pollutes FTS if included here.
    const parts: string[] = [];
    for (const nodeId of this.nodeStack) {
      const node = this.nodes.find((n) => n.id === nodeId);
      if (node && node.kind !== 'file') {
        parts.push(node.name);
      }
    }
    parts.push(name);
    return parts.join('::');
  }

  /**
   * Build an ExtractorContext for passing to language-specific visitNode hooks.
   */
  private makeExtractorContext(): ExtractorContext {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      createNode: (kind, name, node, extra) => self.createNode(kind, name, node, extra),
      visitNode: (node) => self.visitNode(node),
      visitFunctionBody: (body, functionId) => self.visitFunctionBody(body, functionId),
      addUnresolvedReference: (ref) => self.unresolvedReferences.push(ref),
      pushScope: (nodeId) => self.nodeStack.push(nodeId),
      popScope: () => self.nodeStack.pop(),
      get filePath() { return self.filePath; },
      get source() { return self.source; },
      get nodeStack() { return self.nodeStack; },
      get nodes() { return self.nodes; },
    };
  }

  /**
   * Check if the current node stack indicates we are inside a class-like node
   * (class, struct, interface, trait). File nodes do not count as class-like.
   */
  private isInsideClassLikeNode(): boolean {
    if (this.nodeStack.length === 0) return false;
    const parentId = this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return false;
    const parentNode = this.nodes.find((n) => n.id === parentId);
    if (!parentNode) return false;
    return (
      parentNode.kind === 'class' ||
      parentNode.kind === 'struct' ||
      parentNode.kind === 'interface' ||
      parentNode.kind === 'trait' ||
      parentNode.kind === 'enum' ||
      parentNode.kind === 'module'
    );
  }

  /**
   * Extract a function
   */
  private extractFunction(node: SyntaxNode, nameOverride?: string): void {
    if (!this.extractor) return;

    // If the language provides getReceiverType and this function has a receiver
    // (e.g., Rust function_item inside an impl block), extract as method instead
    if (this.extractor.getReceiverType?.(node, this.source)) {
      this.extractMethod(node);
      return;
    }

    // nameOverride is supplied only for explicitly-named anonymous functions the
    // caller resolved itself (e.g. arrow values of exported-const object members
    // — SvelteKit actions). Inline-object arrows reached by the general walker
    // get no override, so they still fall through to the <anonymous> skip below.
    let name = nameOverride ?? extractName(node, this.source, this.extractor);
    // For arrow functions and function expressions assigned to variables,
    // resolve the name from the parent variable_declarator.
    // e.g. `export const useAuth = () => { ... }` — the arrow_function node
    // has no `name` field; the name lives on the variable_declarator.
    if (
      !nameOverride &&
      name === '<anonymous>' &&
      (node.type === 'arrow_function' || node.type === 'function_expression')
    ) {
      const parent = node.parent;
      if (parent?.type === 'variable_declarator') {
        const varName = getChildByField(parent, 'name');
        if (varName) {
          name = getNodeText(varName, this.source);
        }
      }
    }
    if (name === '<anonymous>') return; // Skip anonymous functions

    // Check for misparse artifacts (e.g. C++ macros causing "namespace detail" functions)
    // Skip the node but still visit the body for calls and structural nodes
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);

    const funcNode = this.createNode('function', name, node, {
      docstring,
      signature,
      visibility,
      isExported,
      isAsync,
      isStatic,
    });
    if (!funcNode) return;

    // Extract type annotations (parameter types and return type)
    this.extractTypeAnnotations(node, funcNode.id);

    // Extract decorators applied to the function (rare in JS/TS but
    // present in Python `@decorator def f():` and Java/Kotlin
    // annotations on free functions).
    this.extractDecoratorsFor(node, funcNode.id);

    // Push to stack and visit body
    this.nodeStack.push(funcNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, funcNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a class
   */
  private extractClass(node: SyntaxNode, kind: NodeKind = 'class'): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const classNode = this.createNode(kind, name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!classNode) return;

    // Extract extends/implements
    this.extractInheritance(node, classNode.id);

    // Extract decorators applied to the class (`@Foo class X {}`).
    this.extractDecoratorsFor(node, classNode.id);

    // Push to stack and visit body
    this.nodeStack.push(classNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;

    // Visit all children for methods and properties
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a method
   */
  private extractMethod(node: SyntaxNode): void {
    if (!this.extractor) return;

    // For languages with receiver types (Go, Rust), include receiver in qualified name
    // so FTS can match "scrapeLoop.run" → qualified_name "...::scrapeLoop::run"
    const receiverType = this.extractor.getReceiverType?.(node, this.source);

    // For most languages, only extract as method if inside a class-like node
    // Languages with methodsAreTopLevel (e.g. Go) always treat them as methods
    // Languages with getReceiverType (e.g. Rust) extract as method when receiver is found
    if (!this.isInsideClassLikeNode() && !this.extractor.methodsAreTopLevel && !receiverType) {
      // Skip method_definition nodes inside object literals (getters/setters/methods
      // in inline objects). These are ephemeral and create noise (e.g., Svelte context
      // objects: `ctx.set({ get view() { ... } })`).
      if (node.parent?.type === 'object' || node.parent?.type === 'object_expression') {
        return;
      }
      // Not inside a class-like node and no receiver type, treat as function
      this.extractFunction(node);
      return;
    }

    const name = extractName(node, this.source, this.extractor);

    // Check for misparse artifacts (e.g. C++ "switch" inside macro-confused class body)
    if (this.extractor.isMisparsedFunction?.(name, node)) {
      const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
        ?? getChildByField(node, this.extractor.bodyField);
      if (body) {
        this.visitFunctionBody(body, '');
      }
      return;
    }

    const docstring = getPrecedingDocstring(node, this.source);
    const signature = this.extractor.getSignature?.(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isAsync = this.extractor.isAsync?.(node);
    const isStatic = this.extractor.isStatic?.(node);
    const extraProps: Partial<Node> = {
      docstring,
      signature,
      visibility,
      isAsync,
      isStatic,
    };
    if (receiverType) {
      extraProps.qualifiedName = `${receiverType}::${name}`;
    }

    const methodNode = this.createNode('method', name, node, extraProps);
    if (!methodNode) return;

    // For methods with a receiver type but no class-like parent on the stack
    // (e.g., Rust impl blocks), add a contains edge from the owning struct/trait
    if (receiverType && !this.isInsideClassLikeNode()) {
      const ownerNode = this.nodes.find(
        (n) =>
          n.name === receiverType &&
          n.filePath === this.filePath &&
          (n.kind === 'struct' || n.kind === 'class' || n.kind === 'enum' || n.kind === 'trait')
      );
      if (ownerNode) {
        this.edges.push({
          source: ownerNode.id,
          target: methodNode.id,
          kind: 'contains',
        });
      }
    }

    // Extract type annotations (parameter types and return type)
    this.extractTypeAnnotations(node, methodNode.id);

    // Extract decorators (`@Get('/list') list() {}`).
    this.extractDecoratorsFor(node, methodNode.id);

    // Push to stack and visit body
    this.nodeStack.push(methodNode.id);
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.visitFunctionBody(body, methodNode.id);
    }
    this.nodeStack.pop();
  }

  /**
   * Extract an interface/protocol/trait
   */
  private extractInterface(node: SyntaxNode): void {
    if (!this.extractor) return;

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';

    const interfaceNode = this.createNode(kind, name, node, {
      docstring,
      isExported,
    });
    if (!interfaceNode) return;

    // Extract extends (interface inheritance)
    this.extractInheritance(node, interfaceNode.id);

    // Visit body children for interface methods and nested types
    this.nodeStack.push(interfaceNode.id);
    let body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (!body) body = node;
    for (let i = 0; i < body.namedChildCount; i++) {
      const child = body.namedChild(i);
      if (child) {
        this.visitNode(child);
      }
    }
    this.nodeStack.pop();
  }

  /**
   * Extract a struct
   */
  private extractStruct(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Skip forward declarations (no body = not a definition). Rust unit
    // structs (struct Foo;) and tuple structs (struct Foo(i32);) are valid
    // definitions without a body field, so Rust is excluded.
    if (this.language !== 'rust') {
      const body = getChildByField(node, this.extractor.bodyField);
      if (!body) return;
    }

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const structNode = this.createNode('struct', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!structNode) return;

    // Extract inheritance (e.g. Swift: struct HTTPMethod: RawRepresentable)
    this.extractInheritance(node, structNode.id);

    // Visit body children for field extraction.
    // If there is no body, this is a unit struct (Rust: `pub struct Foo;`)
    // or a forward declaration (C: `struct Foo;`). Both are valid symbols,
    // so we create the node but skip field visiting.
    const body = getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.nodeStack.push(structNode.id);
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (child) {
          this.visitNode(child);
        }
      }
      this.nodeStack.pop();
    }
  }

  /**
   * Extract an enum
   */
  private extractEnum(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Skip forward declarations (no body = not a definition). Same rule as
    // extractStruct: Rust is excluded because its enum definitions always
    // carry a body, but the guard is harmless either way.
    if (this.language !== 'rust') {
      const body = getChildByField(node, this.extractor.bodyField);
      if (!body) return;
    }

    const name = extractName(node, this.source, this.extractor);
    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isExported = this.extractor.isExported?.(node, this.source);

    const enumNode = this.createNode('enum', name, node, {
      docstring,
      visibility,
      isExported,
    });
    if (!enumNode) return;

    // Extract inheritance (e.g. Swift: enum AFError: Error)
    this.extractInheritance(node, enumNode.id);

    // Visit body children for enum member extraction.
    // If there is no body, this is a forward declaration (C: `enum Foo;`).
    // Still create the node but skip member visiting.
    const body = this.extractor.resolveBody?.(node, this.extractor.bodyField)
      ?? getChildByField(node, this.extractor.bodyField);
    if (body) {
      this.nodeStack.push(enumNode.id);
      const memberTypes = this.extractor.enumMemberTypes;
      for (let i = 0; i < body.namedChildCount; i++) {
        const child = body.namedChild(i);
        if (!child) continue;
        if (memberTypes?.includes(child.type)) {
          this.extractEnumMembers(child);
        } else {
          this.visitNode(child);
        }
      }
      this.nodeStack.pop();
    }
  }

  /**
   * Extract enum member names from an enum member node.
   * Handles multi-case declarations (Swift: `case put, delete`) and single-case patterns.
   */
  private extractEnumMembers(node: SyntaxNode): void {
    // Try field-based name first (e.g. Rust enum_variant has a 'name' field)
    const nameNode = getChildByField(node, 'name');
    if (nameNode) {
      const memberNode = this.createNode('enum_member', getNodeText(nameNode, this.source), node);
      // Extract type references from variant associated data fields
      // (e.g. Rust: `Variant(StructName)` or `Variant { field: Type }`)
      if (memberNode) {
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (!child) continue;
          if (child.type === 'field_declaration') {
            const fieldTypeNode = getChildByField(child, 'type');
            if (fieldTypeNode) {
              this.extractTypeRefsFromSubtree(fieldTypeNode, memberNode.id);
            }
          } else if (child.type === 'type_identifier' || child.type === 'scoped_type_identifier' || child.type === 'generic_type') {
            // Tuple variant: `Variant(TypeName)`
            this.extractTypeRefsFromSubtree(child, memberNode.id);
          }
        }
      }
      return;
    }

    // Check for identifier-like children (Swift: simple_identifier, TS: property_identifier)
    let found = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'simple_identifier' || child.type === 'identifier' || child.type === 'property_identifier')) {
        this.createNode('enum_member', getNodeText(child, this.source), child);
        found = true;
      }
    }

    // If the node itself IS the identifier (e.g. TS property_identifier directly in enum body)
    if (!found && node.namedChildCount === 0) {
      this.createNode('enum_member', getNodeText(node, this.source), node);
    }
  }

  /**
   * Extract enum variant references from match expression arms.
   * Creates `references` edges from the enclosing function/method to each
   * enum variant referenced in match patterns.
   */
  private extractMatchReferences(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    const arms: SyntaxNode[] = [];
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'match_arm') {
        arms.push(child);
      } else if (child.type === 'match_block') {
        for (let j = 0; j < child.namedChildCount; j++) {
          const arm = child.namedChild(j);
          if (arm && arm.type === 'match_arm') {
            arms.push(arm);
          }
        }
      }
    }
    for (const arm of arms) {
      this.extractPatternReferences(arm, callerId);
    }
  }

  /**
   * Extract enum variant references from if-let expressions.
   * The pattern lives in the let_condition child.
   */
  private extractIfLetReferences(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'let_condition' || child.type === 'match_pattern') {
        this.extractPatternReferences(child, callerId);
      } else if (child.type === 'scoped_identifier' || child.type === 'identifier') {
        this.extractPatternReferences(child, callerId);
      }
    }
  }

  /**
   * Extract enum variant references from the matches! macro invocation.
   * matches!(expr, Pattern::Variant) — the second argument is the pattern.
   */
  private extractMatchesMacroReferences(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Check if this is a `matches!` macro
    let isMatches = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'identifier' || child.type === 'macro_name'
          || child.type === 'scoped_identifier')) {
        const raw = getNodeText(child, this.source);
        const text = child.type === 'scoped_identifier' ? raw.split('::').pop()! : raw;
        if (text === 'matches') {
          isMatches = true;
          break;
        }
      }
    }
    if (!isMatches) return;

    // Find the single token_tree and extract pattern references from the
    // second argument (after the first comma separator). For `matches!(expr, Pattern)`
    // there is only one token_tree child containing both arguments.
    // Use .children (not .namedChildren) because the comma is an anonymous node.
    const tokenTree = node.namedChildren.find(c => c.type === 'token_tree');
    if (!tokenTree || !tokenTree.children) return;
    let seenComma = false;
    for (let i = 0; i < tokenTree.children.length; i++) {
      const child = tokenTree.children[i];
      if (!child) continue;
      if (!seenComma && child.type === ',') { seenComma = true; continue; }
      if (seenComma) {
        this.extractPatternReferences(child, callerId);
      }
    }
  }

  /**
   * Extract a `calls` edge from a macro_invocation node so that
   * `warn!()`, `error!()`, `info!()`, `println!()` etc. are searchable
   * via codegraph_callers / codegraph_usages / codegraph_callees.
   */
  private extractMacroCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Same pattern as extractMatchesMacroReferences: iterate named children.
    // getChildByField(node, 'name') returns null — tree-sitter-rust uses 'macro' field.
    // node.children[0] may be anonymous; scoped_identifier preserves full name (e.g. "std::println").
    // Strip scope prefix — macro identity is the bare name; scope is just a call-site qualifier.
    let macroName = '';
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'identifier' || child.type === 'macro_name'
          || child.type === 'scoped_identifier')) {
        const raw = getNodeText(child, this.source);
        macroName = child.type === 'scoped_identifier' ? raw.split('::').pop()! : raw;
        break;
      }
    }
    if (!macroName) return;

    this.unresolvedReferences.push({
      fromNodeId: callerId,
      referenceName: macroName,
      referenceKind: 'calls',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /**
   * Walk token_tree children of a macro_definition to extract pattern_match
   * references. Inside macro_rules! bodies, match arms like `Enum::Variant =>`
   * are parsed as flat token sequences (not structured match_arm nodes), so
   * standard match extraction misses them. We find scoped_identifier nodes
   * (Enum::Variant) and PascalCase identifier nodes that look like enum variant
   * references, and create pattern_match refs from the macro node.
   */
  private extractMacroTokenTreePatterns(node: SyntaxNode, macroNodeId: string): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (child.type === 'scoped_identifier') {
        const name = getNodeText(child, this.source);
        if (name && name.includes('::')) {
          this.unresolvedReferences.push({
            fromNodeId: macroNodeId,
            referenceName: name,
            referenceKind: 'pattern_match',
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
        }
        continue;
      }

      if (child.type === 'identifier') {
        const name = getNodeText(child, this.source);
        const firstChar = name ? name[0] : undefined;
        if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== '_' && !this.BUILTIN_TYPES.has(name!)) {
          this.unresolvedReferences.push({
            fromNodeId: macroNodeId,
            referenceName: name!,
            referenceKind: 'pattern_match',
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
        }
        continue;
      }

      // Recurse into nested token_trees (braced blocks, paren groups, etc.)
      if (child.type === 'token_tree' || child.type === 'token_tree_pattern' || child.type === 'token_repetition') {
        this.extractMacroTokenTreePatterns(child, macroNodeId);
      }
    }
  }

  /**
   * Walk the token_tree args of a macro_invocation (not `matches!`) to capture
   * PascalCase identifiers that are likely enum variants passed as arguments.
   * E.g. `生成_绑定访问方法!(导航上, 导航下)` → references from the enclosing
   * function to `导航上` and `导航下`.
   */
  private extractMacroInvocationArgs(node: SyntaxNode): void {
    // Check if this is NOT a `matches!` macro (which is already handled)
    let isMatches = false;
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child && (child.type === 'identifier' || child.type === 'macro_name')) {
        if (getNodeText(child, this.source) === 'matches') {
          isMatches = true;
          break;
        }
      }
    }
    if (isMatches) return;

    const fromNodeId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromNodeId || fromNodeId.startsWith('file:')) return;

    const tokenTree = node.namedChildren.find(c => c.type === 'token_tree');
    if (!tokenTree) return;

    this.extractTokenTreeIdentRefs(tokenTree, fromNodeId);
  }

  /**
   * Recurse into a token_tree and extract PascalCase identifier + scoped_identifier
   * references. Used for both macro definitions and macro invocations.
   */
  private extractTokenTreeIdentRefs(node: SyntaxNode, fromNodeId: string): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (child.type === 'scoped_identifier') {
        const name = getNodeText(child, this.source);
        if (name && name.includes('::')) {
          this.unresolvedReferences.push({
            fromNodeId,
            referenceName: name,
            referenceKind: 'references',
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
        }
        continue;
      }

      if (child.type === 'identifier') {
        const name = getNodeText(child, this.source);
        const firstChar = name ? name[0] : undefined;
        if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== '_' && !this.BUILTIN_TYPES.has(name!)) {
          this.unresolvedReferences.push({
            fromNodeId,
            referenceName: name!,
            referenceKind: 'references',
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
        }
        continue;
      }

      if (child.type === 'token_tree' || child.type === 'token_tree_pattern' || child.type === 'token_repetition') {
        this.extractTokenTreeIdentRefs(child, fromNodeId);
      }
    }
  }

  /**
   * Extract a reference from a scoped identifier used in expression/value position
   * (e.g. `Enum::Variant` as a function argument, method receiver, or range bound).
   * Pattern contexts (match arms, if-let, matches! macro) are guarded by
   * isExtractingPattern and handled separately as pattern_match edges.
   */
  private extractScopedValueReference(node: SyntaxNode): void {
    const name = getNodeText(node, this.source);
    if (!name || !name.includes('::')) return;

    const fromNodeId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromNodeId) return;

    // Skip module-level references — the stack top is the file node,
    // and a file--references-->symbol edge is semantically meaningless.
    if (fromNodeId.startsWith('file:')) return;


    this.unresolvedReferences.push({
      fromNodeId,
      referenceName: name,
      referenceKind: 'references',
      line: node.startPosition.row + 1,
      column: node.startPosition.column,
    });
  }

  /**
   * Recursively extract enum variant references from a pattern subtree.
   * Handles scoped_identifier (Enum::Variant), identifier (bare variant
   * after `use` import), and nested patterns (Some(Foo::Bar) tuples/structs).
   */
  private extractPatternReferences(node: SyntaxNode, fromNodeId: string, edgeKind: 'references' | 'pattern_match' = 'pattern_match'): void {
    if (node.type === 'scoped_identifier') {
      const name = getNodeText(node, this.source);
      if (name && name.includes('::')) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: name,
          referenceKind: edgeKind,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }
    if (node.type === 'identifier') {
      const name = getNodeText(node, this.source);
      // Only emit bare identifiers as pattern references when they start
      // with an uppercase letter (PascalCase). Lowercase identifiers in
      // match patterns are binding variables (e.g. `Some(v) =>`), not
      // enum variant references. This heuristic works across Rust, Swift,
      // and OCaml where enum variants are conventionally PascalCase.
      const firstChar = name ? name[0] : undefined;
      if (firstChar && firstChar === firstChar.toUpperCase() && firstChar !== '_' && !this.BUILTIN_TYPES.has(name!)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: name!,
          referenceKind: edgeKind,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return;
    }
    // Recurse into nested patterns (tuple_pattern, struct_pattern, or_pattern, etc.)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) this.extractPatternReferences(child, fromNodeId, edgeKind);
    }
  }

  /**
   * Extract a class property declaration (e.g. C# `public string Name { get; set; }`).
   * Extracts as 'property' kind node inside the owning class.
   */
  private extractProperty(node: SyntaxNode): void {
    if (!this.extractor) return;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    // Property name is a direct identifier child
    const nameNode = getChildByField(node, 'name')
      || node.namedChildren.find(c => c.type === 'identifier');
    if (!nameNode) return;

    const name = getNodeText(nameNode, this.source);

    // Get property type from the type child (first named child that isn't modifier or identifier)
    const typeNode = node.namedChildren.find(
      c => c.type !== 'modifier' && c.type !== 'modifiers'
        && c.type !== 'identifier' && c.type !== 'accessor_list'
        && c.type !== 'accessors' && c.type !== 'equals_value_clause'
    );
    const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;
    const signature = typeText ? `${typeText} ${name}` : name;

    const propNode = this.createNode('property', name, node, {
      docstring,
      signature,
      visibility,
      isStatic,
    });

    // `@Inject() private svc: Foo` and similar — capture the
    // decorator->target relationship for class properties too.
    if (propNode) {
      this.extractDecoratorsFor(node, propNode.id);
    }
  }

  /**
   * Extract a class field declaration (e.g. Java field_declaration, C# field_declaration).
   * Extracts each declarator as a 'field' kind node inside the owning class.
   */
  private extractField(node: SyntaxNode): void {
    if (!this.extractor) return;

    const docstring = getPrecedingDocstring(node, this.source);
    const visibility = this.extractor.getVisibility?.(node);
    const isStatic = this.extractor.isStatic?.(node) ?? false;

    // Java field_declaration: "private final String name = value;" → variable_declarator(s) are direct children
    // C# field_declaration: wraps in variable_declaration → variable_declarator(s)
    let declarators = node.namedChildren.filter(
      c => c.type === 'variable_declarator'
    );
    // C#: look inside variable_declaration wrapper
    if (declarators.length === 0) {
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      if (varDecl) {
        declarators = varDecl.namedChildren.filter(c => c.type === 'variable_declarator');
      }
    }

    // PHP property_declaration: property_element → variable_name → name
    if (declarators.length === 0) {
      const propElements = node.namedChildren.filter(c => c.type === 'property_element');
      if (propElements.length > 0) {
        // Get type annotation if present (e.g. "string", "int", "?Foo")
        const typeNode = node.namedChildren.find(
          c => c.type !== 'visibility_modifier' && c.type !== 'static_modifier'
            && c.type !== 'readonly_modifier' && c.type !== 'property_element'
            && c.type !== 'var_modifier'
        );
        const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

        for (const elem of propElements) {
          const varName = elem.namedChildren.find(c => c.type === 'variable_name');
          const nameNode = varName?.namedChildren.find(c => c.type === 'name');
          if (!nameNode) continue;
          const name = getNodeText(nameNode, this.source);
          const signature = typeText ? `${typeText} $${name}` : `$${name}`;
          const fieldNode = this.createNode('field', name, elem, {
            docstring,
            signature,
            visibility,
            isStatic,
          });
          if (fieldNode && typeNode) {
            this.extractTypeRefsFromSubtree(typeNode, fieldNode.id);
          }
        }
        return;
      }
    }

    if (declarators.length > 0) {
      // Get field type from the type child
      // Java: type is a direct child of field_declaration
      // C#: type is inside variable_declaration wrapper
      const varDecl = node.namedChildren.find(c => c.type === 'variable_declaration');
      const typeSearchNode = varDecl ?? node;
      const typeNode = typeSearchNode.namedChildren.find(
        c => c.type !== 'modifiers' && c.type !== 'modifier' && c.type !== 'variable_declarator'
          && c.type !== 'variable_declaration' && c.type !== 'marker_annotation' && c.type !== 'annotation'
      );
      const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;

      for (const decl of declarators) {
        const nameNode = getChildByField(decl, 'name')
          || decl.namedChildren.find(c => c.type === 'identifier');
        if (!nameNode) continue;
        const name = getNodeText(nameNode, this.source);
        const signature = typeText ? `${typeText} ${name}` : name;
        const fieldNode = this.createNode('field', name, decl, {
          docstring,
          signature,
          visibility,
          isStatic,
        });
        // Java/Kotlin annotations / TS field decorators sit on the
        // outer field_declaration, not on the individual declarator.
        if (fieldNode) {
          this.extractDecoratorsFor(node, fieldNode.id);
          if (typeNode) {
            this.extractTypeRefsFromSubtree(typeNode, fieldNode.id);
          }
        }
      }
    } else {
      // Fallback: try to find an identifier child directly.
      // Covers Rust field_declaration, C/C++ field_declaration, etc.
      const nameNode = getChildByField(node, 'name')
        || node.namedChildren.find(c => c.type === 'identifier');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        // Extract type annotation if present (e.g. Rust: `field: Type`)
        const typeNode = getChildByField(node, 'type');
        const typeText = typeNode ? getNodeText(typeNode, this.source) : undefined;
        const signature = typeText ? `${name}: ${typeText}` : name;
        const fieldNode = this.createNode('field', name, node, {
          docstring,
          signature,
          visibility,
          isStatic,
        });
        if (fieldNode && typeNode) {
          this.extractTypeRefsFromSubtree(typeNode, fieldNode.id);
        }
      }
    }
  }

  /**
   * Extract a variable declaration (const, let, var, etc.)
   *
   * Extracts top-level and module-level variable declarations.
   * Captures the variable name and first 100 chars of initializer in signature for searchability.
   */
  private extractVariable(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Different languages have different variable declaration structures
    // TypeScript/JavaScript: lexical_declaration contains variable_declarator children
    // Python: assignment has left (identifier) and right (value)
    // Go: var_declaration, short_var_declaration, const_declaration

    const isConst = this.extractor.isConst?.(node) ?? false;
    const kind: NodeKind = isConst ? 'constant' : 'variable';
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source) ?? false;

    // Extract variable declarators based on language
    if (this.language === 'typescript' || this.language === 'javascript' ||
        this.language === 'tsx' || this.language === 'jsx') {
      // Handle lexical_declaration and variable_declaration
      // These contain one or more variable_declarator children
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'variable_declarator') {
          const nameNode = getChildByField(child, 'name');
          const valueNode = getChildByField(child, 'value');

          if (nameNode) {
            // Skip destructured patterns (e.g., `let { x, y } = $props()` in Svelte)
            // These produce ugly multi-line names like "{ class: className }"
            if (nameNode.type === 'object_pattern' || nameNode.type === 'array_pattern') {
              continue;
            }
            const name = getNodeText(nameNode, this.source);
            // Arrow functions / function expressions: extract as function instead of variable
            if (valueNode && (valueNode.type === 'arrow_function' || valueNode.type === 'function_expression')) {
              this.extractFunction(valueNode);
              continue;
            }

            // Capture first 100 chars of initializer for context (stored in signature for searchability)
            const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            const varNode = this.createNode(kind, name, child, {
              docstring,
              signature: initSignature,
              isExported,
            });

            // Extract type annotation references (e.g., const x: ITextModel = ...)
            if (varNode) {
              this.extractVariableTypeAnnotation(child, varNode.id);
            }

            // Exported const object-of-functions: `export const actions =
            // { default: async () => {} }` (SvelteKit form actions / handler maps
            // / route tables). Extract each function-valued property as a function
            // named by its key + walk its body so its calls (e.g. api.post) are
            // captured. Scoped to EXPORTED consts to exclude the inline-object
            // noise (`ctx.set({...})`) the object-method skip deliberately avoids.
            if (isExported && valueNode &&
                (valueNode.type === 'object' || valueNode.type === 'object_expression')) {
              for (let j = 0; j < valueNode.namedChildCount; j++) {
                const pair = valueNode.namedChild(j);
                if (pair?.type !== 'pair') continue;
                const v = getChildByField(pair, 'value');
                const k = getChildByField(pair, 'key');
                if (k && v && (v.type === 'arrow_function' || v.type === 'function_expression')) {
                  this.extractFunction(v, getNodeText(k, this.source).replace(/^['"`]|['"`]$/g, ''));
                }
              }
            }
          }
        }
      }
    } else if (this.language === 'python' || this.language === 'ruby') {
      // Python/Ruby assignment: left = right
      const left = getChildByField(node, 'left') || node.namedChild(0);
      const right = getChildByField(node, 'right') || node.namedChild(1);

      if (left && left.type === 'identifier') {
        const name = getNodeText(left, this.source);
        // Skip if name starts with lowercase and looks like a function call result
        // Python constants are usually UPPER_CASE
        const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

        this.createNode(kind, name, node, {
          docstring,
          signature: initSignature,
        });
      }
    } else if (this.language === 'go') {
      // Go: var_declaration, short_var_declaration, const_declaration
      // These can have multiple identifiers on the left
      const specs = node.namedChildren.filter(c =>
        c.type === 'var_spec' || c.type === 'const_spec'
      );

      for (const spec of specs) {
        const nameNode = spec.namedChild(0);
        if (nameNode && nameNode.type === 'identifier') {
          const name = getNodeText(nameNode, this.source);
          const valueNode = spec.namedChildCount > 1 ? spec.namedChild(spec.namedChildCount - 1) : null;
          const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
          const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

          this.createNode(node.type === 'const_declaration' ? 'constant' : 'variable', name, spec, {
            docstring,
            signature: initSignature,
          });
        }
      }

      // Handle short_var_declaration (:=)
      if (node.type === 'short_var_declaration') {
        const left = getChildByField(node, 'left');
        const right = getChildByField(node, 'right');

        if (left) {
          // Can be expression_list with multiple identifiers
          const identifiers = left.type === 'expression_list'
            ? left.namedChildren.filter(c => c.type === 'identifier')
            : [left];

          for (const id of identifiers) {
            const name = getNodeText(id, this.source);
            const initValue = right ? getNodeText(right, this.source).slice(0, 100) : undefined;
            const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;

            this.createNode('variable', name, node, {
              docstring,
              signature: initSignature,
            });
          }
        }
      }
    } else if (this.language === 'lua' || this.language === 'luau') {
      // Lua/Luau: variable_declaration → assignment_statement → variable_list
      //      (name: identifier...) = expression_list. `local x, y = 1, 2`
      //      declares multiple names; only plain identifiers are locals.
      const assign = node.namedChildren.find((c) => c.type === 'assignment_statement') ?? node;
      const varList = assign.namedChildren.find((c) => c.type === 'variable_list');
      const exprList = assign.namedChildren.find((c) => c.type === 'expression_list');
      const values = exprList ? exprList.namedChildren : [];
      const names = varList ? varList.namedChildren.filter((c) => c.type === 'identifier') : [];
      names.forEach((nameNode, i) => {
        const name = getNodeText(nameNode, this.source);
        if (!name) return;
        const valueNode = values[i];
        const initValue = valueNode ? getNodeText(valueNode, this.source).slice(0, 100) : undefined;
        const initSignature = initValue ? `= ${initValue}${initValue.length >= 100 ? '...' : ''}` : undefined;
        this.createNode(kind, name, nameNode, { docstring, signature: initSignature, isExported });
      });
    } else if (this.language === 'rust' && node.type === 'let_declaration') {
      // Rust let bindings: extract type refs from the type annotation so
      // that generic parameters (e.g. `let x: Query<&MyType>`) create
      // references edges — impact analysis traces dependencies through locals.
      const patternNode = getChildByField(node, 'pattern');
      if (patternNode && patternNode.type === 'identifier') {
        const name = getNodeText(patternNode, this.source);
        const varNode = this.createNode(kind, name, patternNode, { docstring, isExported });
        if (varNode) {
          const typeNode = getChildByField(node, 'type');
          if (typeNode) {
            this.extractTypeRefsFromSubtree(typeNode, varNode.id);
          }
          const valueNode = getChildByField(node, 'value');
          if (valueNode) {
            this.visitNode(valueNode);
          }
        }
      } else {
        // Destructuring bindings (tuple_pattern, struct_pattern, etc.): no
        // variable node to create, but still extract type refs and manually
        // walk the value subtree so call expressions inside it are discovered.
        const fromNodeId = this.nodeStack[this.nodeStack.length - 1];
        if (fromNodeId && !fromNodeId.startsWith('file:')) {
          const typeNode = getChildByField(node, 'type');
          if (typeNode) {
            this.extractTypeRefsFromSubtree(typeNode, fromNodeId);
          }
          const valueNode = getChildByField(node, 'value');
          if (valueNode) {
            this.visitNode(valueNode);
          }
        }
      }
    } else if (this.language === 'rust' && (node.type === 'const_item' || node.type === 'static_item')) {
      // Rust const/static items: extract type refs from the type annotation
      // and enum variant references from the initializer value so that
      // impact analysis can trace dependencies through constants.
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const isConstItem = node.type === 'const_item';
        const itemKind: NodeKind = isConstItem ? 'constant' : 'variable';
        const varNode = this.createNode(itemKind, name, nameNode, { docstring, isExported });
        if (varNode) {
          // Extract type annotation references (e.g. `const X: SomeType = ...`)
          const typeNode = getChildByField(node, 'type');
          if (typeNode) {
            this.extractTypeRefsFromSubtree(typeNode, varNode.id);
          }
          // Extract references from initializer value (e.g. `= Enum::Variant`)
          const valueNode = getChildByField(node, 'value') ?? getChildByField(node, 'body');
          if (valueNode) {
            this.extractPatternReferences(valueNode, varNode.id, 'references');
          }
        }
      }
    } else {
      // Generic fallback for other languages
      // Try to find identifier children
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'identifier' || child?.type === 'variable_declarator') {
          const name = child.type === 'identifier'
            ? getNodeText(child, this.source)
            : extractName(child, this.source, this.extractor);

          if (name && name !== '<anonymous>') {
            this.createNode(kind, name, child, {
              docstring,
              isExported,
            });
          }
        }
      }
    }
  }

  /**
   * Extract a type alias (e.g. `export type X = ...` in TypeScript).
   * For languages like Go, resolveTypeAliasKind detects when the type_spec
   * wraps a struct or interface definition and creates the correct node kind.
   * Returns true if children should be skipped (struct/interface handled body visiting).
   */
  private extractTypeAlias(node: SyntaxNode): boolean {
    if (!this.extractor) return false;

    const name = extractName(node, this.source, this.extractor);
    if (name === '<anonymous>') return false;
    const docstring = getPrecedingDocstring(node, this.source);
    const isExported = this.extractor.isExported?.(node, this.source);

    // Check if this type alias is actually a struct or interface definition
    // (e.g. Go: `type Foo struct { ... }` is a type_spec wrapping struct_type)
    const resolvedKind = this.extractor.resolveTypeAliasKind?.(node, this.source);

    if (resolvedKind === 'struct') {
      const structNode = this.createNode('struct', name, node, { docstring, isExported });
      if (!structNode) return true;
      // Visit body children for field extraction
      this.nodeStack.push(structNode.id);
      // Try Go-style 'type' field first, then find inner struct child (C typedef struct)
      const typeChild = getChildByField(node, 'type')
        || this.findChildByTypes(node, this.extractor.structTypes);
      if (typeChild) {
        // Extract struct embedding (e.g. Go: `type DB struct { *Head; Queryable }`)
        this.extractInheritance(typeChild, structNode.id);
        const body = getChildByField(typeChild, this.extractor.bodyField) || typeChild;
        for (let i = 0; i < body.namedChildCount; i++) {
          const child = body.namedChild(i);
          if (child) this.visitNode(child);
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'enum') {
      const enumNode = this.createNode('enum', name, node, { docstring, isExported });
      if (!enumNode) return true;
      this.nodeStack.push(enumNode.id);
      // Find the inner enum type child (e.g. C: typedef enum { ... } name)
      const innerEnum = this.findChildByTypes(node, this.extractor.enumTypes);
      if (innerEnum) {
        this.extractInheritance(innerEnum, enumNode.id);
        const body = this.extractor.resolveBody?.(innerEnum, this.extractor.bodyField)
          ?? getChildByField(innerEnum, this.extractor.bodyField);
        if (body) {
          const memberTypes = this.extractor.enumMemberTypes;
          for (let i = 0; i < body.namedChildCount; i++) {
            const child = body.namedChild(i);
            if (!child) continue;
            if (memberTypes?.includes(child.type)) {
              this.extractEnumMembers(child);
            } else {
              this.visitNode(child);
            }
          }
        }
      }
      this.nodeStack.pop();
      return true;
    }

    if (resolvedKind === 'interface') {
      const kind: NodeKind = this.extractor.interfaceKind ?? 'interface';
      const interfaceNode = this.createNode(kind, name, node, { docstring, isExported });
      if (!interfaceNode) return true;
      // Extract interface inheritance from the inner type node
      const typeChild = getChildByField(node, 'type');
      if (typeChild) this.extractInheritance(typeChild, interfaceNode.id);
      return true;
    }

    const typeAliasNode = this.createNode('type_alias', name, node, {
      docstring,
      isExported,
    });

    // Extract type references from the alias value (e.g., `type X = ITextModel | null`)
    if (typeAliasNode && this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) {
      // The value is everything after the `=`, which is typically the last named child
      // In tree-sitter TS: type_alias_declaration has name + value children
      const value = getChildByField(node, 'value');
      if (value) {
        this.extractTypeRefsFromSubtree(value, typeAliasNode.id);
      }
    }
    return false;
  }

  // extractExportedVariables removed — the walker now descends into
  // export_statement children and the inner declaration's dedicated
  // extractor (extractVariable, extractFunction, extractClass, etc.)
  // handles the symbol with isExported=true via parent-walk in the
  // language extractor's isExported predicate.

  /**
   * Extract an import
   *
   * Creates an import node with the full import statement stored in signature for searchability.
   * Also creates unresolved references for resolution purposes.
   */
  private extractImport(node: SyntaxNode): void {
    if (!this.extractor) return;

    const importText = getNodeText(node, this.source).trim();

    // Try language-specific hook first
    if (this.extractor.extractImport) {
      const info = this.extractor.extractImport(node, this.source);
      if (info) {
        this.createNode('import', info.moduleName, node, {
          signature: info.signature,
        });
        // Create unresolved reference unless the hook handled it
        if (!info.handledRefs && info.moduleName && this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: info.moduleName,
              referenceKind: 'imports',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
        return;
      }
      // Hook returned null — fall through to multi-import inline handlers only
      // (hook returning null means "I didn't handle this" for multi-import cases,
      // NOT "use generic fallback" — the hook already declined)
    }

    // Multi-import cases that create multiple nodes (can't be expressed with single-return hook)

    // Python import_statement: import os, sys (creates one import per module)
    if (this.language === 'python' && node.type === 'import_statement') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'dotted_name') {
          this.createNode('import', getNodeText(child, this.source), node, {
            signature: importText,
          });
        } else if (child?.type === 'aliased_import') {
          const dottedName = child.namedChildren.find(c => c.type === 'dotted_name');
          if (dottedName) {
            this.createNode('import', getNodeText(dottedName, this.source), node, {
              signature: importText,
            });
          }
        }
      }
      return;
    }

    // Go imports: single or grouped (creates one import per spec)
    if (this.language === 'go') {
      const parentId = this.nodeStack.length > 0 ? this.nodeStack[this.nodeStack.length - 1] : null;
      const extractFromSpec = (spec: SyntaxNode): void => {
        const stringLiteral = spec.namedChildren.find(c => c.type === 'interpreted_string_literal');
        if (stringLiteral) {
          const importPath = getNodeText(stringLiteral, this.source).replace(/['"]/g, '');
          if (importPath) {
            this.createNode('import', importPath, spec, {
              signature: getNodeText(spec, this.source).trim(),
            });
            // Create unresolved reference so the resolver can create imports edges
            if (parentId) {
              this.unresolvedReferences.push({
                fromNodeId: parentId,
                referenceName: importPath,
                referenceKind: 'imports',
                line: spec.startPosition.row + 1,
                column: spec.startPosition.column,
              });
            }
          }
        }
      };

      const importSpecList = node.namedChildren.find(c => c.type === 'import_spec_list');
      if (importSpecList) {
        for (const spec of importSpecList.namedChildren.filter(c => c.type === 'import_spec')) {
          extractFromSpec(spec);
        }
      } else {
        const importSpec = node.namedChildren.find(c => c.type === 'import_spec');
        if (importSpec) {
          extractFromSpec(importSpec);
        }
      }
      return;
    }

    // PHP grouped imports: use X\{A, B} (creates one import per item)
    if (this.language === 'php') {
      const namespacePrefix = node.namedChildren.find(c => c.type === 'namespace_name');
      const useGroup = node.namedChildren.find(c => c.type === 'namespace_use_group');
      if (namespacePrefix && useGroup) {
        const prefix = getNodeText(namespacePrefix, this.source);
        const useClauses = useGroup.namedChildren.filter((c: SyntaxNode) =>
          c.type === 'namespace_use_group_clause' || c.type === 'namespace_use_clause'
        );
        for (const clause of useClauses) {
          const nsName = clause.namedChildren.find((c: SyntaxNode) => c.type === 'namespace_name');
          const name = nsName
            ? nsName.namedChildren.find((c: SyntaxNode) => c.type === 'name')
            : clause.namedChildren.find((c: SyntaxNode) => c.type === 'name');
          if (name) {
            const fullPath = `${prefix}\\${getNodeText(name, this.source)}`;
            this.createNode('import', fullPath, node, {
              signature: importText,
            });
          }
        }
        return;
      }
    }

    // If a hook exists but returned null, it intentionally declined this node — don't create fallback
    if (this.extractor.extractImport) return;

    // Generic fallback for languages without hooks
    this.createNode('import', importText, node, {
      signature: importText,
    });
  }

  /**
   * Extract a function call
   */
  private extractCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;

    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Get the function/method being called
    let calleeName = '';

    // Java/Kotlin method_invocation has 'object' + 'name' fields instead of 'function'
    // PHP member_call_expression has 'object' + 'name', scoped_call_expression has 'scope' + 'name'
    const nameField = getChildByField(node, 'name');
    const objectField = getChildByField(node, 'object') || getChildByField(node, 'scope');

    if (nameField && objectField && (node.type === 'method_invocation' || node.type === 'member_call_expression' || node.type === 'scoped_call_expression')) {
      // Method call with explicit receiver: receiver.method() / $receiver->method() / ClassName::method()
      const methodName = getNodeText(nameField, this.source);
      let receiverName = getNodeText(objectField, this.source);
      // Strip PHP $ prefix from variable names
      receiverName = receiverName.replace(/^\$/, '');

      if (methodName) {
        // Skip self/this/parent/static receivers — they don't aid resolution
        const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super', 'parent', 'static']);
        if (SKIP_RECEIVERS.has(receiverName)) {
          calleeName = methodName;
        } else {
          calleeName = `${receiverName}.${methodName}`;
        }
      }
    } else {
      const func = getChildByField(node, 'function') || node.namedChild(0);

      if (func) {
        if (func.type === 'member_expression' || func.type === 'attribute' || func.type === 'selector_expression' || func.type === 'navigation_expression') {
          // Method call: obj.method() or obj.field.method()
          // Go uses selector_expression with 'field', JS/TS uses member_expression with 'property'
          // Kotlin uses navigation_expression with navigation_suffix > simple_identifier
          let property = getChildByField(func, 'property') || getChildByField(func, 'field');
          if (!property) {
            const child1 = func.namedChild(1);
            // Kotlin: navigation_suffix wraps the method name — extract simple_identifier from it
            if (child1?.type === 'navigation_suffix') {
              property = child1.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier') ?? child1;
            } else {
              property = child1;
            }
          }
          if (property) {
            const methodName = getNodeText(property, this.source);
            // Include receiver name for qualified resolution (e.g., console.print → "console.print")
            // This helps the resolver distinguish method calls from bare function calls
            // (e.g., Python's console.print() vs builtin print())
            // Skip self/this/cls as they don't aid resolution
            const receiver = getChildByField(func, 'object') || getChildByField(func, 'operand') || func.namedChild(0);
            const SKIP_RECEIVERS = new Set(['self', 'this', 'cls', 'super']);
            if (receiver && (receiver.type === 'identifier' || receiver.type === 'simple_identifier')) {
              const receiverName = getNodeText(receiver, this.source);
              if (!SKIP_RECEIVERS.has(receiverName)) {
                calleeName = `${receiverName}.${methodName}`;
              } else {
                calleeName = methodName;
              }
            } else {
              calleeName = methodName;
            }
          }
        } else if (func.type === 'scoped_identifier' || func.type === 'scoped_call_expression') {
          // Scoped call: Module::function()
          calleeName = getNodeText(func, this.source);
        } else {
          calleeName = getNodeText(func, this.source);
        }
      }
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });

      // Track method/external calls in the caller node's signature so
      // queries like "insert_resource" or "add_message" are searchable
      // even when the target is an external API (Bevy, std, etc.).
      if ((calleeName.includes('.') || calleeName.includes('::')) && this._callEnrich === undefined) {
        this._callEnrich = new Map<string, Set<string>>();
      }
      if (this._callEnrich) {
        let called = this._callEnrich.get(callerId);
        if (!called) { called = new Set(); this._callEnrich.set(callerId, called); }
        if (called.size < 30) called.add(calleeName);
      }
    }

    // Bevy framework: extract system function references from API call args.
    // Patterns like app.add_systems(Update, fn), OnEnter(State::Variant), etc.
    if (this.language === 'rust') {
      this.extractBevyCallRefs(node, callerId, calleeName);
    }
    // Also scan for Bevy patterns inside any call expression arguments
    // (catches chained calls and nested API patterns).
    if (this.language === 'rust') {
      this.extractBevyNestedRefs(node, callerId);
    }
    // Bevy state constructors: DespawnOnExit(State::Variant),
    // NextState::Pending(State::Variant) — emit type_of to enum base name.
    if (this.language === 'rust') {
      this.extractBevyStateCtorRefs(node, callerId, calleeName);
    }
  }

  /**
   * Recursively scan call expression arguments for Bevy API patterns
   * (OnEnter, OnExit, add_systems, etc.) at any nesting level.
   * This catches patterns inside chained calls where the top-level
   * extractCall only sees the outermost method name.
   */
  private extractBevyNestedRefs(node: SyntaxNode, callerId: string): void {
    const args = getChildByField(node, 'arguments') ?? node.namedChildren.find(
      c => c.type === 'arguments'
    );
    if (!args) return;

    const scanForBevy = (child: SyntaxNode): void => {
      if (child.type === 'call_expression') {
        // Check if this is a Bevy API call: OnEnter(X), OnExit(X), etc.
        const func = getChildByField(child, 'function') ?? child.namedChild(0);
        if (func) {
          const name = getNodeText(func, this.source);
          if (this.BEVY_STATE_FUNCTIONS.has(name)) {
            this.extractBevyCallRefs(child, callerId, name);
          } else if (name.endsWith('.add_systems') || name.endsWith('.observe')
            || name.endsWith('.add_plugins') || name.includes('::init_resource')
            || name.includes('::add_event') || name.includes('::insert_resource')) {
            this.extractBevyCallRefs(child, callerId, name);
          }
        }
      }
      // Recurse into all children for nested patterns
      for (let i = 0; i < child.namedChildCount; i++) {
        const c = child.namedChild(i);
        if (c) scanForBevy(c);
      }
    };

    for (let i = 0; i < args.namedChildCount; i++) {
      const child = args.namedChild(i);
      if (child) scanForBevy(child);
    }
  }

  /**
   * Regex-based fallback scanner for Bevy add_systems patterns.
   * Handles chained calls where the AST walker may not correctly
   * identify the system function arguments.
   */
  private static readonly ADD_SYSTEMS_RE = /\.?(add_systems|add_plugins|observe)\s*\(/;
  private static readonly IDENT_EXCLUDE_RE = /^(?:Update|FixedUpdate|PreUpdate|PostUpdate|Last|Startup|First|OnEnter|OnExit|in_state|resource_exists|run_if|after|before|chain|pipe|and_then|or_else|map|filter|let|mut|use|fn|pub|impl|for|self|app|Res|ResMut|Commands|Query|EventWriter|EventReader|MessageWriter|MessageReader|Local|NextState|DespawnOnExit|with_child|spawn|insert|remove|entity|commands)$/;
  // Matches standalone identifiers optionally followed by .method, comma, or closing paren.
  // The qualified-name suffix uses the full CJK-aware character class so
  // Rust paths like 设置::导航上 are captured whole, not just the first segment.
  private static readonly SYSTEM_IDENT_RE = /(?:^|[,\s(]+)([\w一-鿿][\w一-鿿]*(?:::(?:[\w一-鿿]+))*)\s*(?=\.\w|[,\\)]|$)/g;

  private scanBevyPatternsFallback(): void {
    const existingKeys = new Set(
      this.unresolvedReferences.map(r =>
        `${r.fromNodeId}:${r.referenceName}:${r.referenceKind}:${r.line}`
      )
    );

    // Map line → callerId from extracted function/method nodes
    const lineToCaller = new Map<number, string>();
    for (const node of this.nodes) {
      if (node.kind === 'function' || node.kind === 'method') {
        for (let l = node.startLine; l <= node.endLine; l++) {
          lineToCaller.set(l, node.id);
        }
      }
    }
    // Fallback: also use current nodeStack for lines not covered
    const stackCallerId = this.nodeStack.length > 0
      ? this.nodeStack[this.nodeStack.length - 1]
      : '';

    const source = this.source;
    const lines = source.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const apiMatch = TreeSitterExtractor.ADD_SYSTEMS_RE.exec(line);
      if (!apiMatch) continue;

      // Determine edge kind from the API method name
      const apiMethod = apiMatch[1]!;
      const edgeKind: 'calls' | 'instantiates' =
        apiMethod === 'add_plugins' ? 'instantiates' : 'calls';

      // Scan through to the matching closing paren
      let parenDepth = 0;
      let seenScheduleComma = false;
      for (let j = i; j < lines.length; j++) {
        const sl = lines[j]!;

        // Track paren depth WITHIN this line for comma detection
        let lineParenDepth = 0;
        for (let k = 0; k < sl.length; k++) {
          if (sl[k] === '(') { parenDepth++; lineParenDepth++; }
          if (sl[k] === ')') { parenDepth--; lineParenDepth--; }
        }

        // Detect schedule comma: first comma at depth 1 (inside the call parens)
        // but NOT inside a nested sub-expression (depth > 1)
        if (!seenScheduleComma && parenDepth >= 1) {
          const commaPos = sl.indexOf(',');
          if (commaPos >= 0) {
            // Count open parens before the comma to verify it's at depth 1
            let preCommaParens = 0;
            for (let k = 0; k < commaPos; k++) {
              if (sl[k] === '(') preCommaParens++;
              if (sl[k] === ')') preCommaParens--;
            }
            // At line start, depth should be 1 (the opening paren of add_systems)
            // minus any closing parens before the comma
            if (preCommaParens <= 1) {
              seenScheduleComma = true;
            }
          }
        }

        if (seenScheduleComma && parenDepth >= 1) {
          // Reset regex lastIndex and find ALL identifiers on this line
          const identRe = TreeSitterExtractor.SYSTEM_IDENT_RE;
          identRe.lastIndex = 0;
          let identMatch;
          while ((identMatch = identRe.exec(sl)) !== null) {
            const name = identMatch[1]!;
            if (TreeSitterExtractor.IDENT_EXCLUDE_RE.test(name)) continue;

            const callerId = lineToCaller.get(j + 1) || stackCallerId;
            if (callerId) {
              const key = `${callerId}:${name}:${edgeKind}:${j + 1}`;
              if (!existingKeys.has(key)) {
                existingKeys.add(key);
                this.unresolvedReferences.push({
                  fromNodeId: callerId,
                  referenceName: name,
                  referenceKind: edgeKind,
                  line: j + 1,
                  column: identMatch.index + 1,
                });
              }
            }
          }
        }

        if (parenDepth <= 0) break;
      }
    }
  }

  /**
   * Scan the arguments of a call expression for Bevy framework patterns.
   * Extracts additional call/instantiates/references edges for:
   * - app.add_systems(schedule, fn) / app.add_systems(schedule, (fn1, fn2))
   * - app.add_plugins(PluginType)
   * - app.init_resource::<T>() / app.add_event::<T>() / app.insert_resource(T)
   * - OnEnter(State) / OnExit(State)
   * - app.observe(fn)
   */
  private readonly BEVY_SYSTEM_METHODS = new Set([
    'add_systems', 'observe',
  ]);
  private readonly BEVY_INSTANTIATE_METHODS = new Set([
    'add_plugins', 'init_resource', 'add_event', 'insert_resource',
  ]);
  private readonly BEVY_STATE_FUNCTIONS = new Set([
    'OnEnter', 'OnExit', 'in_state',
  ]);
  private readonly BEVY_STATE_CONSTRUCTORS = new Set([
    'DespawnOnExit', 'Pending',
  ]);

  private extractBevyCallRefs(node: SyntaxNode, callerId: string, calleeName: string): void {
    // Extract just the method/function name from the callee, stripping
    // turbofish type params (e.g., "app.init_resource::<T>" → "init_resource")
    const lastDot = calleeName.lastIndexOf('.');
    let methodName = lastDot >= 0 ? calleeName.slice(lastDot + 1) : calleeName;
    const turbofish = methodName.indexOf('::<');
    if (turbofish >= 0) methodName = methodName.slice(0, turbofish);

    const isSystemCall = this.BEVY_SYSTEM_METHODS.has(methodName);
    const isInstantiateCall = this.BEVY_INSTANTIATE_METHODS.has(methodName);
    const isStateCall = this.BEVY_STATE_FUNCTIONS.has(calleeName);

    if (!isSystemCall && !isInstantiateCall && !isStateCall) return;

    const edgeKind = isInstantiateCall ? 'instantiates'
      : isStateCall ? 'references'
      : 'calls';

    // Find the arguments node
    const args = getChildByField(node, 'arguments') ?? node.namedChildren.find(
      c => c.type === 'arguments'
    );
    if (!args) return;

    // Collect function identifiers from arguments. Only add_systems has a
    // schedule as its first argument — skip it to get the system functions.
    // observe(), init_resource, add_event, and add_plugins all have the
    // relevant symbol as their first (and often only) argument.
    const startIdx = (methodName === 'add_systems') ? 1 : 0;

    const collectFuncRefs = (child: SyntaxNode, skip: number): void => {
      if (skip > 0) { skip--; return; }
      if (child.type === 'tuple_expression' || child.type === 'token_tree') {
        // Tuple: (fn1, fn2, ...) — extract each
        for (let i = 0; i < child.namedChildCount; i++) {
          const item = child.namedChild(i);
          if (item) collectFuncRefs(item, 0);
        }
        return;
      }
      if (child.type === 'identifier' || child.type === 'scoped_identifier') {
        const name = getNodeText(child, this.source);
        if (name) {
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: name,
            referenceKind: edgeKind,
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
          // For state calls, emit type_of to the enum base name
          // e.g. OnEnter(MenuState::Open) → type_of → MenuState
          if (isStateCall && name.includes('::')) {
            const baseName = name.split('::')[0]!;
            this.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: baseName,
              referenceKind: 'type_of',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
        }
        return;
      }
      // Unwrap chained method calls: `fn_name.run_if(...).after(...)` →
      // the root identifier is `fn_name` (a system function reference).
      if (child.type === 'field_expression') {
        const value = getChildByField(child, 'value') ?? child.namedChild(0);
        if (value) collectFuncRefs(value, 0);
        return;
      }
    };

    for (let i = 0; i < args.namedChildCount; i++) {
      const child = args.namedChild(i);
      if (child) collectFuncRefs(child, startIdx > i ? 1 : 0);
    }
  }

  /**
   * Bevy state constructors: DespawnOnExit(State::Variant),
   * NextState::Pending(State::Variant) — emit type_of edge to the
   * enum base name from scoped_identifier arguments.
   */
  private extractBevyStateCtorRefs(node: SyntaxNode, callerId: string, calleeName: string): void {
    // Extract the leaf name — "NextState::Pending" → "Pending",
    // "NextState.pending" → "pending", "DespawnOnExit" → "DespawnOnExit"
    const leafName = calleeName.includes('::')
      ? calleeName.split('::').pop()!
      : calleeName.includes('.')
        ? calleeName.split('.').pop()!
        : calleeName;

    if (!this.BEVY_STATE_CONSTRUCTORS.has(leafName)) return;

    const args = getChildByField(node, 'arguments') ?? node.namedChildren.find(
      c => c.type === 'arguments'
    );
    if (!args) return;

    const collectScopedBase = (child: SyntaxNode): void => {
      if (child.type === 'scoped_identifier') {
        const name = getNodeText(child, this.source);
        if (name && name.includes('::')) {
          const baseName = name.split('::')[0]!;
          this.unresolvedReferences.push({
            fromNodeId: callerId,
            referenceName: baseName,
            referenceKind: 'type_of',
            line: child.startPosition.row + 1,
            column: child.startPosition.column,
          });
        }
        return;
      }
      // Recurse into tuples, token_trees, etc.
      if (child.type === 'tuple_expression' || child.type === 'token_tree') {
        for (let i = 0; i < child.namedChildCount; i++) {
          const item = child.namedChild(i);
          if (item) collectScopedBase(item);
        }
      }
    };

    for (let i = 0; i < args.namedChildCount; i++) {
      const child = args.namedChild(i);
      if (child) collectScopedBase(child);
    }
  }

  /**
   * `new Foo(...)` / `Foo::new(...)` / object_creation_expression —
   * emit an `instantiates` reference to the class name. The resolver
   * then links it to the class node, producing the `instantiates`
   * edge that powers "what creates instances of X" queries.
   *
   * Children are still walked so nested calls inside the constructor
   * arguments (`new Foo(bar())`) get their own `calls` references.
   */
  private extractInstantiation(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const fromId = this.nodeStack[this.nodeStack.length - 1];
    if (!fromId) return;

    // The class name is in the `constructor`/`type`/first-named-child
    // depending on grammar.
    const ctor =
      getChildByField(node, 'constructor') ||
      getChildByField(node, 'type') ||
      getChildByField(node, 'name') ||
      node.namedChild(0);
    if (!ctor) return;

    let className = getNodeText(ctor, this.source);
    // Strip type-argument suffix first: `new Map<K, V>()` would
    // otherwise produce className 'Map<K, V>' (the constructor
    // field is a `generic_type` node) and resolution would fail
    // because no class is named with the angle-bracket suffix.
    const ltIdx = className.indexOf('<');
    if (ltIdx > 0) className = className.slice(0, ltIdx);
    // For namespaced/qualified constructors (`new ns.Foo()`,
    // `new ns::Foo()`) keep the trailing identifier — that's what
    // matches a class node in the index.
    const lastDot = Math.max(
      className.lastIndexOf('.'),
      className.lastIndexOf('::')
    );
    if (lastDot >= 0) className = className.slice(lastDot + 1).replace(/^[:.]/, '');
    className = className.trim();

    if (className) {
      this.unresolvedReferences.push({
        fromNodeId: fromId,
        referenceName: className,
        referenceKind: 'instantiates',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }
  }

  /**
   * Scan `declNode` and its preceding siblings (within the parent's
   * named children) for decorator nodes, emitting a `decorates`
   * reference from `decoratedId` to each decorator's function name.
   *
   * Why preceding siblings: in TypeScript, `@Foo class Bar {}` parses
   * as an `export_statement` (or top-level wrapper) with the
   * `decorator` as a child *before* the `class_declaration` — so the
   * decorator isn't a child of the class itself. For methods/
   * properties, the decorator IS a direct child of the declaration,
   * so we also scan declNode.namedChildren.
   *
   * Idempotent across grammars: if neither location yields decorators
   * (most non-decorator-using languages), the function is a no-op.
   */
  private extractDecoratorsFor(declNode: SyntaxNode, decoratedId: string): void {
    const consider = (n: SyntaxNode | null): void => {
      if (!n) return;
      // `marker_annotation` is Java's grammar for arg-less annotations
      // (`@Override`, `@Deprecated`); without including it, every
      // such Java annotation would be silently skipped.
      if (
        n.type !== 'decorator' &&
        n.type !== 'annotation' &&
        n.type !== 'marker_annotation'
      ) {
        return;
      }
      // Find the leading identifier: skip the `@` punct, unwrap
      // a call_expression if the decorator is invoked with args.
      let target: SyntaxNode | null = null;
      for (let i = 0; i < n.namedChildCount; i++) {
        const child = n.namedChild(i);
        if (!child) continue;
        if (child.type === 'call_expression') {
          const fn = getChildByField(child, 'function') ?? child.namedChild(0);
          if (fn) target = fn;
          if (target) break;
        }
        if (
          child.type === 'identifier' ||
          child.type === 'member_expression' ||
          child.type === 'scoped_identifier' ||
          child.type === 'navigation_expression'
        ) {
          target = child;
          break;
        }
      }
      if (!target) return;
      let name = getNodeText(target, this.source);
      const lastDot = Math.max(name.lastIndexOf('.'), name.lastIndexOf('::'));
      if (lastDot >= 0) name = name.slice(lastDot + 1).replace(/^[:.]/, '');
      if (!name) return;
      this.unresolvedReferences.push({
        fromNodeId: decoratedId,
        referenceName: name,
        referenceKind: 'decorates',
        line: n.startPosition.row + 1,
        column: n.startPosition.column,
      });
    };

    // 1. Decorators that are direct children of the declaration
    //    (method/property style, also some grammars for class).
    for (let i = 0; i < declNode.namedChildCount; i++) {
      consider(declNode.namedChild(i));
    }

    // 2. Decorators that are PRECEDING siblings of the declaration
    //    inside the parent's children (TypeScript class style).
    //    Walk BACKWARDS from the declaration and stop at the first
    //    non-decorator sibling — without that stop, decorators
    //    belonging to an EARLIER unrelated declaration leak in
    //    (e.g. `@A class Foo {} @B class Bar {}` would otherwise
    //    attribute @A to Bar).
    //
    //    Note on identity: tree-sitter web bindings return fresh JS
    //    wrapper objects from `parent`/`namedChild` navigation, so
    //    `sibling === declNode` is unreliable — `startIndex` does
    //    the matching instead.
    const parent = declNode.parent;
    if (parent) {
      const declStart = declNode.startIndex;
      let declIdx = -1;
      for (let i = 0; i < parent.namedChildCount; i++) {
        const sibling = parent.namedChild(i);
        if (sibling && sibling.startIndex === declStart) {
          declIdx = i;
          break;
        }
      }
      if (declIdx > 0) {
        for (let j = declIdx - 1; j >= 0; j--) {
          const sibling = parent.namedChild(j);
          if (!sibling) continue;
          if (sibling.type !== 'decorator' && sibling.type !== 'annotation' && sibling.type !== 'marker_annotation') {
            break; // non-decorator separator → stop consuming
          }
          consider(sibling);
        }
      }
    }
  }

  /**
   * Visit function body and extract calls (and structural nodes).
   *
   * In addition to call expressions, this also detects class/struct/enum
   * definitions inside function bodies. This handles two cases:
   *   1. Local class/struct/enum definitions (valid in C++, Java, etc.)
   *   2. C++ macro misparsing — macros like NLOHMANN_JSON_NAMESPACE_BEGIN cause
   *      tree-sitter to interpret the namespace block as a function_definition,
   *      hiding real class/struct/enum nodes inside the "function body".
   */
  private visitFunctionBody(body: SyntaxNode, _functionId: string): void {
    if (!this.extractor) return;

    const visitForCallsAndStructure = (node: SyntaxNode): void => {
      const nodeType = node.type;

      if (this.extractor!.callTypes.includes(nodeType)) {
        this.extractCall(node);
      } else if (INSTANTIATION_KINDS.has(nodeType)) {
        // `new Foo()` inside a function body — emit an `instantiates`
        // reference. Without this branch the body walker only knew
        // about `call_expression`, so constructor invocations
        // produced no graph edges at all.
        this.extractInstantiation(node);
      } else if (this.extractor!.extractBareCall) {
        const calleeName = this.extractor!.extractBareCall(node, this.source);
        if (calleeName && this.nodeStack.length > 0) {
          const callerId = this.nodeStack[this.nodeStack.length - 1];
          if (callerId) {
            this.unresolvedReferences.push({
              fromNodeId: callerId,
              referenceName: calleeName,
              referenceKind: 'calls',
              line: node.startPosition.row + 1,
              column: node.startPosition.column,
            });
          }
        }
      }

      // Nested NAMED functions inside a body — function declarations and named
      // function expressions like `.on('mount', function onmount(){})` — become
      // their own nodes so the graph can link to them (callback handlers, local
      // helpers). Anonymous arrows/expressions fall through to the default
      // recursion below, keeping their inner calls attributed to the enclosing
      // function: this bounds the new nodes to NAMED functions only (no explosion,
      // no lost edges). extractFunction walks the nested body itself, so we return.
      if (this.extractor!.functionTypes.includes(nodeType)) {
        const nestedName = extractName(node, this.source, this.extractor!);
        if (nestedName && nestedName !== '<anonymous>') {
          this.extractFunction(node);
          return;
        }
      }

      // Extract structural nodes found inside function bodies.
      // Each extract method visits its own children, so we return after extracting.
      if (this.extractor!.classTypes.includes(nodeType)) {
        const classification = this.extractor!.classifyClassNode?.(node) ?? 'class';
        if (classification === 'struct') this.extractStruct(node);
        else if (classification === 'enum') this.extractEnum(node);
        else if (classification === 'interface') this.extractInterface(node);
        else if (classification === 'trait') this.extractClass(node, 'trait');
        else this.extractClass(node);
        return;
      }
      if (this.extractor!.structTypes.includes(nodeType)) {
        this.extractStruct(node);
        return;
      }
      if (this.extractor!.enumTypes.includes(nodeType)) {
        this.extractEnum(node);
        return;
      }
      if (this.extractor!.interfaceTypes.includes(nodeType)) {
        this.extractInterface(node);
        return;
      }

      // Pattern / scoped-identifier extraction — mirror visitNode dispatch
      // so enum variant references inside function bodies are tracked.
      // Flag is saved/restored to prevent the child recursion from creating
      // duplicate edges for scoped_identifiers already handled as patterns.
      if (nodeType === 'match_expression') {
        const saved = this.isExtractingPattern;
        this.isExtractingPattern = true;
        this.extractMatchReferences(node);
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) visitForCallsAndStructure(child);
        }
        this.isExtractingPattern = saved;
        return;
      }
      if (nodeType === 'if_let_expression') {
        const saved = this.isExtractingPattern;
        this.isExtractingPattern = true;
        this.extractIfLetReferences(node);
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) visitForCallsAndStructure(child);
        }
        this.isExtractingPattern = saved;
        return;
      }
      if (nodeType === 'macro_invocation') {
        const saved = this.isExtractingPattern;
        this.isExtractingPattern = true;
        this.extractMacroCall(node);
        this.extractMatchesMacroReferences(node);
        this.extractMacroInvocationArgs(node);
        for (let i = 0; i < node.namedChildCount; i++) {
          const child = node.namedChild(i);
          if (child) visitForCallsAndStructure(child);
        }
        this.isExtractingPattern = saved;
        return;
      }
      if (nodeType === 'scoped_identifier' && !this.isExtractingPattern && this.nodeStack.length > 0) {
        this.extractScopedValueReference(node);
      }
      // Mirror visitNode dispatch for generic_type / scoped_type_identifier /
      // type_arguments so turbofish generics inside function bodies (tuple
      // expressions, call arguments) produce type_of edges.
      else if ((nodeType === 'generic_type' || nodeType === 'scoped_type_identifier') && this.nodeStack.length > 0) {
        if (node.parent?.type !== 'impl_item') {
          const fromNodeId = this.nodeStack[this.nodeStack.length - 1];
          if (fromNodeId && !fromNodeId.startsWith('file:')) {
            this.extractTypeRefsFromSubtree(node, fromNodeId);
          }
        }
        return; // extractTypeRefsFromSubtree already walked children
      }
      else if (nodeType === 'type_arguments' && this.language === 'rust' && this.nodeStack.length > 0) {
        const parent = node.parent;
        if (parent && (parent.type === 'generic_type' || parent.type === 'scoped_type_identifier')) {
          // Already handled by parent
        } else {
          const fromNodeId = this.nodeStack[this.nodeStack.length - 1];
          if (fromNodeId && !fromNodeId.startsWith('file:')) {
            this.extractTypeRefsFromSubtree(node, fromNodeId, true);
          }
          return; // extractTypeRefsFromSubtree already walked children
        }
      }

      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) {
          visitForCallsAndStructure(child);
        }
      }
    };

    visitForCallsAndStructure(body);
  }

  /**
   * Extract inheritance relationships
   */
  private extractInheritance(node: SyntaxNode, classId: string): void {
    // Look for extends/implements clauses
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;

      if (
        child.type === 'extends_clause' ||
        child.type === 'superclass' ||
        child.type === 'base_clause' || // PHP class extends
        child.type === 'extends_interfaces' // Java interface extends
      ) {
        // Extract parent class/interface names
        // Java uses type_list wrapper: superclass -> type_identifier, extends_interfaces -> type_list -> type_identifier
        const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
        const targets = typeList ? typeList.namedChildren : [child.namedChild(0)];
        for (const target of targets) {
          if (target) {
            const name = getNodeText(target, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: target.startPosition.row + 1,
              column: target.startPosition.column,
            });
          }
        }
      }

      // C++ base classes: `class Derived : public Base, private Other` →
      // base_class_clause holds access specifiers + base type(s). Emit an extends
      // ref per base type (skip the public/private/protected keywords).
      if (child.type === 'base_class_clause') {
        for (const t of child.namedChildren) {
          if (
            t.type === 'type_identifier' ||
            t.type === 'qualified_identifier' ||
            t.type === 'template_type'
          ) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: getNodeText(t, this.source),
              referenceKind: 'extends',
              line: t.startPosition.row + 1,
              column: t.startPosition.column,
            });
          }
        }
      }

      if (
        child.type === 'implements_clause' ||
        child.type === 'class_interface_clause' ||
        child.type === 'super_interfaces' || // Java class implements
        child.type === 'interfaces' // Dart
      ) {
        // Extract implemented interfaces
        // Java uses type_list wrapper: super_interfaces -> type_list -> type_identifier
        const typeList = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_list');
        const targets = typeList ? typeList.namedChildren : child.namedChildren;
        for (const iface of targets) {
          if (iface) {
            const name = getNodeText(iface, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'implements',
              line: iface.startPosition.row + 1,
              column: iface.startPosition.column,
            });
          }
        }
      }

      // Python superclass list: `class Flask(Scaffold, Mixin):`
      // argument_list contains identifier children for each parent class
      if (child.type === 'argument_list' && node.type === 'class_definition') {
        for (const arg of child.namedChildren) {
          if (arg.type === 'identifier' || arg.type === 'attribute') {
            const name = getNodeText(arg, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: arg.startPosition.row + 1,
              column: arg.startPosition.column,
            });
          }
        }
      }

      // Go interface embedding: `type Querier interface { LabelQuerier; ... }`
      // constraint_elem wraps the embedded interface type identifier
      if (child.type === 'constraint_elem') {
        const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // Go struct embedding: field_declaration without field_identifier
      // e.g. `type DB struct { *Head; Queryable }` — no field name means embedded type
      if (child.type === 'field_declaration') {
        const hasFieldIdentifier = child.namedChildren.some((c: SyntaxNode) => c.type === 'field_identifier');
        if (!hasFieldIdentifier) {
          const typeId = child.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
          if (typeId) {
            const name = getNodeText(typeId, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: typeId.startPosition.row + 1,
              column: typeId.startPosition.column,
            });
          }
        }
      }

      // Rust trait supertraits: `trait SubTrait: SuperTrait + Display { ... }`
      // trait_bounds contains type_identifier, generic_type, or higher_ranked_trait_bound children
      if (child.type === 'trait_bounds') {
        for (const bound of child.namedChildren) {
          let typeName: string | undefined;
          let posNode: SyntaxNode | undefined;

          if (bound.type === 'type_identifier') {
            typeName = getNodeText(bound, this.source);
            posNode = bound;
          } else if (bound.type === 'generic_type') {
            // e.g. `Deserialize<'de>`
            const inner = bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
            if (inner) { typeName = getNodeText(inner, this.source); posNode = inner; }
          } else if (bound.type === 'higher_ranked_trait_bound') {
            // e.g. `for<'de> Deserialize<'de>`
            const generic = bound.namedChildren.find((c: SyntaxNode) => c.type === 'generic_type');
            const typeId = generic?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
              ?? bound.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
            if (typeId) { typeName = getNodeText(typeId, this.source); posNode = typeId; }
          }

          if (typeName && posNode) {
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: typeName,
              referenceKind: 'extends',
              line: posNode.startPosition.row + 1,
              column: posNode.startPosition.column,
            });
          }
        }
      }

      // C#: `class Movie : BaseItem, IPlugin` → base_list with identifier children
      // base_list combines both base class and interfaces in a single colon-separated list.
      // We emit all as 'extends' since the syntax doesn't distinguish them.
      if (child.type === 'base_list') {
        for (const baseType of child.namedChildren) {
          if (baseType) {
            // For generic base types like `ClientBase<T>`, extract just the type name
            const name = baseType.type === 'generic_name'
              ? getNodeText(baseType.namedChildren.find((c: SyntaxNode) => c.type === 'identifier') ?? baseType, this.source)
              : getNodeText(baseType, this.source);
            this.unresolvedReferences.push({
              fromNodeId: classId,
              referenceName: name,
              referenceKind: 'extends',
              line: baseType.startPosition.row + 1,
              column: baseType.startPosition.column,
            });
          }
        }
      }

      // Kotlin: `class Foo : Bar, Baz` → delegation_specifier > user_type > type_identifier
      // Also handles `class Foo : Bar()` → delegation_specifier > constructor_invocation > user_type
      if (child.type === 'delegation_specifier') {
        const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
        const constructorInvocation = child.namedChildren.find((c: SyntaxNode) => c.type === 'constructor_invocation');
        const target = userType ?? constructorInvocation;
        if (target) {
          const typeId = target.type === 'user_type'
            ? target.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier') ?? target
            : target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type')?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier')
              ?? target.namedChildren.find((c: SyntaxNode) => c.type === 'user_type') ?? target;
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // Swift: inheritance_specifier > user_type > type_identifier
      // Used for class inheritance, protocol conformance, and protocol inheritance
      if (child.type === 'inheritance_specifier') {
        const userType = child.namedChildren.find((c: SyntaxNode) => c.type === 'user_type');
        const typeId = userType?.namedChildren.find((c: SyntaxNode) => c.type === 'type_identifier');
        if (typeId) {
          const name = getNodeText(typeId, this.source);
          this.unresolvedReferences.push({
            fromNodeId: classId,
            referenceName: name,
            referenceKind: 'extends',
            line: typeId.startPosition.row + 1,
            column: typeId.startPosition.column,
          });
        }
      }

      // JavaScript class_heritage has bare identifier without extends_clause wrapper
      // e.g. `class Foo extends Bar {}` → class_heritage → identifier("Bar")
      if (
        (child.type === 'identifier' || child.type === 'type_identifier') &&
        node.type === 'class_heritage'
      ) {
        const name = getNodeText(child, this.source);
        this.unresolvedReferences.push({
          fromNodeId: classId,
          referenceName: name,
          referenceKind: 'extends',
          line: child.startPosition.row + 1,
          column: child.startPosition.column,
        });
      }

      // Recurse into container nodes (e.g. field_declaration_list in Go structs,
      // class_heritage in TypeScript which wraps extends_clause/implements_clause)
      if (child.type === 'field_declaration_list' || child.type === 'class_heritage') {
        this.extractInheritance(child, classId);
      }
    }
  }

  /**
   * Rust `impl Trait for Type` — creates an implements edge from Type to Trait.
   * For plain `impl Type { ... }` (no trait), no inheritance edge is needed.
   */
  private extractRustImplItem(node: SyntaxNode): void {
    // Check if this is `impl Trait for Type` by looking for a `for` keyword
    const hasFor = node.children.some(
      (c: SyntaxNode) => c.type === 'for' && !c.isNamed
    );
    if (!hasFor) return;

    // In `impl Trait for Type`, the type_identifiers are:
    // first = Trait name, last = implementing Type name
    // Also handle generic types like `impl<T> Trait for MyStruct<T>`
    const typeIdents = node.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'generic_type' || c.type === 'scoped_type_identifier'
    );
    if (typeIdents.length < 2) return;

    const traitNode = typeIdents[0]!;
    const typeNode = typeIdents[typeIdents.length - 1]!;

    // Get the trait name (handle scoped paths like std::fmt::Display)
    const traitName = traitNode.type === 'scoped_type_identifier'
      ? this.source.substring(traitNode.startIndex, traitNode.endIndex)
      : getNodeText(traitNode, this.source);

    // Get the implementing type name (extract inner type_identifier for generics)
    let typeName: string;
    if (typeNode.type === 'generic_type') {
      const inner = typeNode.namedChildren.find(
        (c: SyntaxNode) => c.type === 'type_identifier'
      );
      typeName = inner ? getNodeText(inner, this.source) : getNodeText(typeNode, this.source);
    } else {
      typeName = getNodeText(typeNode, this.source);
    }

    // Find the struct/type node for the implementing type
    const typeNodeId = this.findNodeByName(typeName);
    if (typeNodeId) {
      this.unresolvedReferences.push({
        fromNodeId: typeNodeId,
        referenceName: traitName,
        referenceKind: 'implements',
        line: traitNode.startPosition.row + 1,
        column: traitNode.startPosition.column,
      });
      // Emit references for type arguments in the implementing type
      // (e.g., impl<T> Trait for MyStruct<T> — reference the type params).
      if (typeNode.type === 'generic_type') {
        const typeArgs = typeNode.namedChildren.find(
          (c: SyntaxNode) => c.type === 'type_arguments'
        );
        if (typeArgs) {
          this.extractTypeRefsFromSubtree(typeArgs, typeNodeId, true);
        }
      }

      // Enrich the type node's signature so the trait name is FTS-searchable.
      // Makes "codegraph_search Plugin" find `impl Plugin for MyPlugin`.
      const targetNode = this.nodes.find(n => n.id === typeNodeId);
      if (targetNode) {
        const existing = targetNode.signature ?? '';
        const implEntry = `implements ${traitName}`;
        targetNode.signature = existing ? `${existing}; ${implEntry}` : implEntry;
      }
    }
  }

  /**
   * Find a previously-extracted node by name (used for back-references like impl blocks)
   */
  private findNodeByName(name: string): string | undefined {
    for (const node of this.nodes) {
      if (node.name === name && (node.kind === 'struct' || node.kind === 'enum' || node.kind === 'class')) {
        return node.id;
      }
    }
    return undefined;
  }

  /**
   * Languages that support type annotations (TypeScript, etc.)
   */
  private readonly TYPE_ANNOTATION_LANGUAGES = new Set([
    'typescript', 'tsx', 'dart', 'kotlin', 'swift', 'rust', 'go', 'java', 'csharp',
  ]);

  /**
   * Built-in/primitive type names that shouldn't create references
   */
  private readonly BUILTIN_TYPES = new Set([
    'string', 'number', 'boolean', 'void', 'null', 'undefined', 'never', 'any', 'unknown',
    'object', 'symbol', 'bigint', 'true', 'false',
    // Rust
    'str', 'bool', 'i8', 'i16', 'i32', 'i64', 'i128', 'isize',
    'u8', 'u16', 'u32', 'u64', 'u128', 'usize', 'f32', 'f64', 'char',
    // Java/C#
    'int', 'long', 'short', 'byte', 'float', 'double', 'char',
    // Go
    'int8', 'int16', 'int32', 'int64', 'uint8', 'uint16', 'uint32', 'uint64',
    'float32', 'float64', 'complex64', 'complex128', 'rune', 'error',
  ]);

  /**
   * Extract type references from type annotations on a function/method/field node.
   * Creates 'references' edges for parameter types, return types, and field types.
   */
  private extractTypeAnnotations(node: SyntaxNode, nodeId: string): void {
    if (!this.extractor) return;
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // Extract parameter type annotations
    const params = getChildByField(node, this.extractor.paramsField || 'parameters');
    if (params) {
      this.extractTypeRefsFromSubtree(params, nodeId);
    }

    // Extract return type annotation
    const returnType = getChildByField(node, this.extractor.returnField || 'return_type');
    if (returnType) {
      this.extractTypeRefsFromSubtree(returnType, nodeId);
    }

    // Extract direct type annotation (for class fields like `model: ITextModel`)
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * Extract type references from a variable's type annotation.
   */
  private extractVariableTypeAnnotation(node: SyntaxNode, nodeId: string): void {
    if (!this.TYPE_ANNOTATION_LANGUAGES.has(this.language)) return;

    // Find type_annotation child (covers TS `: Type`, Rust `: Type`, etc.)
    const typeAnnotation = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type_annotation'
    );
    if (typeAnnotation) {
      this.extractTypeRefsFromSubtree(typeAnnotation, nodeId);
    }
  }

  /**
   * Recursively walk a subtree and extract all type_identifier references.
   * Handles unions, intersections, generics, arrays, etc.
   *
   * When insideTypeArgs is true (descending into a type_arguments node),
   * references use 'type_of' edges so resolution can prefer type symbols
   * (struct, enum, class) over value symbols (enum_member, constant).
   */
  private extractTypeRefsFromSubtree(node: SyntaxNode, fromNodeId: string, insideTypeArgs = false): void {
    if (node.type === 'type_identifier') {
      const typeName = getNodeText(node, this.source);
      if (typeName && !this.BUILTIN_TYPES.has(typeName)) {
        this.unresolvedReferences.push({
          fromNodeId,
          referenceName: typeName,
          referenceKind: insideTypeArgs ? 'type_of' : 'references',
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
        });
      }
      return; // type_identifier is a leaf
    }

    // scoped_type_identifier (e.g. `bevy::prelude::Query`): extract the
    // last segment as the type name so we link to the concrete type.
    if (node.type === 'scoped_type_identifier') {
      const nameChildren = node.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'type_identifier' || c.type === 'identifier'
      );
      const last = nameChildren[nameChildren.length - 1];
      if (last) {
        const typeName = getNodeText(last, this.source);
        if (typeName && !this.BUILTIN_TYPES.has(typeName)) {
          this.unresolvedReferences.push({
            fromNodeId,
            referenceName: typeName,
            referenceKind: insideTypeArgs ? 'type_of' : 'references',
            line: last.startPosition.row + 1,
            column: last.startPosition.column,
          });
        }
      }
      // Also recurse in case there are nested generic_type children
    }

    // Recurse into children (handles union_type, intersection_type, generic_type, etc.)
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child) {
        this.extractTypeRefsFromSubtree(child, fromNodeId,
          insideTypeArgs || child.type === 'type_arguments');
      }
    }
  }

  /**
   * Handle Pascal-specific AST structures.
   * Returns true if the node was fully handled and children should be skipped.
   */
  private visitPascalNode(node: SyntaxNode): boolean {
    const nodeType = node.type;

    // Unit/Program/Library → module node
    if (nodeType === 'unit' || nodeType === 'program' || nodeType === 'library') {
      const moduleNameNode = node.namedChildren.find(
        (c: SyntaxNode) => c.type === 'moduleName'
      );
      const name = moduleNameNode ? getNodeText(moduleNameNode, this.source) : '';
      // Fallback to filename without extension if module name is empty
      const moduleName = name || path.basename(this.filePath).replace(/\.[^.]+$/, '');
      this.createNode('module', moduleName, node);
      // Continue visiting children (interface/implementation sections)
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declType wraps declClass/declIntf/declEnum/type-alias
    // The name lives on declType, the inner node determines the kind
    if (nodeType === 'declType') {
      this.extractPascalDeclType(node);
      return true;
    }

    // declUses → import nodes for each unit name
    if (nodeType === 'declUses') {
      this.extractPascalUses(node);
      return true;
    }

    // declConsts → container; visit children for individual declConst
    if (nodeType === 'declConsts') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declConst') {
          this.extractPascalConst(child);
        }
      }
      return true;
    }

    // declConst at top level (outside declConsts)
    if (nodeType === 'declConst') {
      this.extractPascalConst(node);
      return true;
    }

    // declTypes → container for type declarations
    if (nodeType === 'declTypes') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // declVars → container for variable declarations
    if (nodeType === 'declVars') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child?.type === 'declVar') {
          const nameNode = getChildByField(child, 'name');
          if (nameNode) {
            const name = getNodeText(nameNode, this.source);
            this.createNode('variable', name, child);
          }
        }
      }
      return true;
    }

    // defProc in implementation section → extract calls but don't create duplicate nodes
    if (nodeType === 'defProc') {
      this.extractPascalDefProc(node);
      return true;
    }

    // declProp → property node
    if (nodeType === 'declProp') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('property', name, node, { visibility });
      }
      return true;
    }

    // declField → field node
    if (nodeType === 'declField') {
      const nameNode = getChildByField(node, 'name');
      if (nameNode) {
        const name = getNodeText(nameNode, this.source);
        const visibility = this.extractor!.getVisibility?.(node);
        this.createNode('field', name, node, { visibility });
      }
      return true;
    }

    // declSection → visit children (propagates visibility via getVisibility)
    if (nodeType === 'declSection') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // exprCall → extract function call reference
    if (nodeType === 'exprCall') {
      this.extractPascalCall(node);
      return true;
    }

    // interface/implementation sections → visit children
    if (nodeType === 'interface' || nodeType === 'implementation') {
      for (let i = 0; i < node.namedChildCount; i++) {
        const child = node.namedChild(i);
        if (child) this.visitNode(child);
      }
      return true;
    }

    // block (begin..end) → visit for calls
    if (nodeType === 'block') {
      this.visitPascalBlock(node);
      return true;
    }

    return false;
  }

  /**
   * Extract a Pascal declType node (class, interface, enum, or type alias)
   */
  private extractPascalDeclType(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);

    // Find the inner type declaration
    const declClass = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declClass'
    );
    const declIntf = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declIntf'
    );
    const typeChild = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'type'
    );

    if (declClass) {
      const classNode = this.createNode('class', name, node);
      if (classNode) {
        // Extract inheritance from typeref children of declClass
        this.extractPascalInheritance(declClass, classNode.id);
        // Visit class body
        this.nodeStack.push(classNode.id);
        for (let i = 0; i < declClass.namedChildCount; i++) {
          const child = declClass.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (declIntf) {
      const ifaceNode = this.createNode('interface', name, node);
      if (ifaceNode) {
        // Visit interface members
        this.nodeStack.push(ifaceNode.id);
        for (let i = 0; i < declIntf.namedChildCount; i++) {
          const child = declIntf.namedChild(i);
          if (child) this.visitNode(child);
        }
        this.nodeStack.pop();
      }
    } else if (typeChild) {
      // Check if it contains a declEnum
      const declEnum = typeChild.namedChildren.find(
        (c: SyntaxNode) => c.type === 'declEnum'
      );
      if (declEnum) {
        const enumNode = this.createNode('enum', name, node);
        if (enumNode) {
          // Extract enum members
          this.nodeStack.push(enumNode.id);
          for (let i = 0; i < declEnum.namedChildCount; i++) {
            const child = declEnum.namedChild(i);
            if (child?.type === 'declEnumValue') {
              const memberName = getChildByField(child, 'name');
              if (memberName) {
                this.createNode('enum_member', getNodeText(memberName, this.source), child);
              }
            }
          }
          this.nodeStack.pop();
        }
      } else {
        // Simple type alias: type TFoo = string / type TFoo = Integer
        this.createNode('type_alias', name, node);
      }
    } else {
      // Fallback: could be a forward declaration or simple alias
      this.createNode('type_alias', name, node);
    }
  }

  /**
   * Extract Pascal uses clause into individual import nodes
   */
  private extractPascalUses(node: SyntaxNode): void {
    const importText = getNodeText(node, this.source).trim();
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (child?.type === 'moduleName') {
        const unitName = getNodeText(child, this.source);
        this.createNode('import', unitName, child, {
          signature: importText,
        });
        // Create unresolved reference for resolution
        if (this.nodeStack.length > 0) {
          const parentId = this.nodeStack[this.nodeStack.length - 1];
          if (parentId) {
            this.unresolvedReferences.push({
              fromNodeId: parentId,
              referenceName: unitName,
              referenceKind: 'imports',
              line: child.startPosition.row + 1,
              column: child.startPosition.column,
            });
          }
        }
      }
    }
  }

  /**
   * Extract a Pascal constant declaration
   */
  private extractPascalConst(node: SyntaxNode): void {
    const nameNode = getChildByField(node, 'name');
    if (!nameNode) return;
    const name = getNodeText(nameNode, this.source);
    const defaultValue = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'defaultValue'
    );
    const sig = defaultValue ? getNodeText(defaultValue, this.source) : undefined;
    this.createNode('constant', name, node, { signature: sig });
  }

  /**
   * Extract Pascal inheritance (extends/implements) from declClass typeref children
   */
  private extractPascalInheritance(declClass: SyntaxNode, classId: string): void {
    const typerefs = declClass.namedChildren.filter(
      (c: SyntaxNode) => c.type === 'typeref'
    );
    for (let i = 0; i < typerefs.length; i++) {
      const ref = typerefs[i]!;
      const name = getNodeText(ref, this.source);
      this.unresolvedReferences.push({
        fromNodeId: classId,
        referenceName: name,
        referenceKind: i === 0 ? 'extends' : 'implements',
        line: ref.startPosition.row + 1,
        column: ref.startPosition.column,
      });
    }
  }

  /**
   * Extract calls and resolve method context from a Pascal defProc (implementation body).
   * Does not create a new node — the declaration was already captured from the interface section.
   */
  private extractPascalDefProc(node: SyntaxNode): void {
    // Find the matching declaration node by name to use as call parent
    const declProc = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'declProc'
    );
    if (!declProc) return;

    const nameNode = getChildByField(declProc, 'name');
    if (!nameNode) return;
    const fullName = getNodeText(nameNode, this.source).trim();
    // fullName is like "TAuthService.Create"
    const shortName = fullName.includes('.') ? fullName.split('.').pop()! : fullName;
    const fullNameKey = fullName.toLowerCase();
    const shortNameKey = shortName.toLowerCase();

    // Build method index on first use (O(n) once, then O(1) per lookup)
    if (!this.methodIndex) {
      this.methodIndex = new Map();
      for (const n of this.nodes) {
        if (n.kind === 'method' || n.kind === 'function') {
          const nameKey = n.name.toLowerCase();
          // Keep first seen short-name mapping to avoid silently overwriting earlier entries.
          if (!this.methodIndex.has(nameKey)) {
            this.methodIndex.set(nameKey, n.id);
          }

          // For Pascal methods, also index qualified forms (e.g. TAuthService.Create).
          if (n.kind === 'method') {
            const qualifiedParts = n.qualifiedName.split('::');
            if (qualifiedParts.length >= 2) {
              // Create suffix keys so both "Module.Class.Method" and "Class.Method" can resolve.
              for (let i = 0; i < qualifiedParts.length - 1; i++) {
                const scopedName = qualifiedParts.slice(i).join('.').toLowerCase();
                this.methodIndex.set(scopedName, n.id);
              }
            }
          }
        }
      }
    }

    const parentId =
      this.methodIndex.get(fullNameKey) ||
      this.methodIndex.get(shortNameKey) ||
      this.nodeStack[this.nodeStack.length - 1];
    if (!parentId) return;

    // Visit the block for calls
    const block = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'block'
    );
    if (block) {
      this.nodeStack.push(parentId);
      this.visitPascalBlock(block);
      this.nodeStack.pop();
    }
  }

  /**
   * Extract function calls from a Pascal expression
   */
  private extractPascalCall(node: SyntaxNode): void {
    if (this.nodeStack.length === 0) return;
    const callerId = this.nodeStack[this.nodeStack.length - 1];
    if (!callerId) return;

    // Get the callee name — first child is typically the identifier or exprDot
    const firstChild = node.namedChild(0);
    if (!firstChild) return;

    let calleeName = '';
    if (firstChild.type === 'exprDot') {
      // Qualified call: Obj.Method(...)
      const identifiers = firstChild.namedChildren.filter(
        (c: SyntaxNode) => c.type === 'identifier'
      );
      if (identifiers.length > 0) {
        calleeName = identifiers.map((id: SyntaxNode) => getNodeText(id, this.source)).join('.');
      }
    } else if (firstChild.type === 'identifier') {
      calleeName = getNodeText(firstChild, this.source);
    }

    if (calleeName) {
      this.unresolvedReferences.push({
        fromNodeId: callerId,
        referenceName: calleeName,
        referenceKind: 'calls',
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
      });
    }

    // Also visit arguments for nested calls
    const args = node.namedChildren.find(
      (c: SyntaxNode) => c.type === 'exprArgs'
    );
    if (args) {
      this.visitPascalBlock(args);
    }
  }

  /**
   * Recursively visit a Pascal block/statement tree for call expressions
   */
  private visitPascalBlock(node: SyntaxNode): void {
    for (let i = 0; i < node.namedChildCount; i++) {
      const child = node.namedChild(i);
      if (!child) continue;
      if (child.type === 'exprCall') {
        this.extractPascalCall(child);
      } else if (child.type === 'exprDot') {
        // Check if exprDot contains an exprCall
        for (let j = 0; j < child.namedChildCount; j++) {
          const grandchild = child.namedChild(j);
          if (grandchild?.type === 'exprCall') {
            this.extractPascalCall(grandchild);
          }
        }
      } else {
        this.visitPascalBlock(child);
      }
    }
  }
}


/**
 * Extract nodes and edges from source code.
 *
 * If `frameworkNames` is provided, framework-specific extractors matching
 * those names and the file's language are run after the tree-sitter pass.
 * Their nodes/references/errors are merged into the returned result.
 */
export function extractFromSource(
  filePath: string,
  source: string,
  language?: Language,
  frameworkNames?: string[]
): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();

  let result: ExtractionResult;

  // Use custom extractor for Svelte
  if (detectedLanguage === 'svelte') {
    const extractor = new SvelteExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'vue') {
    // Use custom extractor for Vue
    const extractor = new VueExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'liquid') {
    // Use custom extractor for Liquid
    const extractor = new LiquidExtractor(filePath, source);
    result = extractor.extract();
  } else if (detectedLanguage === 'yaml' || detectedLanguage === 'twig') {
    // No symbol extraction — file is tracked at the file-record level only.
    // Framework extractors (e.g. Drupal routing resolver) run below and may
    // add route nodes / references for yaml files such as *.routing.yml.
    result = { nodes: [], edges: [], unresolvedReferences: [], errors: [], durationMs: 0 };
  } else if (
    detectedLanguage === 'pascal' &&
    (fileExtension === '.dfm' || fileExtension === '.fmx')
  ) {
    // Use custom extractor for DFM/FMX form files
    const extractor = new DfmExtractor(filePath, source);
    result = extractor.extract();
  } else {
    const extractor = new TreeSitterExtractor(filePath, source, detectedLanguage);
    result = extractor.extract();
  }

  // Framework-specific extraction (routes, middleware, etc.)
  if (frameworkNames && frameworkNames.length > 0) {
    const allResolvers = getAllFrameworkResolvers();
    const applicable = getApplicableFrameworks(
      allResolvers.filter((r) => frameworkNames.includes(r.name)),
      detectedLanguage
    );
    for (const fw of applicable) {
      if (!fw.extract) continue;
      try {
        const fwResult = fw.extract(filePath, source);
        result.nodes.push(...fwResult.nodes);
        result.unresolvedReferences.push(...fwResult.references);
      } catch (err) {
        result.errors.push({
          message: `Framework extractor '${fw.name}' failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
          filePath,
          severity: 'warning',
        });
      }
    }
  }

  return result;
}
