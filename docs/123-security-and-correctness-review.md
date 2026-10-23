# Workloom security and correctness review

23 October 2026. Reviewed scope: `d3c7586..526da45`, 283 changed files, 9,102 additions / 366 deletions. Target: `/Volumes/PavelData/ai/workloom`. Review covered changed API/MCP and token security, domain authorization/invariants, onboarding workflows, browser mutation handling and Asana imports; a pre-existing invitation vulnerability found along the way is included. The final review change set contains **48 files**, including three repository documents and two public documentation strings; no environment files, tracked dist artifacts or migration SQL changed. This is a bounded engineering/security review, not a claim that every product path is proven secure.

## Confirmed fixes

| Severity | Problem and impact | Correction |
| --- | --- | --- |
| P1 | Copy/continuation keys were bound only to individual steps, allowing changed overall inputs or unstable final replay. | Persist complete-input claim and exact final receipt under current authorization; ordinary steps retain separate transactions and their planning-freeze behavior. |
| P1 | Unused generic invitation issued before membership revocation could reactivate that revoked member. | Restoration requires an invitation created strictly after revocation, plus current issuer role authority. Equal/missing revocation evidence fails closed. Personalized links already rejected this scenario; their protections remain. |
| P1 | Comma-delimited Asana dependency parsing could explore exponentially many partitions and block the hosted API event loop. | Bounded dynamic programming retains exact-name precedence, ambiguity rejection and unique dependency semantics. |
| P2 | Rotating valid-looking token strings and evicting live limiter buckets could bypass public API throttling; MCP batches paid only one request unit. | Address and token ceilings apply together; live counters are retained with bounded overflow; batches are charged per message. Limits remain per process. |
| P2 | No-op public PATCH did not bind its operation key; changed payload could reuse it. | Persist complete-input claim/final response without nesting the domain write transaction; retain legacy-key conflict checks and historical compatibility limits. |
| P2 | Continuation retry after its own carried-field commit and later link failure produced a changed step payload. | Recognize the already-carried value semantically, including multi-select ordering; retry completes without duplicate writes or a self-induced key conflict. |
| P2 | More than 200 newer inactive tokens could hide an older active token from management, preventing UI revocation. | List active tokens first (active cap 50), then newest history; isolated HTTP/PG regression covers visibility and successful revocation. |
| P1 | Empty explicit PAT workspace list meant unrestricted workspaces. | Reject empty explicit lists; omitted list retains documented all-authorized-workspaces semantics. |
| P2 | Malformed public cursors could reach PostgreSQL with invalid UUID/date values. | Shared ID/calendar validation and canonical ISO timestamp checks before query construction. |
| P2 | Mention suggestions installed a dummy membership query fetcher that could replace real cached member data with an empty list on refetch. | Observe the existing actor/workspace-scoped cache without replacing its fetcher or options. |
| P2 | Bulk continuation could continue with uncertain outcomes or retry with new keys. | Retain exact pending command and stop further processing until its result is resolved. |
| P2 | Hours-load reports treated missing facts/capacity as zero and represented a configured subset as the whole team. | Distinguish unknown capacity, missing fact and explicit zero; use authoritative whole-team bucket totals. |
| P2 | Token secret remained in mutation cache or could appear after actor/workspace changed. | One-time secret stays in mounted, scope-keyed local component state; mutation cache receives no token result. |
| P2 | Absence-import uncertain responses could be retried as new work or abandoned while still pending. | Shared idempotent mutation handling, exact-command retry, single-flight handling and visible unresolved-result state. |
| P2 | Valid multi-megabyte Asana uploads caused regex stack overflow below the advertised 10 MiB limit. | Length checks plus exact Base64 decode/encode canonical validation; exact bytes preserved. |
| P2 | Initial Asana source discovery recursed before task/depth bounds and shape validation. | Validate source size/shape, 2,000-task and 20-depth limits, and decimal source identities before downstream discovery. No filesystem traversal exploit was confirmed: later parser already validated project identity before journal writes. |
| P2 | Same-name Asana fields silently discarded a distinct populated value. | Conflicting populated duplicates require explicit mapping; empty/equal duplicates remain accepted; zero is distinct from absence. |
| P1 | Task update/archive could mutate archived projects; direct section edits or detachment could violate parent/shared-accounting invariants. | Require open projects; validate direct child-section edits and the new parent section during reparenting; reject detail-task detachment that leaves shared accounting behind. Legitimate reparenting keeps its existing package. No repair/cascade of all legacy descendant sections is claimed. |
| P2 | Restore could resurrect descendants beneath an independently archived parent. | Traverse only matching deletion lineage when restoring. |
| P2 | Project defaults accepted invalid member/tag/date/from-above field references. | Validate active workspace membership, current tags and editable compatible project fields. |
| P2 | Task continuation could silently drop explicitly requested field carry-over. | Resolve explicit carries before closing source; incompatible/unavailable carries reject; explicit write failures surface. |

P3 privacy fix: remove claim-derived avatar URL metadata from Auth logs. Additional hardening: mark MCP responses no-store. Neither change grants extra access.

## Workflow reliability and compatibility

