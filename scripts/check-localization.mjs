// Checks JSON resources and TypeScript UI syntax, including English literals. Run after UI edits.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const web = join(root, 'apps/web/src');
const { LocalizationManager, catalogsFromModules, catalogMessages } = await import(pathToFileURL(join(web, 'i18n/LocalizationManager.ts')));

function* files(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else yield path;
  }
}
const { auditUiSource, tableTranslationKeys, callTranslationKeys, assertUniqueJsonKeys } = await import('./localization-audit.ts');
const resources = Object.fromEntries([...files(join(web, 'i18n/locales'))].filter(path => path.endsWith('.json')).map(path => { const source = readFileSync(path, 'utf8'); assertUniqueJsonKeys(source, relative(root, path)); return [path, JSON.parse(source)]; }));
const catalogs = catalogsFromModules(resources);
const manager = new LocalizationManager(catalogs);
const english = new Map(Object.entries(catalogs.en).flatMap(([namespace, value]) => [...catalogMessages(value, namespace)]));
const violations = [];
// These diagnostics are never shown directly: safe error descriptions use fixed catalog keys.
const literalExemptions = new Map([
  ['apps/web/src/main.tsx:Root element #root is missing', 'Developer bootstrap diagnostic; never displayed.'],
  ['apps/web/src/features/projects/ProjectActions.tsx:button, a', 'DOM selector for dismissing the action popover; never rendered as copy.'],
  ['apps/web/src/features/work-categories/CategoryBadge.tsx:legacy', 'Stable reason-enum lookup fallback; the indexed result is a translated label, not the enum string.'],
  ['apps/web/src/app/session.tsx:useSession must be used inside SessionProvider', 'Developer hook invariant; route boundary shows fixed localized error copy.'],
  ['apps/web/src/features/identity/identity.tsx:useMe must be used inside MeProvider', 'Developer hook invariant; route boundary shows fixed localized error copy.'],
  ['apps/web/src/lib/api.ts:Workloom API request failed: ', 'ApiError diagnostic only; describeError renders safe localized copy by code/kind.'],
  ['apps/web/src/lib/api.ts:A mutation needs a UUID Idempotency-Key.', 'Developer protocol invariant; describeError renders safe localized copy.'],
  ['apps/web/src/lib/idempotency.ts:An earlier write has an unknown outcome; resend it unchanged before sending another.', 'Class identity maps to localized shared SaveError copy; error.message is never rendered.'],
  ['apps/web/src/lib/idempotency.ts:An earlier write is still waiting for an answer; wait for it before sending another.', 'Class identity maps to localized shared SaveError copy; error.message is never rendered.'],
  ["apps/web/src/features/mcp/secret.ts:Invalid local credential material.", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/meetings/MeetingDrawer.tsx:Preview failed", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/meetings/MeetingDrawer.tsx:Recorded attendance unavailable", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/planning/FreezeDialog.tsx:Preview failed", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/recurrence/RecurrenceManagementDialog.tsx:Read failed", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/recurrence/useRecurrenceManagement.ts:Recurrence preview failed.", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/recurrence/useRecurrenceWorkspace.ts:Recurrence preview failed.", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/work-categories/queries.ts:Invalid time projection", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/work-categories/useTaskTimeTable.tsx:Time read failed", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/work-categories/useTaskTimeTable.tsx:Period scope mismatch", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/work-categories/useTaskTimeTable.tsx:Incomplete time projection", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/work-categories/useTaskTimeTable.tsx:Task type unavailable", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
  ["apps/web/src/features/work-categories/useTaskTimeTable.tsx:Work record unavailable", "Internal read/validation diagnostic; UI uses fixed describeError catalog copy, never error.message."],
]);
// Exact machine strings in task editors; UI labels remain catalog checked.
// Exact AST template-text fragments from dropCellStyle.boxShadow; no pattern or whole-file exemption.
literalExemptions.set("apps/web/src/features/task-table/TaskTable.tsx:inset 0 ", "CSS boxShadow template head in dropCellStyle; assigned only to cell style, never rendered as user copy.");
literalExemptions.set("apps/web/src/features/task-table/TaskTable.tsx:px 0 var(--color-accent), var(--tw-shadow, 0 0 #0000)", "CSS boxShadow template tail in dropCellStyle; retains the cell edge shadow and is never rendered as user copy.");
literalExemptions.set("apps/web/src/features/task-table/TaskTable.tsx:flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-highlighted:bg-accent-soft data-disabled:cursor-default data-disabled:opacity-50", "Radix menu CSS tokens; never user-visible copy.");
literalExemptions.set("apps/web/src/features/task-table/TaskTable.tsx:input, textarea, select, [contenteditable=\"true\"], [data-editing], [role=\"menu\"], [role=\"listbox\"], [role=\"dialog\"]", "DOM selector preserving native editor menus; never rendered as copy.");
literalExemptions.set("apps/web/src/features/tasks/InitialTaskCells.tsx:textarea, input, button", "Focus-target DOM selector inside the staged cell editor; never user-visible copy.");
literalExemptions.set("apps/web/src/features/tasks/QuickTaskAdd.tsx:flex h-8 cursor-default select-none items-center rounded px-2 outline-none data-[highlighted]:bg-canvas data-[disabled]:text-subtle", "Radix draft action menu CSS tokens; never user-visible copy.");
literalExemptions.set("apps/web/src/features/tasks/TaskCompletionAction.tsx:group/complete inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent-ink disabled:opacity-50", "Named CSS group and completion-control CSS tokens; never user-visible copy.");
literalExemptions.set("apps/web/src/features/workspace/workspaceCreationApi.ts:A mutation needs a UUID Idempotency-Key.", "Programmer invariant from an invalid generated key; UI maps non-API errors to workspace.create.failed, never error.message.");
literalExemptions.set("apps/web/src/features/workspace/workspaceCreationController.ts:The workspace answer arrived after the session changed.", "Internal CreationIdentityChangedError diagnostic; UI maps its class to workspace.create.signedOut without displaying this message.");
literalExemptions.set("apps/web/src/features/tasks/TaskDateInput.tsx:mt-1 block h-9 w-full min-w-0 rounded border border-line bg-surface px-2 text-sm text-ink outline-none focus:border-accent-line focus:ring-2 focus:ring-accent-soft disabled:bg-canvas disabled:text-muted aria-[invalid=true]:border-red-300", "Date-input CSS tokens assigned to className; this exact literal is never rendered as user copy.");
literalExemptions.set("apps/web/src/features/tasks/api.ts:BULK_RESPONSE_INCOMPLETE", "Internal response-schema refinement code only; parseResponse discards Zod issues and throws ApiError invalid_response, which describeError maps to fixed catalog copy without rendering this diagnostic.");
// Exact CSS/media-query machine strings; none is ever rendered as user copy.
literalExemptions.set("apps/web/src/features/dependencies/graphPresentation.ts:0 0 0 2px var(--color-danger-soft)", "CSS boxShadow ring for status-violation nodes in graphNodeTone; joined into node style only, never rendered as user copy.");
literalExemptions.set("apps/web/src/features/dependencies/graphPresentation.ts:0 0 0 4px var(--color-focus)", "CSS boxShadow focus ring in graphNodeTone; joined into node style only, never rendered as user copy.");
literalExemptions.set("apps/web/src/features/tasks/TaskTagPicker.tsx:rounded px-1 py-1 text-xs font-medium text-accent-ink hover:bg-canvas aria-disabled:text-muted", "Shared actionClassName CSS tokens assigned only to button className; never user-visible copy.");
literalExemptions.set("apps/web/src/features/theme/ThemeManager.ts:(prefers-color-scheme: dark)", "DARK_QUERY media query passed only to matchMedia; never rendered as user copy.");
literalExemptions.set("apps/web/src/features/team/teamApi.ts:TEAM_COMMAND_INVALID_UUID", "Developer UUID protocol invariant; Team UI renders the fixed team.command.failed catalog key and never error.message.");
literalExemptions.set("apps/web/src/features/fields/FieldPolicyPanel.tsx:FIELD_POLICY_INVALID_LOCAL_DEADLINE", "Internal strict local-time parser invariant; the Rules form catches it and renders fieldRules.invalid, never error.message.");
literalExemptions.set("apps/web/src/features/fields/FieldPolicyPanel.tsx:FIELD_POLICY_INVALID_LIMIT", "Internal raw numeric-draft validation invariant; the Rules form catches it and renders fieldRules.invalid, never error.message.");

const readSource = path => readFileSync(join(root, path), 'utf8');
// Finite descriptor sources below are inspected as syntax, never executed. New computed
// producers must get an explicit domain instead of inheriting every English catalog key.
const unwrap = node => ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
const parsedSource = source => ts.createSourceFile('audited.ts', source, ts.ScriptTarget.Latest, true);
function namedInitializer(source, name) {
  let found;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText() === name) found = node.initializer; ts.forEachChild(node, visit); };
  visit(parsedSource(source));
  if (!found) throw new Error(`Missing finite descriptor source ${name}`);
  return unwrap(found);
}
function literalKeyLeaves(source, name) {
  const leaves = node => {
    node = unwrap(node);
    if (node.kind === ts.SyntaxKind.NullKeyword) return [];
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isObjectLiteralExpression(node)) return node.properties.flatMap(property => {
      if (!ts.isPropertyAssignment(property)) throw new Error(`Nonliteral descriptor table ${name}`);
      return leaves(property.initializer);
    });
    throw new Error(`Nonliteral descriptor table leaf ${name}`);
  };
  return leaves(namedInitializer(source, name));
}
function schemaPropertyDomain(source, schemaName, propertyName) {
  const values = [];
  const visit = node => {
    if (ts.isPropertyAssignment(node) && node.name.getText() === propertyName) {
      const value = unwrap(node.initializer);
      if (!ts.isCallExpression(value)) throw new Error(`Nonfinite ${schemaName}.${propertyName}`);
      const argument = value.arguments[0];
      if (value.expression.getText() === 'z.literal' && argument && ts.isStringLiteralLike(argument)) values.push(argument.text);
      else if (value.expression.getText() === 'z.enum' && argument && ts.isArrayLiteralExpression(argument)) {
        for (const entry of argument.elements) { if (!ts.isStringLiteralLike(entry)) throw new Error(`Nonliteral enum ${schemaName}`); values.push(entry.text); }
      } else throw new Error(`Unsupported finite schema ${schemaName}.${propertyName}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(namedInitializer(source, schemaName));
  if (!values.length) throw new Error(`Missing finite schema ${schemaName}.${propertyName}`);
  return values;
}
function stringUnionDomain(source, typeName) {
  let values;
  const visit = node => {
    if (ts.isTypeAliasDeclaration(node) && node.name.text === typeName) {
      if (!ts.isUnionTypeNode(node.type)) throw new Error(`Nonfinite type ${typeName}`);
      values = node.type.types.map(type => { if (!ts.isLiteralTypeNode(type) || !ts.isStringLiteralLike(type.literal)) throw new Error(`Nonliteral type ${typeName}`); return type.literal.text; });
    }
    ts.forEachChild(node, visit);
  };
  visit(parsedSource(source));
  if (!values?.length) throw new Error(`Missing finite type ${typeName}`);
  return values;
}
function namedFunction(source, name) {
  let found;
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name) found = node;
    if (ts.isVariableDeclaration(node) && node.name.getText() === name && node.initializer && ts.isArrowFunction(unwrap(node.initializer))) found = unwrap(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(parsedSource(source));
  if (!found?.body) throw new Error(`Missing finite key function ${name}`);
  return found;
}
function functionResultKeys(source, name, domains) {
  const values = node => {
    node = unwrap(node);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (node.kind === ts.SyntaxKind.NullKeyword) return [];
    if (ts.isConditionalExpression(node)) return [...values(node.whenTrue), ...values(node.whenFalse)];
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return [...values(node.left), ...values(node.right)];
    const known = domains.get(node.getText());
    if (!known) throw new Error(`Unaudited ${name} return producer ${node.getText()}`);
    return known;
  };
  const body = namedFunction(source, name).body;
  if (!ts.isBlock(body)) return values(body);
  const keys = [];
  const visit = node => {
    if (ts.isReturnStatement(node)) { if (!node.expression) throw new Error(`Empty key return ${name}`); keys.push(...values(node.expression)); }
    else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  visit(body);
  if (!keys.length) throw new Error(`No finite key returns ${name}`);
  return keys;
}
function parameterDefaultKey(source, name, parameter) {
  const value = namedFunction(source, name).parameters.find(item => item.name.getText() === parameter)?.initializer;
  if (!value || !ts.isStringLiteralLike(unwrap(value))) throw new Error(`Nonliteral default key ${name}.${parameter}`);
  return unwrap(value).text;
}
function descriptorPropertyKeys(source, domains) {
  const keys = [];
  const alternatives = input => {
    const node = unwrap(input);
    if (ts.isStringLiteralLike(node)) return [node.text];
    if (ts.isConditionalExpression(node)) return [...alternatives(node.whenTrue), ...alternatives(node.whenFalse)];
    const known = domains.get(node.getText());
    if (!known?.length) throw new Error(`Unaudited descriptor key producer ${node.getText()}`);
    return known;
  };
  const visit = node => {
    if (ts.isPropertyAssignment(node) && ['key', 'note'].includes(node.name.getText())) {
      // A note can itself be a Phrase object; its nested key is visited separately.
      if (!ts.isObjectLiteralExpression(unwrap(node.initializer))) keys.push(...alternatives(node.initializer));
    }
    ts.forEachChild(node, visit);
  };
  visit(parsedSource(source));
  return keys;
}

const dynamicKeys = new Map([
  ['apps/web/src/features/cutoff/CutoffPanel.tsx', new Map([
    ['readinessKeys[data.readiness]', { keys: tableTranslationKeys(readSource('apps/web/src/features/cutoff/CutoffPanel.tsx'), 'readinessKeys'), reason: 'Exhaustive finite cutoff readiness enum maps to literal catalog keys; persisted frozen/baseline consistency is validated by the response schema.' }],
    ['blockerKeys[blocker.code]', { keys: tableTranslationKeys(readSource('apps/web/src/features/cutoff/CutoffPanel.tsx'), 'blockerKeys'), reason: 'Exhaustive finite public cutoff/recurrence blocker codes map to safe literal copy, never server messages.' }],
    ['automationKeys[data.automation.state]', { keys: tableTranslationKeys(readSource('apps/web/src/features/cutoff/CutoffPanel.tsx'), 'automationKeys'), reason: 'Three finite persisted automation states map to literal catalog keys.' }],
  ])],
  ['apps/web/src/features/task-table/PersonalColumnsDialog.tsx', new Map([['builtinLabels[ref.key]', { keys: tableTranslationKeys(readSource('apps/web/src/features/task-table/PersonalColumnsDialog.tsx'), 'builtinLabels'), reason: 'Exhaustive finite ten built-in table-column IDs map to literal localization keys.' }]])],
  ['apps/web/src/features/task-comments/TaskDiscussion.tsx', new Map([
    ['activityKeys[event.kind]', { keys: tableTranslationKeys(readSource('apps/web/src/features/task-comments/TaskDiscussion.tsx'), 'activityKeys'), reason: 'Exhaustive finite public activity kind dictionary; all values are literal localization keys.' }],
    ['problemKeys[problem]', { keys: tableTranslationKeys(readSource('apps/web/src/features/task-comments/TaskDiscussion.tsx'), 'problemKeys'), reason: 'Finite local comment validation enum mapped to literal message keys; server text is never rendered.' }],
  ])],
  ['apps/web/src/features/recurrence/useRecurrenceManagement.ts', new Map([["problemCopy.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`))?.[1] ?? 'recurrence.checkTheChangeFields'", { keys: [...tableTranslationKeys(readSource('apps/web/src/features/recurrence/useRecurrenceManagement.ts'), 'problemCopy', 1), 'recurrence.checkTheChangeFields'], reason: 'Fixed schema-path to safe message-key tuples with a fixed localized fallback; no schema message is rendered.' }]])],
  ['apps/web/src/features/recurrence/useRecurrenceWorkspace.ts', new Map([["problemCopy.find(([prefix]) => path === prefix || path.startsWith(`${prefix}.`))?.[1] ?? 'recurrence.checkTheSeriesFields'", { keys: [...tableTranslationKeys(readSource('apps/web/src/features/recurrence/useRecurrenceWorkspace.ts'), 'problemCopy', 1), 'recurrence.checkTheSeriesFields'], reason: 'Fixed schema-path to safe message-key tuples with a fixed localized fallback; no schema message is rendered.' }]])],

  ['apps/web/src/app/AsyncRoute.tsx', new Map([['label', { keys: callTranslationKeys(readSource('apps/web/src/app/AppRoutes.tsx'), 'createAsyncRoute', 1), reason: 'Loading labels are a finite literal caller list in AppRoutes; the extractor rejects dynamic callers.' }]])],
  ['apps/web/src/features/imports/MappingEditor.tsx', new Map([['label', { keys: tableTranslationKeys(readSource('apps/web/src/features/imports/mapping.ts'), 'coreColumns', 1), reason: 'coreColumns is the imported finite tuple of machine column names and translation keys.' }]])],
  ['apps/web/src/features/imports/issueCopy.ts', new Map([["Object.hasOwn(issueKeys, issue.code) ? issueKeys[issue.code] : 'imports.issues.unknown'", { keys: [...tableTranslationKeys(readSource('apps/web/src/features/imports/issueCopy.ts'), 'issueKeys'), 'imports.issues.unknown'], reason: 'Exhaustive typed public issue-code dictionary with a fixed safe unknown-code fallback.' }]])],
  ['apps/web/src/features/recurrence/RecurrenceRuleFields.tsx', new Map([['name', { keys: tableTranslationKeys(readSource('apps/web/src/features/recurrence/RecurrenceRuleFields.tsx'), 'weekdayNames', 1), reason: 'Seven finite ISO weekday tuples, all label keys checked against English.' }]])],
]);
// Nullable key states retain drafts while translating their current message at render time.
// Setter extraction rejects any nonliteral new key source rather than trusting its TypeScript type.
for (const [file, states] of [
  ['apps/web/src/features/meetings/CreateMeetingDialog.tsx', [['validation', 'setValidation']]],
  ['apps/web/src/features/meetings/MeetingAttendanceBatch.tsx', [['validation', 'setValidation']]],
  ['apps/web/src/features/meetings/MeetingDrawer.tsx', [['validation', 'setValidation'], ['notice', 'setNotice']]],
  ['apps/web/src/features/meetings/MeetingTaskDetails.tsx', [['notice', 'setNotice']]],
  ['apps/web/src/features/planning/CommitmentDialog.tsx', [['validation', 'setValidation']]],
  ['apps/web/src/features/planning/FactDialog.tsx', [['validation', 'setValidation']]],
  ['apps/web/src/features/planning/PeriodDialog.tsx', [['validation', 'setValidation']]],
  ['apps/web/src/features/work-categories/RecategorizeDialog.tsx', [['validation', 'setValidation'], ['notice', 'setNotice']]],
  ['apps/web/src/features/work-categories/WorkCategorySettings.tsx', [['notice', 'setNotice']]],
]) {
  const rules = dynamicKeys.get(file) ?? new Map();
  for (const [state, setter] of states) {
    const extracted = callTranslationKeys(readSource(file), setter, 0, true);
    // Attendance explicitly handles this non-key sentinel before t(validation); its row errors
    // are separately translated, and every other assigned value remains checked here.
    const keys = file === 'apps/web/src/features/meetings/MeetingAttendanceBatch.tsx' && state === 'validation' ? extracted.filter(key => key !== 'reviewErrors') : extracted;
    rules.set(state, { keys, reason: `Typed nullable key state; all ${setter} calls are extracted and must be literal keys or an empty reset. Attendance's explicit reviewErrors branch renders separately translated row errors.` });
  }
  dynamicKeys.set(file, rules);
}
const fileErrorKeys = callTranslationKeys(readSource('apps/web/src/features/imports/file.ts'), 'CsvFileReadError', 0, false, true);
dynamicKeys.set('apps/web/src/features/imports/file.ts', new Map([['messageKey', { keys: fileErrorKeys, reason: 'Every vetted CsvFileReadError constructor in this module takes a checked literal message key.' }]]));
dynamicKeys.set('apps/web/src/features/imports/useImportWorkspace.ts', new Map([['fileError', { keys: [...fileErrorKeys, 'imports.couldNotReadTheFile'], reason: 'Vetted CsvFileReadError carries a finite literal constructor key; unknown native exceptions use the fixed generic fallback.' }]]));
// Task draft issues retain key+parameters through locale changes. The only nonliteral factory
// input is the estimate parser's own finite invalid(...) key set, checked independently here.
const estimateKeys = callTranslationKeys(readSource('apps/web/src/features/task-table/estimate.ts'), 'invalid', 0);
const taskIssueKeys = callTranslationKeys(readSource('apps/web/src/features/tasks/taskDraft.ts'), 'taskDraftIssue', 0, false, false, new Map([['estimate.messageKey', estimateKeys]]));
dynamicKeys.set('apps/web/src/features/task-table/estimate.ts', new Map([['messageKey', { keys: estimateKeys, reason: 'EstimateValidationKey is created only by finite literal invalid(...) calls in this parser.' }]]));
dynamicKeys.set('apps/web/src/features/tasks/TaskFields.tsx', new Map([['message.key', { keys: taskIssueKeys, reason: 'Task field errors use descriptors from the taskDraftIssue factory, whose literal calls and finite estimate-message input are extracted.' }]]));
dynamicKeys.set('apps/web/src/features/tasks/InlineTaskEdit.tsx', new Map([['currentError.key', { keys: taskIssueKeys, reason: 'Inline editing renders the same checked TaskDraftIssue descriptors as the task drawer.' }]]));
dynamicKeys.set('apps/web/src/features/workspace/WorkspaceCreation.tsx', new Map([['rejectionKey(error)', { keys: ['workspace.create.signedOut', 'workspace.create.failed', 'workspace.create.rejectedInput', 'workspace.create.notAllowed', 'workspace.create.rateLimited'], reason: 'Finite rejectionKey maps identity changes, local failures and API error kinds to fixed catalog copy; server error text is never displayed.' }]]));
dynamicKeys.set('apps/web/src/features/tasks/QuickTaskAdd.tsx', new Map([['issue.key', { keys: taskIssueKeys, reason: 'Quick add renders the same checked TaskDraftIssue descriptors as the task drawer.' }]]));
dynamicKeys.set('apps/web/src/features/tasks/TaskTagPicker.tsx', new Map([['problemKey', { keys: tableTranslationKeys(readSource('apps/web/src/features/tasks/TaskTagPicker.tsx'), 'problemKeys'), reason: 'problemKey is problemKeys[shownProblem] or undefined; the finite local tag-create problem map holds only literal catalog keys, never server text.' }]]));

