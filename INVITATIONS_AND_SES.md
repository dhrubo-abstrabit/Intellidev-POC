# Invitations & SES — how it works today

How someone gets invited into the org, how the email goes out over Amazon SES,
and what happens while SES is still sandboxed. Reflects the code on
`feature/user-management` as of 2026-09-04.

## The short version

1. An admin fills in an email + role on the Invitations panel.
2. The app writes an `invitations` row (source of truth), then **tries** to
   email a tokenised accept link over SES.
3. Email delivery is best-effort. If SES isn't configured or rejects the send,
   the invitation still exists and the UI shows a **copy-able link** instead.
4. The recipient opens the link, signs in (or creates an account in one step),
   and `accept_invitation()` provisions their whole membership chain atomically.

The invitation row — not the email — is always the truth. Email is a
convenience layer that is allowed to fail.

---

## Data model

**Table: `public.invitations`** (`supabase/migrations/20260901000700_invitations.sql`)

Scope is expressed by *which id columns are set*, as a contiguous chain:

| Set columns | Meaning |
|---|---|
| `tenant_id` only | Billing/roster invite (e.g. billing admin) — grants a `tenant_members` row and nothing beneath |
| `+ workspace_id` | Workspace authority |
| `+ client_space_id` | Data access to one engagement |
| `+ project_id` | Narrowed to one project |

Role is expressed by the matching nullable role column (`tenant_role`,
`workspace_role`, `space_role`, `project_role`). More than one can be set, which
is why the shape is four nullable columns with CHECK constraints rather than
"exactly one of". CHECK constraints enforce: contiguous id chain, no role
deeper than its id, at least one role granted, and `expires_at > created_at`.

**The token is never stored in plaintext.** `token_hash` holds the SHA-256 of a
256-bit random token; the plaintext only ever lives in the emailed URL. A
database leak yields no usable invitations.