Project duplication and task continuation compose multiple existing domain commands, each committing separately. Current fix introduces a durable resumable workflow wrapper for complete-input binding and exact final-result replay. **Remaining limitation:** partial results can remain after an intermediate failure; these workflows are not atomic. Input claims and final receipts do not snapshot every mutable source used across unfinished steps. A mid-workflow source edit can still require reconciliation before an exact retry completes. No claim of all-or-nothing behavior or general retry recovery under arbitrary concurrent edits is made.

The self-induced continuation retry failure is fixed in the independently reviewed final candidate: a carried field committed before a later dependency failure no longer creates a conflicting expected revision on retry. Targeted regression covers duration and reordered multi-select values, including a failing-before-fix proof. This is distinct from arbitrary external source edits between attempts.

Public PATCH now has a separately reviewed safe complete-input claim/final-receipt path, including already-satisfied requests. Domain mutations remain top-level, preserving planning-freeze commits on rejection. Targeted tests cover no-op key binding, exact replay, changed-input rejection, concurrency and legacy raw-key conflicts (409 with no write). Historical no-op calls that stored no receipt cannot be reconstructed retroactively. A P1-risk nested wrapper introduced during this review was rejected and reverted before this safe replacement; it was not part of the original reviewed user changes.

Rejected oversized MCP arrays cost one outer HTTP request; only accepted arrays of 2–10 messages receive additional per-message charges. The final reviewed sources have been promoted to the main checkout and received independent **scoped GO** for safe PATCH, continuation retry and MCP; coherent final gates passed as recorded below.

Existing PAT scope compatibility: rejecting `workspaceIds: []` protects new issuance requests. Tokens already stored with `workspaceIds = null` retain their existing meaning: all workspaces currently authorized for that user. Stored data cannot distinguish an originally omitted list from a historical empty-list request. No live tokens were rewritten, no inferred restriction was invented, and no main-database token audit was performed.

## Verification evidence

Final private gates passed on the coherent reviewed sources:

| Gate | Result |
| --- | --- |
| Repository check and build | PASS; final public-documentation API/web targeted builds also PASS |
| Backend/unit suite | 2,464 tests / 160 files PASS |
| Changed web scope | 351 tests / 55 files PASS; deduplicated original changed files plus current changed/new tests |
| Isolated PostgreSQL | 67 tests / 10 files PASS |
| Asana operator scripts | 20 tests / 4 files PASS |

PostgreSQL cohorts are backend review 8/1, existing copy/continuation/defaults/archive 17/4, public API 17/1, inbox 3/1, project rules 4/1, assignee bulk 12/1, safe PATCH idempotency 6/1. Focused team admission 27/2 is included in unit coverage, not an additional total. The scripts cover adversarial dependency labels, deep/malformed JSON, large valid uploads, conflicting duplicate values and exact-byte/journal preservation. PATCH/continuation regressions cover no-write key conflicts, concurrent retries, planning-freeze behavior and carry-then-link-failure resume.

Evidence root: `/private/tmp/workloom-review-ce76a965-2b81-402e-8c44-ddcc1161d87d`. Final counts/log names are in `final-test-summary.json`; source/artifact bindings are in `final-binding-proof.json`, `final-source-manifest.json` and `final-candidate-artifacts.json`. The binding proves **1,756 runnable source/config/test files match main and private stage**, **1,398 private artifacts**, and **nine private ESM bindings**. Source digest: `5184f8ae7a5c3a0328e978c44b9b5e7c00c49a10ecf72909d9ba4a45252c8197`. Artifact digest: `1dc5041b473e2a7cf904832490c3e7e1fd5abbb3aee555955a1d7138638070cc`. Binding-receipt SHA-256: `142295f25bfe19d25461222888ccef6e6d35dafc082c5a72be7d186b0a5cd6b9`.

Earlier failed receipts remain retained: synthetic fixture misuse, stale DTO fixtures, overly broad reparent guard, MCP SDK cache-header overwrite, and a migration-test expectation missing already-existing immutable migration 0032. Corrections were checked; no migration SQL was edited and failed runs are not relabelled as passing.

Production-only and full npm audits both reported **0 known vulnerabilities**, inventory 619 total / 199 production dependencies. Receipts: `/private/tmp/workloom-review-dependency-audit.json` and `/private/tmp/workloom-review-all-dependency-audit.json`. A narrow literal-credential-pattern scan found no matching changed-file paths; this is not proof that every possible secret format is absent. Documentation links and scoped diff checks pass. Advisory scans do not prove application security.

## Operational boundaries

No deliberate runtime activation, main database data/schema writes, pushes or production deployment occurred. **Operational incident:** the domain agent accidentally ran `build:libs` in the main checkout at 14:41:39 UTC; it exited 2 and modified compiled library artifacts. No database/source writes or process restart resulted. At 14:46:51 UTC root restored 26 changed files and removed four newly emitted files from a fresh private build of original HEAD `526da45`, verifying 1,008 hashes. There was no pre-review main-artifact byte backup, so this establishes original-source equivalence, **not exact pre-review byte preservation**. Receipt: `/private/tmp/workloom-baseline-526-a514faad-7089-4a3c-8e31-9c1bc4a8f4fd/restoration-receipt.json`. Temporary synthetic test files are separate from real product data. Main authenticated browser journeys, real Auth-provider login, old-tab upgrade behavior and production behavior require their own evidence. This acceptance covers reviewed sources and private verification only; the running local application was not upgraded to this candidate.