// Paired-date renderers receive the same finite factory descriptors, not server error text.
for (const file of [
  'apps/web/src/features/tasks/TaskFields.tsx',
  'apps/web/src/features/tasks/InlineTaskEdit.tsx',
  'apps/web/src/features/tasks/TaskDraftCells.tsx',
]) {
  const rules = dynamicKeys.get(file) ?? new Map();
  for (const expression of ['errors.startDate.key', 'errors.dueDate.key']) {
    rules.set(expression, { keys: taskIssueKeys, reason: 'Date errors are TaskDraftIssue descriptors from the taskDraftIssue factory; all literal factory calls and the finite estimate-parser input are extracted above.' });
  }
  dynamicKeys.set(file, rules);
}


dynamicKeys.set('apps/web/src/features/tasks/TaskDrawer.tsx', new Map([
  ['errors.form.key', { keys: taskIssueKeys, reason: 'Task form errors are descriptors from the checked taskDraftIssue factory.' }],
  ['notice', { keys: callTranslationKeys(readSource('apps/web/src/features/tasks/TaskDrawer.tsx'), 'setNotice', 0, true), reason: 'Nullable task notice key state; every setter call is extracted and must be a literal key or reset.' }],
]));
// Shared message(...) descriptors keep notices/validation reactive. Each renderer lists its
// actual factory source(s), including the option-name validator imported by the option editor.
for (const [file, expressions, sources] of [
  ['apps/web/src/features/fields/FieldDefinitionForm.tsx', ['nameError.key', 'optionError.key'], ['apps/web/src/features/fields/FieldDefinitionForm.tsx']],
  ['apps/web/src/features/fields/FieldManagerDialog.tsx', ['announcement.key'], ['apps/web/src/features/fields/FieldManagerDialog.tsx']],
  ['apps/web/src/features/fields/FieldOptionsEditor.tsx', ['announcement.key', 'renameError.key', 'addError.key'], ['apps/web/src/features/fields/FieldOptionsEditor.tsx', 'apps/web/src/features/fields/FieldDefinitionForm.tsx']],
  ['apps/web/src/features/fields/FieldValueForm.tsx', ['notice.key'], ['apps/web/src/features/fields/FieldValueForm.tsx']],
  ['apps/web/src/features/fields/ProjectColumnsEditor.tsx', ['announcement.key'], ['apps/web/src/features/fields/ProjectColumnsEditor.tsx']],
  ['apps/web/src/features/tasks/TagDialogs.tsx', ['fieldError.key', 'announcement.key'], ['apps/web/src/features/tasks/TagDialogs.tsx']],
  ['apps/web/src/routes/ProjectPage.tsx', ['announcement.key'], ['apps/web/src/routes/ProjectPage.tsx', 'apps/web/src/features/tasks/TaskDrawer.tsx']],
  ['apps/web/src/routes/WeeklyPage.tsx', ['announcement.key'], ['apps/web/src/routes/WeeklyPage.tsx']],
]) {
  const keys = sources.flatMap(source => callTranslationKeys(readSource(source), 'message', 0));
  const rules = dynamicKeys.get(file) ?? new Map();
  for (const expression of expressions) rules.set(expression, { keys, reason: `Message descriptor keys are extracted from literal message(...) factories in: ${sources.join(', ')}.` });
  dynamicKeys.set(file, rules);
}