**One pending invite per (tenant, email, exact scope)** — unique partial index
`invitations_pending_uniq` with `nulls not distinct` (load-bearing, or two
pending tenant-level invites to the same address wouldn't collide). Distinct
scopes still coexist.

---

## Creating an invitation

`createInvitation()` in `src/lib/invitations/actions.ts` (a Server Action bound
to `(level, scopeId)` in the panel).

Invite scopes offered by the UI are **tenant, workspace, space** (`InviteScopeLevel`).
Project-scoped invites are deliberately *not* offered — a project invite needs a
space role too, so the simpler path is "invite to the space, then set a
per-project override on the roster."

Order of operations, and it's deliberate:

1. `requireUser()` + `requirePermission("member.invite", scope)` — readable failure.
2. Validate email/role with Zod.
3. `assignable_roles` RPC — **the DB decides** what this caller may grant
   (including the rank ceiling). Validating against this, not a hard-coded list,
   is what keeps a newly added role invitable with no code change and stops an
   invite being a way around the members-screen rank ceiling.
4. Resolve the full scope chain (tenant → workspace → space ids), because
   `tenant_id` is NOT NULL and the scope-chain CHECK requires every id above the
   deepest one.
5. **Insert the `invitations` row** (RLS policy `invitations_write_admin` is the
   third gate on the write itself).
6. **Then** send the email. A send failure only *downgrades the message* — it
   never rolls back the invitation.

> Why row-first, mail-second: an invitation that exists but wasn't delivered is
> recoverable from the pending list; a mail delivered for a row that was rolled
> back is not recoverable at all.

A **space invite also grants workspace `member`** (see the long comment at
`actions.ts:143`) — without it, accepting a space invite leaves the person on a
bare dashboard with no navigable path to the space, because every route is
`/w/:workspaceId/…` and `workspaces_select` needs `workspace.read`. `member` is
the lightest role that fixes it and grants no data access.

A **tenant invite grants only a `tenant_members` row** — no workspace/space/
project membership. That's exactly right for a billing admin and would look
broken for anyone else, which is why the UI labels it (the `note` prop on the
panel). See `supabase/migrations/20260904000100_tenant_invitations.sql`.

### Return contract

`createInvitation` always returns an `inviteUrl` regardless of whether mail went
out, plus `delivered: boolean` and a human `message`:

- delivered → "Invitation sent to …"
- `not_configured` → "Email is not configured yet — copy the link to share it."
- `send_failed` → "the email could not be sent. Copy the link to share it."

---

## Sending over SES

`sendInviteEmail()` in `src/lib/invitations/email.ts`, using
`@aws-sdk/client-sesv2` (`SESv2Client` + `SendEmailCommand`).

**It NEVER throws.** The row is already written by the time it runs, so it
returns a typed result instead:

```ts
type InviteMailResult =
  | { delivered: true }
  | { delivered: false; reason: "not_configured" }   // SES env vars absent
  | { delivered: false; reason: "send_failed"; error } // SES rejected it
```

The two non-delivery cases are distinguished on purpose:
- **`not_configured`** — expected during the sandbox wait; the reason the UI
  always shows a copy-able link.
- **`send_failed`** — SES rejected it. In the sandbox, an *unverified recipient*
  looks exactly like this, and it's the single most likely failure before
  production access is granted.

The email itself: multipart (plain text + HTML), subject
`"{invitedBy} invited you to {scopeName}"`, a branded HTML button plus the raw
URL on its own line (so it survives a mail client mangling the link). All
interpolated values are HTML-escaped.

**`ReplyToAddresses`** is set to the inviter's email. The From address is a
no-reply on a domain with no MX record, so a puzzled invitee hitting Reply would
otherwise bounce; pointing replies at the inviter reaches someone who knows what
the invite is.

**Logging:** on failure it logs the SES error message but **never the invite
URL** — the token is a credential and must not reach a log aggregator.

### SES configuration (env)

Defined in `src/lib/env.ts` as `sesSchema`, read via `sesEnv()`:

| Env var | Notes |
|---|---|
| `AWS_REGION` | |
| `AWS_ACCESS_KEY_ID` | |
| `AWS_SECRET_ACCESS_KEY` | Shown by AWS once; Vercel env vars are write-only after set — record it when generated |
| `SES_FROM_ADDRESS` | Must be a verified SES identity |

SES is **deliberately not part of `serverSchema`** — a deployment without SES
configured still boots and every other feature keeps working. `sesEnv()` returns
`null` (rather than throwing) when config is absent, because "not configured yet"
is an *expected* state here: SES starts sandboxed and needs an AWS support
request before it can mail arbitrary recipients.

The accept link is built from `appUrl()` (`NEXT_PUBLIC_APP_URL`, falling back to
`VERCEL_URL`): `${appUrl()}/invite/${token}`.

---

## The sandbox reality (why "copy link" exists everywhere)

While SES is in the sandbox it can only send to **verified** addresses, so most
real invitees' sends come back as `send_failed`. The whole invite flow was built
to be useful during that wait:

- Every freshly minted link is surfaced in the UI via the `FreshLink` component
  (`src/components/dashboard/invitations-panel.tsx`) — "copy it now, it cannot be
  shown again" — with a copy button. Pasting it into Slack is a legitimate way to
  invite someone.
- The link is only recoverable **at creation time**, because only the SHA-256
  hash is stored. That's why the pending list offers **Resend** (mints a new
  token and shows its link) rather than "copy link" for older rows.

To leave the sandbox: verify the sending domain/identity in SES and file the AWS
production-access request. No code change is needed — once the env vars are set
and SES is out of the sandbox, `delivered: true` starts coming back.

---

## Managing pending invitations

Panel: `src/components/dashboard/invitations-panel.tsx`. List comes from the
`pending_invitations(scope_level, scope_id)` RPC (SECURITY **INVOKER** — the
caller is a member, so the existing RLS select policy is the right gate; someone
without `member.invite` gets an empty list). `expired` is computed in Postgres,
not TypeScript, so it's judged against the same clock `accept_invitation()` uses.

- **Revoke** (`revokeInvitation`) — sets `revoked_at`. This is the *only* column
  a client may update on the table (grant is `update (revoked_at)` only). The
  link stops working immediately.
