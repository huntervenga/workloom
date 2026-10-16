import ts from 'typescript';

export interface AuditDiagnostic { line: number; column: number; kind: string; text: string }
export interface DynamicKeyAudit { keys: readonly string[]; reason: string }
export interface AuditOptions {
  englishKeys: ReadonlySet<string>;
  /** Each exception applies to an exact literal, with a reviewed reason. */
  literalExemptions?: ReadonlyMap<string, string>;
  /** Finite keys extracted from a named table or caller list. Unknown expressions fail. */
  dynamicKeys?: ReadonlyMap<string, DynamicKeyAudit>;
}
const uiAttributes = /^(?:aria-label|aria-description|alt|title|label|description|placeholder|hint|caption|tooltip|emptyLabel|submitLabel|loadingLabel|notice|message)$/i;
const codeAttributes = /^(?:className|class|id|htmlFor|key|name|type|value|defaultValue|role|tabIndex|href|to|target|rel|accept|method|autoComplete|inputMode|pattern|format|scope|align|side|variant|tone|size|data-.*|aria-(?!label$|description$).*)$/;
const textPattern = /\p{L}/u;
function isCssClassList(value: string): boolean {
  const plain = new Set(['flex', 'inline', 'block', 'grid', 'hidden', 'relative', 'absolute', 'fixed', 'sticky', 'contents', 'border', 'truncate', 'uppercase', 'lowercase', 'capitalize', 'italic', 'antialiased', 'container', 'isolate', 'grow', 'shrink', 'table']);
  const tokens = value.split(/\s+/);
  return tokens.length > 1 && tokens.every(token => plain.has(token) || (/^[a-z0-9!_[\]():%.,#/'=+@-]+$/.test(token) && /[-:[\]]/.test(token)));
}
function isMachineComparison(node: ts.Node): boolean {
  return (ts.isElementAccessExpression(node.parent) && node.parent.argumentExpression === node) || ts.isBinaryExpression(node.parent) && ['===', '!==', '==', '!='].includes(node.parent.operatorToken.getText());
}
function unwrapped(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isSatisfiesExpression(node) ? unwrapped(node.expression) : node;
}
function stringAlternatives(input: ts.Expression | undefined): string[] | null {
  if (!input) return null;
  const node = unwrapped(input);
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isConditionalExpression(node)) {
    const yes = stringAlternatives(node.whenTrue), no = stringAlternatives(node.whenFalse);
    return yes && no ? [...yes, ...no] : null;
  }
  return null;
}
function nearestAttribute(node: ts.Node): string | null {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isJsxAttribute(parent)) return parent.name.getText();
    if (ts.isJsxElement(parent) || ts.isJsxSelfClosingElement(parent)) return null;
  }
  return null;
}
function insideTranslation(node: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isCallExpression(parent) && (parent.expression.getText() === 't' || parent.expression.getText().endsWith('.t'))) return true;
    if (ts.isFunctionLike(parent) || ts.isJsxElement(parent)) return false;
  }
  return false;
}
function inLabelDictionary(node: ts.Node): boolean {
  const container = ts.isPropertyAssignment(node.parent) ? node.parent.parent : ts.isArrayLiteralExpression(node.parent) ? node.parent : null;
  if (!container) return false;
  for (let parent: ts.Node | undefined = container.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent)) return !!parent.initializer && unwrapped(parent.initializer) === container && /(?:labels?|titles?|descriptions?|hints?|placeholders?|messages?|notices?|copy)$/i.test(parent.name.getText());
    if (!ts.isAsExpression(parent) && !ts.isSatisfiesExpression(parent) && !ts.isParenthesizedExpression(parent)) return false;
  }
  return false;
}
function moduleSnapshot(node: ts.Node): boolean {
  for (let parent: ts.Node | undefined = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return false;
  }
  return true;
}
function identifierKeys(node: ts.Expression | undefined, sf: ts.SourceFile): string[] | null {
  if (!node || !ts.isIdentifier(node)) return null;
  const target = node;
  const name = target.text;
  let found: ts.VariableDeclaration | undefined;
  function visit(candidate: ts.Node) {
    if (ts.isVariableDeclaration(candidate) && ts.isIdentifier(candidate.name) && candidate.name.text === name && candidate.pos < target.pos) {
      let scope: ts.Node = candidate;
      while (scope.parent && !ts.isBlock(scope) && !ts.isSourceFile(scope)) scope = scope.parent;
      if (scope.pos <= target.pos && scope.end >= target.end && (!found || candidate.pos > found.pos)) found = candidate;
    }
    ts.forEachChild(candidate, visit);
  }
  visit(sf);
  return found ? stringAlternatives(found.initializer) : null;
}
export function auditUiSource(source: string, fileName: string, options: AuditOptions): { diagnostics: AuditDiagnostic[]; calls: number } {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith('.tsx') || fileName.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const diagnostics: AuditDiagnostic[] = [];
  let calls = 0;
  function report(node: ts.Node, kind: string, text: string) {
    if (options.literalExemptions?.has(text)) return;
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    diagnostics.push({ line: line + 1, column: character + 1, kind, text });
  }
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && (node.expression.getText(sf) === 't' || node.expression.getText(sf).endsWith('.t') || node.expression.getText(sf) === 'message')) {
      const translates = node.expression.getText(sf) !== 'message';
      if (translates) calls++;
      if (translates && moduleSnapshot(node)) report(node, 'module-scope translation snapshot', node.getText(sf));
      const argument = node.arguments[0];
      const expression = argument?.getText(sf) ?? '(missing)';
      const literalKeys = stringAlternatives(argument) ?? identifierKeys(argument, sf);
      const audited = options.dynamicKeys?.get(expression);
      const keys = literalKeys ?? audited?.keys;
      if (!keys || (!literalKeys && (!audited?.reason.trim() || keys.length === 0))) report(node, 'unexplained dynamic translation key', expression);
      else for (const key of keys) if (!options.englishKeys.has(key)) report(node, 'missing English key', key);
    }
    if (ts.isJsxText(node)) {
      const value = node.text.trim().replace(/\s+/g, ' ');
      if (textPattern.test(value)) report(node, 'hardcoded JSX text', value);
    } else if (ts.isStringLiteralLike(node) && textPattern.test(node.text) && !insideTranslation(node)) {
      const attr = nearestAttribute(node);
      const parent = node.parent;
      if (options.englishKeys.has(node.text)) { /* A checked catalog-key reference, translated at its use site. */ }
      else if ((ts.isPropertyAssignment(parent) && (parent.name === node || /^(?:tone|value|role|type|key|kind|command|state|style)$/.test(parent.name.getText(sf)))) || isMachineComparison(node) || isCssClassList(node.text)) { /* Stable machine conditions and CSS. */ }
      else if (attr && codeAttributes.test(attr)) { /* Stable attribute values. */ }
      else if (/[А-Яа-яЁё]/.test(node.text)) report(node, 'hardcoded text', node.text);
      else if (attr && uiAttributes.test(attr)) report(node, 'hardcoded UI attribute', node.text);
      else if (ts.isPropertyAssignment(parent) && uiAttributes.test(parent.name.getText(sf).replace(/^['"]|['"]$/g, ''))) report(node, 'hardcoded UI message', node.text);
      else if (inLabelDictionary(node)) report(node, 'hardcoded label dictionary', node.text);
      else if (ts.isJsxExpression(parent) && !attr) report(node, 'hardcoded JSX expression', node.text);
      else if ((ts.isNewExpression(parent) && /Error$/.test(parent.expression.getText(sf))) || (ts.isCallExpression(parent) && /^(?:set\w*(?:Error|Message|Notice|Announcement)|alert|confirm)$/.test(parent.expression.getText(sf)))) report(node, 'hardcoded error or announcement', node.text);
      else if (/\p{L}[^\n]*\s+\p{L}/u.test(node.text) && !/^(?:https?:|[./]|\w+:\/\/)/.test(node.text) && !ts.isImportDeclaration(parent) && !ts.isExportDeclaration(parent)) report(node, 'possible hardcoded prose', node.text);
    } else if ((ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) && textPattern.test(node.text) && !insideTranslation(node)) {
      const attr = nearestAttribute(node);
      if (!(attr && codeAttributes.test(attr)) && (/[А-Яа-яЁё]/.test(node.text) || /\p{L}[^\n]*\s/u.test(node.text))) report(node, 'hardcoded template text', node.text);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  return { diagnostics, calls };
}

/** Extract a finite translation-key table. Every selected value must be a string literal. */
export function tableTranslationKeys(source: string, variableName: string, tupleIndex?: number): string[] {
  const sf = ts.createSourceFile('table.ts', source, ts.ScriptTarget.Latest, true);
  let initializer: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(sf) === variableName) initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (!initializer) throw new Error(`Missing audited translation table ${variableName}`);
  const value = unwrapped(initializer);
  const expressions = ts.isObjectLiteralExpression(value)
    ? value.properties.map(property => { if (!ts.isPropertyAssignment(property)) throw new Error(`Nonliteral audited table ${variableName}`); return property.initializer; })
    : ts.isArrayLiteralExpression(value) && tupleIndex !== undefined
      ? value.elements.map(item => { const tuple = unwrapped(item); if (!ts.isArrayLiteralExpression(tuple) || !tuple.elements[tupleIndex]) throw new Error(`Invalid audited tuple ${variableName}`); return tuple.elements[tupleIndex] as ts.Expression; })
      : (() => { throw new Error(`Invalid audited translation table ${variableName}`); })();
  return expressions.map(expression => { const strings = stringAlternatives(expression); if (!strings || strings.length !== 1) throw new Error(`Nonliteral translation key in ${variableName}`); return strings[0] as string; });
}

export function callTranslationKeys(source: string, functionName: string, argumentIndex: number, allowEmpty = false, constructor = false, dynamicArguments: ReadonlyMap<string, readonly string[]> = new Map()): string[] {
  const sf = ts.createSourceFile('callers.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const keys: string[] = [];
  function visit(node: ts.Node) {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && (constructor ? ts.isNewExpression(node) : ts.isCallExpression(node)) && node.expression.getText(sf) === functionName) {
      const argument = node.arguments?.[argumentIndex];
      if (allowEmpty && (argument?.kind === ts.SyntaxKind.NullKeyword || argument && ts.isStringLiteralLike(argument) && argument.text === '')) return;
      const strings = stringAlternatives(argument) ?? (argument ? dynamicArguments.get(argument.getText(sf)) : undefined);
      if (!strings?.length) throw new Error(`Nonliteral translation key passed to ${functionName}`);
      keys.push(...strings);
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
  if (!keys.length) throw new Error(`No callers found for audited translation function ${functionName}`);
  return keys;
}

/** JSON.parse silently accepts duplicate properties; reject them before resources enter the bundle. */
export function assertUniqueJsonKeys(source: string, resource: string): void {
  const sf = ts.parseJsonText(resource, source);
  function visit(node: ts.Node) {
    if (ts.isObjectLiteralExpression(node)) {
      const seen = new Set<string>();
      for (const property of node.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const key = ts.isStringLiteralLike(property.name) ? property.name.text : property.name.getText(sf);
        if (seen.has(key)) throw new Error(`Duplicate JSON property in ${resource}: ${key}`);
        seen.add(key);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sf);
}