// The original-estimate union owns exactly three states; captured has a numeric
// state label, while badge/help copy exists for all three immutable states.
const originalStates = schemaPropertyDomain(readSource('packages/contracts/src/planning.ts'), 'originalPackageEstimateSchema', 'state');
dynamicKeys.set('apps/web/src/features/planning/OriginalEstimate.tsx', new Map([
  ['`original-estimate.state.${state}`', { keys: originalStates.filter(state => state !== 'captured').map(state => `original-estimate.state.${state}`), reason: 'Finite discriminated schema states; the captured branch renders minutes instead of calling this state label.' }],
  ['`original-estimate.badge.${state}`', { keys: originalStates.map(state => `original-estimate.badge.${state}`), reason: 'Every original-estimate state comes from the named validated response union.' }],
  ['`original-estimate.help.${state}`', { keys: originalStates.map(state => `original-estimate.help.${state}`), reason: 'Every original-estimate state comes from the named validated response union.' }],
]));

const presentationSource = readSource('apps/web/src/features/task-comments/presentation.ts');
const milestones = stringUnionDomain(presentationSource, 'Milestone');
const customAvailability = schemaPropertyDomain(readSource('packages/contracts/src/task-comments.ts'), 'customChangeSchema', 'availability');
const activityDomains = new Map([
  ['priorityKeys[priority]', tableTranslationKeys(presentationSource, 'priorityKeys')],
  ['workStates[state]', tableTranslationKeys(presentationSource, 'workStates')],
  ['empty', [parameterDefaultKey(presentationSource, 'minutesShown', 'empty'), ...callTranslationKeys(presentationSource, 'minutesShown', 1)]],
  ['absent', callTranslationKeys(presentationSource, 'customShown', 2)],
  ['`activity.milestone.${milestone}`', milestones.map(value => `activity.milestone.${value}`)],
  ['`activity.custom.${change.availability}`', customAvailability.filter(value => value !== 'history').map(value => `activity.custom.${value}`)],
]);
const fieldKeys = callTranslationKeys(presentationSource, 'field', 0, false, false, new Map([
  ['labelFields[change.field]', tableTranslationKeys(presentationSource, 'labelFields')],
  ['dependencyKeys[change.op][change.direction]', literalKeyLeaves(presentationSource, 'dependencyKeys')],
  ['workKeys[change.op]', tableTranslationKeys(presentationSource, 'workKeys')],
]));
const descriptors = [...descriptorPropertyKeys(presentationSource, activityDomains), ...fieldKeys];
const streamPath = 'apps/web/src/features/task-comments/TaskActivityStream.tsx';
const streamRules = new Map();
for (const expression of ['value.key', 'value.note', 'change.label.key', 'change.note.key']) streamRules.set(expression, {
  keys: descriptors, reason: 'Phrase/Shown producers are AST-extracted from presentation.ts property descriptors, finite field factories and explicit checked schema/union template domains; arbitrary new producers fail extraction.',
});
streamRules.set('headline(item)', { keys: functionResultKeys(presentationSource, 'headline', new Map([['kindKeys[item.kind]', tableTranslationKeys(presentationSource, 'kindKeys')], ['`activity.kind.${milestone}`', milestones.map(value => `activity.kind.${value}`)]])), reason: 'Headline uses the finite kindKeys dictionary (including its updated fallback) or the two checked Milestone union members.' });
streamRules.set('note', { keys: functionResultKeys(presentationSource, 'detailNote', new Map([['detailKeys[item.detail]', literalKeyLeaves(presentationSource, 'detailKeys')]])), reason: 'detailNote indexes the finite detailKeys table; null means no note and is handled before translation.' });
streamRules.set('problemKeys[problem]', { keys: tableTranslationKeys(readSource(streamPath), 'problemKeys'), reason: 'Finite local comment validation dictionary; no server prose or arbitrary key input.' });
dynamicKeys.set(streamPath, streamRules);

