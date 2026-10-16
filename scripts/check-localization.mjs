// Checks JSON resources and TypeScript UI syntax, including English literals. Run after UI edits.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
const readSource = path => readFileSync(join(root, path), 'utf8');
const dynamicKeys = new Map([
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
dynamicKeys.set('apps/web/src/features/tasks/QuickTaskAdd.tsx', new Map([['issue.key', { keys: taskIssueKeys, reason: 'Quick add renders the same checked TaskDraftIssue descriptors as the task drawer.' }]]));

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
