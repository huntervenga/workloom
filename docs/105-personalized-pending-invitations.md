# Personal invitations and pending teammates

Implementation candidate; verification and activation are recorded separately. This guide does not claim a completed real-provider registration or production deployment.

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