- **Resend** (`resendInvitation`) — **revoke-then-create**, not an update.
  `expires_at` isn't in the client's update grant and the pending-unique index
  forbids a second live row, so extending in place is impossible. Resend mints a
  fresh token (invalidating any link already in the wild) and leaves an honest
  record of how many times someone was chased.

---

## Accepting an invitation

Public landing page `src/app/invite/[token]/page.tsx` (deliberately **not** behind
`PROTECTED_PREFIXES` — recipients usually have no account yet).

- Renders from `invite_preview(token)` — a SECURITY DEFINER function keyed on the
  token hash. Necessary because the recipient is a member of nothing (every RLS
  policy correctly refuses them) and holds the plaintext while the table stores
  only the hash. It returns a `status` of `valid | expired | revoked | accepted`
  and enough display info ("Dan invited you to BeastSquad as a Space Admin").
  Returning a distinct status is safe (not an enumeration oracle) because tokens
  are 256-bit.
- **Signed in** → `AcceptInviteButton` → `acceptInvitation()` → `accept_invitation` RPC.
- **Not signed in** → `CreateAccountForm` → `acceptWithNewAccount()`: creates the
  account via the **admin API with `email_confirm: true`** (opening the mailed
  link already proved control of the mailbox, so no second confirmation email),
  signs them in, then accepts. Email comes from the *invitation*, never user
  input.

**`accept_invitation(token)`** (`20260901000700_invitations.sql`) is one atomic
SECURITY DEFINER function that:
- hashes the plaintext token internally and locks the row `for update`;
- re-checks not-found / revoked / accepted / expired (the single source of truth
  for "is this usable" — `invite_preview` mirrors the same four checks);
- provisions `tenant_members` → `workspace_members` → `space_members` →
  `project_members` in the one order the composite FKs permit, upgrading existing
  rows but never downgrading;
- stamps `accepted_at` / `accepted_by`.

**The accepting user's email need NOT match `invitations.email`** — the token *is*
the authorization (someone invited at work@… may sign in with a Google account
returning a different primary address). Consequence: a forwarded link works for
whoever opens it, so tokens are treated as secrets — single-use, expiring, never
logged. `email` is an addressing/audit field, not access control.

After acceptance, `redirectIntoGrantedScope()` queries through the user-scoped
client (so it reflects what was *really* granted) and lands them on the deepest
useful screen — a project if there is one, else the workspace shell.

---

## Lifecycle & expiry

- **TTL is 7 days** (`INVITE_TTL_DAYS` in `src/lib/invitations/tokens.ts`), set
  explicitly at the call site — `expires_at` is NOT NULL with no default, so
  changing the policy needs no migration.
- A sweep for unaccepted/expired invitations lives in
  `20260903000200_seats_and_invite_expiry.sql` (same migration as seat
  enforcement). Accepting also runs against `enforce_seat_cap()` — every route
  by which a person becomes billable passes through the seat chokepoint, and a
  full org throws "used all N of its seats" at accept time.

---

## Key files

| File | Role |
|---|---|
| `src/lib/invitations/actions.ts` | Create / revoke / resend Server Actions |
| `src/lib/invitations/email.ts` | SES send (never throws) |
| `src/lib/invitations/tokens.ts` | Token gen, SHA-256 hash, TTL |
| `src/lib/env.ts` | `sesEnv()`, `appUrl()` |
| `src/components/dashboard/invitations-panel.tsx` | Admin UI + `FreshLink` copy affordance |
| `src/app/invite/[token]/page.tsx` | Public accept landing page |
| `src/app/invite/[token]/actions.ts` | Accept / create-account-and-accept |
| `supabase/migrations/20260901000700_invitations.sql` | Table, RLS, `accept_invitation()` |
| `supabase/migrations/20260903000100_invitation_preview.sql` | `invite_preview()`, `pending_invitations()` |
| `supabase/migrations/20260904000100_tenant_invitations.sql` | Tenant-scope support in `pending_invitations()` |
| `supabase/migrations/20260903000200_seats_and_invite_expiry.sql` | Seat cap + expiry sweep |
