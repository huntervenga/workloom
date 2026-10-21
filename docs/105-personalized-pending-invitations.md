# Personal invitations and pending teammates

Product `342d91f` is active locally at [Workloom](http://127.0.0.1:4310/app) after the isolated checks and controlled activation below. It replaces `58cd331`. No main invitations or tasks were seeded. Real-provider registration, main authenticated UI, actual old-tab upgrade and production are **NOT CHECKED**.

## Prepare the board before people register

Open **Members → Team access**. Enter the teammate’s **First name**, optional **Last name**, and **Work email**; choose their role and link lifetime, then **Create invitation**. The person appears as **Not joined yet** and can already receive tasks and shared-activity assignments. This creates a planning identity, not an Auth account or a password. It does not send an email.

Use **Copy invitation link** and send it privately when ready. The raw link exists only in the current tab. After a reload, use **Create replacement link** for that person. It preserves their membership and assigned work while revoking earlier unaccepted personal links. To change a pending person’s invited role, create a new invitation using the same email and the new role.

## Join with the invited account

The recipient opens the link and chooses **Sign in and join**. The invitation is carried across sign-in in a short-lived encrypted HttpOnly cookie; it is not sent to Auth or placed in the Auth return URL. After sign-in, Workloom completes the join without reopening the original link. An already signed-in recipient chooses **Accept invitation**.

A personal invitation requires the exact invited email, confirmed by the trusted Auth provider. Matching names alone do not grant access. Currently authoritative Gmail and Google Workspace assertions are accepted; older tokens or other unconfirmed email assertions may require a fresh login or an Auth verification capability that is not yet available. A different account receives an explanation and can sign in with another account. Tasks stay attached to the same membership when the invited account joins.

## Access and limits

Owners can invite Admin, Member, or Viewer; admins can invite Member or Viewer. Pending people cannot sign in or act as workspace administrators. Expired/revoked invitations and invitations whose issuer lost permission cannot grant access. Revoking a pending invitation does not delete its assigned tasks; use **Remove access** to remove the pending person from active assignment choices.

If the registering account already has another membership in this workspace, Workloom refuses an automatic merge rather than rewriting existing task/history identities. Resolve the duplicate with the owner before claiming the pending person.

**Create a general invitation link instead** retains the earlier non-addressed invitation option. Anyone holding that link may accept after sign-in; it does not pre-create a planning person. No email delivery, automatic membership based only on email, or bulk import is introduced by this feature.

## Verification

The isolated candidate matched 1,664 source/stage files. Global checks and the full build passed. Backend unit tests passed **2,333 / 143 files**; the final targeted fixture run passed **23 / 2**. PostgreSQL passed **35 / 8**, followed by the strengthened personal-invitation and populated-upgrade run **10 / 2**; these overlapping scopes are not additive totals. Focused web tests passed **78 / 7**. Private compiled native tests passed **4 / 4 in 8.3 seconds**, without skips or retries. The independent review reported no blocking findings.

Native coverage uses a fake signed Auth provider and a disposable PostgreSQL database: pending-person creation and assignment, matching-email join preserving membership, replacement-link invalidation, wrong-account refusal, and legacy-link continuation with an exact retry after a lost response. Root personally inspected only the sanitized pending-members screenshot. These results do not establish real-provider or production acceptance. Main local activation is recorded separately below.

## Controlled local activation

Activation **PASS at 2026-10-21T14:22:07.684Z** for product `342d91f`. Only additive migration **0027** was applied: one empty table and two nullable invitation columns; total tables **105 → 106**, migration ledger **27 → 28**. Every old table, old column, row and catalog definition was preserved, along with environment, PostgreSQL and Vite. Only the API restarted; the worker remained OFF and the runtime doctor passed. All **512 non-HTML resource bodies** matched their expected SHA and MIME, and both HTML entrypoints were verified.

The activation receipt is kept privately in `.local/backups/personal-invites-01fb3fab-8432-470f-a9be-510e6fdfca04/activation-result.json`. This is local runtime/data-preservation evidence, separate from the private fake-Auth browser tests. It does not certify a real provider login, main authenticated user workflow, actual old-tab upgrade or production deployment. No main invitations or tasks were seeded.
