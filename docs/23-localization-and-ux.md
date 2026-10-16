# English UI and localization

This slice makes English the default interface language and moves application labels, accessibility text, helper copy, validation messages and safe error descriptions into JSON resources. Stored task titles, project names, status names, custom-field names/options, member names and imported source values remain user content and are displayed verbatim.

The shared shell uses compact navigation and a small local-demo indicator. The actor control retains the current user's role and the existing guarded switch flow. Synthetic-data details are available in expandable help. Task, weekly, import, graph and timeline behavior is implemented in their existing feature modules; this document does not change their authorization, planning or retry contracts.

## Resource layout and runtime

Resources live under `apps/web/src/i18n/locales/<locale>/<namespace>.json`. English namespaces are divided by feature; common shell, route, workspace and safe-error messages are separate. The production registry uses Vite's eager `import.meta.glob('./locales/*/*.json')`, so adding a language does not require adding imports or changing a central language list.

`LocalizationManager` is a small observable manager using standard `Intl` cardinal plural rules, number formatting and date formatting. It deliberately supports plain text and named interpolation instead of executing HTML or a template language. React escapes interpolated user content. It does not translate persisted values, machine enums, command codes or API payloads.

Components use the locale-bound hook:

```tsx
const { t, formatDate, formatNumber, locale } = useTranslation();
return <button aria-label={t('common.save')}>{t('common.save')}</button>;
```

Translation, date and number functions returned by the hook change identity when the locale changes. A memo that formats labels must depend on its hook function or `locale`. Pure non-React helpers may import the live global `t`, `formatDate` and `formatNumber`; their React callers still need a language subscription. Module-level translated strings are forbidden. Store keys in lookup tables, use getters, or translate inside functions.

A key is namespace-qualified, for example `common.membersCount`. TypeScript checks the key shape and interpolation value types; the static audit checks literal key existence and explicitly audited finite dynamic tables. It does not claim a generated exhaustive TypeScript union of every catalog key.

```json
{
  "greeting": "Hello, {{name}}",
  "membersCount": {
    "one": "{{count}} member",
    "other": "{{count}} members"
  }
}
```

Call the plural message with a finite numeric `count`. Other cardinal forms (`zero`, `two`, `few`, `many`) may be supplied for languages that need them. Every plural message requires `other`. Translations preserve the English message shape and interpolation parameter set; the constructor rejects drift with an exact resource/key diagnostic.

The manager uses the locale owning the selected message for plural selection. A missing German message that falls back to English therefore uses English plural rules. Numeric interpolation and explicit number formatting use the selected display locale. Date-only `YYYY-MM-DD` values are formatted in UTC regardless of an optional display time zone, so a calendar day does not shift. Instants honor an explicitly supplied time zone. Machine date extraction in planning remains separate from display formatting.

## Add a language

1. Copy the desired namespace JSON files from `locales/en/` to a directory with a valid language tag, such as `locales/de/` or `locales/fr-CA/`.
2. Translate values, retain keys and `{{parameter}}` names, and use appropriate cardinal plural forms. Add no HTML. English remains the source catalog.
3. Run `node scripts/check-localization.mjs` with the repository's required Node 24 runtime. It validates catalogs and reports translated-key coverage. A partial locale is supported; omitted messages use English.
4. Run the focused localization tests and the web typecheck. For a release, use the normal web build and reload the application so newly discovered JSON files enter the bundle. An already running old bundle cannot discover files created after it was built.
5. With two or more discovered locales, the topbar automatically displays a language selector using `Intl.DisplayNames`. A single English locale has no redundant selector. Select the new language and verify representative routes, dialogs, validation, charts and keyboard labels.

English is used on first load, including the initial HTML `lang` attribute. The browser's preferred language does not override that explicit default. A supported selection is stored locally as `workloom.locale`; regional preferences may resolve to an available base language. Unsupported or malformed selections resolve to English. Browser storage is optional. Changes update `document.documentElement.lang`, subscribed UI and document titles without clearing application drafts or query caches.

There is no translation-administration screen or remote translation service in this slice.

## Missing and invalid messages

A missing translated key uses its English message. A key missing from English produces the visible marker `⟦namespace.key⟧` and a diagnostic. A missing interpolation parameter remains visible as `{{parameter}}` and emits a diagnostic; an invalid plural count produces `⟦namespace.key:count⟧`. Diagnostics are deduplicated per selected locale and contain key/parameter names, never interpolated user values. They are not silently swallowed.

Invalid catalogs fail with the resource and key in the error. Validation covers non-object/array/null groups, empty messages, malformed interpolation, plural shape, unsupported message shapes relative to English and parameter drift. The audit additionally rejects duplicate raw JSON properties, while the manager rejects colliding flattened keys. All source messages must be present in English; translators may omit keys to use fallback but may not invent unmatched keys.

## Errors, validation and persisted templates

API errors continue through fixed `describeError` copy by validated kind/code and subject. Denied and absent workspaces, projects and tasks remain indistinguishable. Unknown write outcomes retain their original submitted data and operation key; localized copy does not change resend behavior. Native browser unload prompts remain browser-controlled.

Form validation uses local catalog messages or a safe schema-path mapping. Import-preview issues use a complete public issue-code dictionary and a localized unknown-code fallback, rather than server `issue.message`. File-read failures expose only vetted local validation copy; unknown native exceptions use a fixed generic message. Server/native error messages must not be rendered as a fallback.

New projects receive the persisted English template statuses **To do**, **In progress**, **Done** and **Cancelled**. This template is domain data in `packages/domain/src/tasks/service.ts`, not a heuristic UI translation. Existing projects/statuses and exact saved idempotency outcomes are unchanged. No request schema, parsed default or payload hash was added. Changing the interface language does not rename any status.

## Verification and audit limits

Run the source audit with `npm run check:localization` (or `node scripts/check-localization.mjs`). The existing `npm run lint` and therefore `npm run check` gates include it once. Auditor regressions run in the normal web Vitest suite; the focused command is `npm run test --workspace @workloom/web -- src/i18n/audit.test.ts`. It scans application TypeScript and `packages/ui`, excluding tests and verified synthetic fixtures. It checks English and Russian JSX text, UI attributes, error/announcement literals, prose/template fragments, one-word label dictionaries, module-scope translation snapshots and missing English keys. Unknown dynamic `t(...)` expressions fail. Supported dynamic paths extract their actual finite keys from named tables or async-route callers; each path has an explicit reason. Exact developer-only diagnostic exemptions document why fixed localized copy is shown instead. CSS and machine comparisons are parsed separately.

The audit is a guardrail, not a proof of every possible runtime string: it cannot infer arbitrary data flow, translations introduced by dependencies, or user-authored values. Any new dynamic key source needs a finite checked table and a reviewed audit rule. Browser verification remains necessary for layout, focus, accessibility names, long translations and preserving drafts through a real language switch.

Focused automated evidence in this slice:

- `apps/web/src/i18n/LocalizationManager.test.tsx`: second-locale JSON discovery, English fallback, locale resolution, plural/interpolation behavior, zero/false values, untrusted text escaping, invalid/missing messages, date-only stability, memoized React updates, document language/title and optional storage.
- `apps/web/src/i18n/visible-state.test.tsx`: an already-visible validation/announcement switches language while preserving input, focus, persisted user names and write count.
- `apps/web/src/i18n/audit.test.ts`: deliberate English/Russian hardcoded fixtures, UI attributes, one-word label dictionaries, invalid/dynamic keys, translated snapshots, finite table extraction, duplicate JSON and exact exemptions.
- Existing shell, async-route, navigation-guard, project-page and pending-form regressions retain their behavioral assertions with English selectors; persisted Russian fixture names intentionally remain unchanged.
- `packages/domain/src/tasks/service.test.ts`: new English defaults and exact project-receipt replay with unchanged legacy/custom status rows and audit count.

New-cycle browser, authenticated-flow and old-tab upgrade evidence belongs in the [UX verification record](25-ux-verification.md). The [implementation journal](11-implementation-progress.md) preserves historical evidence. Unit/static checks do not certify those workflows. Existing capability limits remain in the [local pilot handoff](21-local-pilot-handoff.md), [client design](05-client-and-ux.md), and milestone contracts.

Web Vitest disables its persistent transformed-module cache (`fsModuleCache: false`). A normal cached test run reproduced an outdated `import.meta.glob` catalog inventory after adding a namespace; the same run without that cache passed. This affects test transformation only. The production catalog-discovery test compares every discovered English namespace/message with the actual application manager, without fixture fallbacks. Vitest documents [folder-dependent transform cache limitations](https://main.vitest.dev/config/fsmodulecache#known-issues).