const bulkSource = readSource('apps/web/src/features/task-table/useBulkInlineEdit.ts');
const bulkRefusals = callTranslationKeys(bulkSource, 'refuse', 1);
const bulkMessages = callTranslationKeys(bulkSource, 'message', 0, false, false, new Map([['key', bulkRefusals]]));
for (const [file, expressions, keys] of [
  ['apps/web/src/features/task-table/useBulkInlineEdit.ts', ['key'], bulkRefusals],
  ['apps/web/src/features/task-table/BulkCustomFieldCell.tsx', ['bulk.notice.key'], bulkMessages],
  ['apps/web/src/features/tasks/InlineTaskEdit.tsx', ['bulkNotice.key'], bulkMessages],
  ['apps/web/src/routes/ProjectPage.tsx', ['bulkInline.completionNotice.key'], bulkMessages],
]) {
  const rules = dynamicKeys.get(file) ?? new Map();
  for (const expression of expressions) rules.set(expression, { keys, reason: 'Bulk notices originate only in useBulkInlineEdit message(...) calls; the one key parameter is derived from every literal refuse(capture,key) caller, with dynamic callers rejected.' });
  dynamicKeys.set(file, rules);
}
literalExemptions.set('apps/web/src/features/task-table/TaskTable.tsx:var(--task-title-width, clamp(280px, 42cqw, 460px))', 'Exact CSS custom-property expression used only by the task title column width; never displayed as copy.');

