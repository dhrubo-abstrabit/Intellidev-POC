import Link from "next/link";
import { getUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Button } from "@/components/ui/button";
import { AcceptInviteButton } from "./accept-invite-button";
import { CreateAccountForm } from "./create-account-form";

/**
 * The invitation landing page. PUBLIC by design.
 *
 * `/invite` is deliberately absent from proxy.ts's PROTECTED_PREFIXES: most
 * recipients have no account yet, so bouncing them to /login before they can
 * even see what they were invited to is the wrong order. They see the
 * invitation first, then sign in or sign up, then accept.
 *
 * Everything rendered here comes from `invite_preview()`, a SECURITY DEFINER
 * function keyed on the token hash — necessary because the recipient is a
 * member of nothing, so every RLS policy on `invitations` correctly refuses
 * them, and because they hold the plaintext token while the table stores only
 * its SHA-256.
 */
export default async function InvitePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  const supabase = await createClient();
  const { data } = await supabase.rpc("invite_preview", { p_token: token });
  const invite = data?.[0];
  const user = await getUser();

  if (!invite) {
    return (
      <Shell title="This invitation link isn't valid">
        <p className="text-sm text-muted-foreground">
          The link may have been mistyped or truncated by an email client. Ask whoever invited you to send a new one.
        </p>
      </Shell>
    );
  }

  if (invite.status !== "valid") {
    const reason =
      invite.status === "expired"
        ? "This invitation has expired. Invitations last 7 days."
        : invite.status === "revoked"
          ? "This invitation was revoked."
          : "This invitation has already been used.";
    return (
      <Shell title="This invitation can't be used">
        <p className="text-sm text-muted-foreground">{reason}</p>
        <p className="text-sm text-muted-foreground">
          Ask {invite.invited_by ?? "whoever invited you"} to send a new one.
        </p>
        {user ? (
          <Button render={<Link href="/" />} className="mt-2">
            Go to your dashboard
          </Button>
        ) : null}
      </Shell>
    );
  }

  // The deepest named scope is what the invitation is really about.
  const scopeName = invite.space_name ?? invite.workspace_name ?? invite.tenant_name ?? "the workspace";
  const roles = invite.role_labels?.length ? invite.role_labels.join(", ") : "a member";
  const expires = new Date(invite.expires_at).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  return (
    <Shell title="You've been invited">
      <p className="text-base">
        <span className="font-semibold">{invite.invited_by ?? "Someone"}</span> invited you to join{" "}
        <span className="font-semibold">{scopeName}</span> as <span className="font-semibold">{roles}</span>.
      </p>

      {user ? (
        <>
          <p className="text-sm text-muted-foreground">
            You&apos;re signed in as {user.email}. Accepting will add this to your account.
          </p>
          <AcceptInviteButton token={token} />
        </>
      ) : (
        <>
          {/* No detour through /signup. Opening this link already proved
              control of the mailbox, so the account is created confirmed and
              the invitation accepted in one step — see acceptWithNewAccount. */}
          <CreateAccountForm token={token} email={invite.email} />
        </>
      )}

      <p className="text-xs text-muted-foreground">This link works once and expires on {expires}.</p>
    </Shell>
  );
}

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-md space-y-4 rounded-xl border bg-card p-8 shadow-sm">
        <h1 className="text-xl font-semibold">{title}</h1>
        {children}
      </div>
    </main>
  );
}
