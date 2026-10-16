# Contextual project toolbar

Project views show controls that directly act on their presentation:

| View | Search / Filters | Group by | Sort | Personal Columns | Week / Person for table hours |
| --- | --- | --- | --- | --- | --- |
| Tasks table | Yes | Yes | Yes | Yes | Yes |
| Board | Yes | No | Yes | No | No |
| Timeline | Yes | No | No | No | No |
| Graph | No | No | No | No | No |
| CSV import | No | No | No | No | No |

This slice only changes visibility. Filters, sort, selected week/person, group/collapse state, Graph roots and personal column drafts keep their existing owners and meaning. The visibility change adds no clearing of those choices or implicit preference/task saves. Existing explicit Graph-root selection and import-locator behavior remain unchanged. Returning to Tasks restores its context. The Week navigation link retains the current week/person even while the table pickers are hidden. Native Filters disclosure behavior is unchanged.

## Recovery and error boundaries

The table hours hook and its dialogs remain mounted. Table renders `taskTime.controls`, which already includes its notices. Other views render `taskTime.notices` exactly once. Those notices retain period-list, period/projection, access and opening errors, plus held personal-plan, actual-hours and recategorization commands. **Open original hours save** still resumes the original period/person/session and an explicit retry retains the original body, revisions and idempotency key. Hiding pickers does not invent a current default for a held command.

PersonalColumnsDialog remains mounted under its existing metadata/current-access gate. Only its ordinary Columns trigger is Table-specific. A closed pending/unconfirmed save retains **Resume column save** on every non-Table view, with the original controller/session and an exact retry. Current denial still replaces cached choices with the existing unavailable-state UI; hidden triggers do not weaken authorization.

The temporary Resume button disappears while its dialog is open and after confirmation. The existing shared DialogReturnFocus provider therefore gives non-Table column dialogs an explicit return target: the visible active view button. Table dialogs keep their existing Columns-opener behavior. This changes no shared dialog implementation and preserves nested-dialog focus handling.

All existing custom-field definition, shared-column and field-value error boundaries remain visible as before, including on views that hide the controls. Queries and authority gates are unchanged. Global task/comment/dependency/schedule/meeting/field recovery and their mounted controllers remain in place. An empty control row has no visual box; held column notices still produce a visible row. No cached information is moved outside its existing authorization gate to achieve the density change.

## Verification

The settled actual-page toolbar matrix was RED on Timeline, Graph and Import because table hours pickers were still present (three failed, two passed before the change). The completed source gate passed 75 tests across seven suites in 46.42 seconds, including 21 new actual-page toolbar cases. Coverage includes the five-view matrix, retained week/person/search/filter/group/sort and personal-column draft, four-view original column/hour retry, keyboard focus after column confirmation, current column denial hiding cached choices, all existing field error boundaries on Graph, and weekly-read errors on Timeline/Graph/Import. Adjacent sorting, grouping, Board time context, personal columns and hours/navigation suites also passed. Source web type checking, scoped ESLint, localization audit and whitespace/link checks passed.

Compiled desktop/mobile geometry, real server writes and retained browser-tab acceptance remain separate parent-controlled gates. Source tests use fake APIs and perform no application runtime/database writes. No backend, API schema, Graph geometry, native Filters behavior or global stylesheet belongs to this slice.

Related contracts: [project sorting](58-project-task-sorting.md), [personal columns](32-personal-table-columns.md), [retained hours](48-retained-hours-drafts.md), [retained custom fields](49-retained-field-drafts.md), [completion focus](52-completion-focus-recovery.md).