let checked = 0, calls = 0;
for (const file of [...files(web), ...files(join(root, 'packages/ui/src'))]) {
  if (!/\.[cm]?[jt]sx?$/.test(file) || /(?:\.test\.|\/test\/|\/i18n\/|Fixtures\.[cm]?[jt]sx?$)/.test(file)) continue;
  checked++;
  const source = readFileSync(file, 'utf8');
  const fileName = relative(root, file);
  const exemptions = new Map([...literalExemptions].filter(([key]) => key.startsWith(fileName + ':')).map(([key, reason]) => [key.slice(fileName.length + 1), reason]));
  const result = auditUiSource(source, fileName, { englishKeys: new Set(english.keys()), literalExemptions: exemptions, dynamicKeys: dynamicKeys.get(fileName) });
  calls += result.calls;
  for (const issue of result.diagnostics) violations.push(`${fileName}:${issue.line}:${issue.column} ${issue.kind}: ${JSON.stringify(issue.text)}`);
}
for (const [locale, namespaces] of Object.entries(catalogs)) {
  if (locale === 'en') continue;
  const count = Object.entries(namespaces).reduce((sum, [namespace, catalog]) => sum + [...catalogMessages(catalog, namespace)].length, 0);
  console.log(`${locale}: ${count}/${english.size} translated messages; missing messages use English.`);
}
console.log(`Localization audit: ${checked} source files, ${calls} translation calls, ${english.size} English messages, ${manager.availableLocales.length} locale(s).`);
if (violations.length) { console.error(violations.join('\n')); console.error(`${violations.length} localization violation(s).`); process.exitCode = 1; }
