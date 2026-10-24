# Public landing localization

The public site is available in English, Russian, Japanese, Korean, neutral international/Latin American Spanish, and Brazilian Portuguese. This does **not** translate the workspace application: its only discovered app locale remains English.

## Routes and catalogs

- English: `/` and `/start`.
- Other languages: `/{ru,ja,ko,es,pt-br}` and `/start/{ru,ja,ko,es,pt-br}`; optional trailing slashes are served without changing language.
- English source: `apps/web/src/i18n/locales/en/landing.json`.
- Landing-only translations: `apps/web/src/landing/locales/*.json`. Do not put these partial catalogs under `src/i18n/locales/`: that would advertise partially translated workspace locales.
- Locale descriptors and build-time imports: `apps/web/build/landing-locales.ts`.
- All pages are prerendered HTML with localized metadata, reciprocal hreflang, canonical URL, native language names and flags. Spanish HTML uses `es-419`, Portuguese `pt-BR`. No browser-country or browser-language inference is used.
- Language switching stays on the same kind of page (landing/start). Signup CTAs preserve the landing language until `/start`; both account choices keep the existing Auth endpoint and `/app` return path unchanged.
- The production static server explicitly allows only supported localized routes. Raw nested `index.html` aliases remain forbidden/not found. `/app`, `/api`, docs and legacy navigation semantics are unchanged.

The footer links to the corresponding main-site locale and the public `huntervenga/workloom` GitHub repository. No open-source license claim is made: a public repository alone does not establish a license.

## Current production release path

On 24 October 2026, read-only Railway inspection confirmed that `pi-workloom / production / @workloom/api` is connected to GitHub `huntervenga/workloom`, branch `main`, and serves `workloom.pavelignatov.com`. This supersedes the old manual-only assumption in document 124. Publish a frozen reviewed commit via push, then verify its exact Railway deployment SHA and public behavior; do not trigger a duplicate CLI upload in parallel. Do not change service variables, database, domains or Auth configuration as part of this landing release.

The prior production deployment `1f770799-3217-480f-84f5-c79aa5be6934` (source `fecf23b385d010fddff484bf9404c7827870c780`) has 88 literal JS/CSS/font dependencies retained under `apps/web/public/assets/`. `apps/web/public/retained-assets.json` records original paths, MIME, byte counts and SHA-256. They are copied into the new Vite output, preserving old immutable paths without retaining old HTML, auth responses or server code. The snapshot is bounded, collision-checked against the candidate, and does not claim complete authenticated warm-tab compatibility. Do not silently prune these resources on later releases.

## Translation and verification

The English catalog was frozen, translated with authenticated Claude CLI (`--model opus --effort medium`), and independently reviewed with Codex CLI at medium effort. A separate Claude Opus final review checked the same catalogs. Requested corrections received scoped re-review; review manifests bind source/target SHA-256 hashes and scope. Portfolio card copy was reviewed in the same packets and copied as independent public config into the personal-site repository; there are no runtime sibling-repository imports.

Use Node 24.19.x. Focused checks, from the repository root unless stated otherwise:

```sh
node node_modules/vitest/vitest.mjs run --project unit apps/api/src/http/static-web.test.ts
node node_modules/typescript/bin/tsc --noEmit -p apps/api/tsconfig.json
node scripts/check-localization.mjs
node scripts/check-boundaries.mjs
```

From `apps/web/`:

```sh
node ../../node_modules/vitest/vitest.mjs run build/landing.test.ts
node ../../node_modules/typescript/bin/tsc --noEmit
node ../../node_modules/vite/bin/vite.js build --outDir /private/tmp/workloom-localization-web-build
```

Never build into a live local service's `dist`, restart the user's services, or access/migrate their database for landing verification. Run public-only preview on a separate port. Browser checks must cover all six locales, both public page types, mobile/desktop, menu keyboard dismissal, theme labels, lazy images, footer/CTA destinations and horizontal overflow. Authenticated workflows and old-tab upgrades are not certified by these public-page checks.

Deploy Workloom's localized routes before publishing portfolio links to those routes. Both production releases require explicit owner authorization and their own runbooks/health baselines. This change adds no analytics, external fonts, tracking or advertising services. Existing workspace chunk-size/circular-reexport build warnings are outside this landing-only change and do not certify workspace behavior.
