# Localized custom-field value display

Read-only custom-field dates and numbers use the selected display locale. English JSON catalogs remain the source of UI copy; this slice adds no production locale, catalog registry entry or translated user content. Locale discovery and adding another JSON language remain as described in [the localization contract](23-localization-and-ux.md).

## Calendar dates

`FieldValueDisplay` passes the original date-only string to the locale-bound `formatDate` returned by `useTranslation`, with a numeric year and two-digit month/day. A mounted value changes from `01/01/2026` in English to `01.01.2026` in German. The original `<time datetime="2026-01-01">` value is retained. The manager formats date-only strings in UTC, so changing the viewer's time zone cannot move the calendar day. Invalid stored calendars are rejected with the existing shared `calendarDateSchema` and shown as the localized unavailable-value label, without throwing or rolling into another date.

## Exact decimal digits

`formatFieldNumber` retains the existing exact plain-decimal expansion and grouped whole-number formatting. Each fractional digit is formatted with the selected locale's numeral system, keeping every leading zero and stored decimal digit. No fraction is parsed as a number or passed to a formatter that could round it. Arabic-Egypt display therefore renders `1234.56` as `١٬٢٣٤٫٥٦`, including Arabic fractional digits. The existing Unicode minus sign and normalization of negative zero remain unchanged.

Editable number/date drafts, raw parser rules and stored values are unchanged. Locale switches retain raw input, focus and ISO dates without triggering a field change callback. In-memory draft protection continues to follow [the retained-field contract](49-retained-field-drafts.md); this display change does not submit or normalize input.

## Source evidence and limits

The focused regression first failed on the fixed German-style English calendar display and the mixed-script Arabic value `١٬٢٣٤٫56`. After the fixes, the field-display localization, field input/display and value-draft suites pass: 16 tests across three suites. They cover a live English → German → English switch on the same mounted date, unchanged ISO date attributes, retained focused raw input and exact parse outcomes, year/leap-day boundaries, non-throwing malformed-date fallback, Arabic positive/negative/zero values, long decimal fractions and `Number.MIN_VALUE`. Test locales use an isolated real `LocalizationManager`; Arabic uses `ar-EG` explicitly because this Node runtime resolves bare `ar` to Latin digits.

The three new display tests also pass independently with `TZ=America/Los_Angeles` and `TZ=Pacific/Kiritimati`. Web `tsc --noEmit`, scoped ESLint and the existing localization audit pass. Relative documentation links were checked locally.

This is source verification. Compiled browser, authenticated workflows, visual/mobile and retained-old-tab acceptance remain separate coordinator gates. No normal build, compiled asset change, runtime restart, backend/API/database change or commit was performed by this slice. The actual shared browser/runtime evidence remains in [the UX verification record](25-ux-verification.md).
