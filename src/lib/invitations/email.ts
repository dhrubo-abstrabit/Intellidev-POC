import "server-only";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { sesEnv } from "@/lib/env";

export type InviteMailResult =
  | { delivered: true }
  | { delivered: false; reason: "not_configured" }
  | { delivered: false; reason: "send_failed"; error: string };

export interface InviteMail {
  to: string;
  inviteUrl: string;
  invitedBy: string;
  /** What they are being invited to, already resolved to a display name. */
  scopeName: string;
  /** Human labels, e.g. ["Space Admin"]. */
  roleLabels: string[];
  expiresAt: string;
}

/**
 * Sends one invitation through SES.
 *
 * NEVER THROWS. The caller has already written the `invitations` row by the
 * time this runs, and that row — not the email — is the source of truth. A
 * thrown error here would either roll back an invitation the recipient may
 * already have received, or force every call site into a try/catch that
 * amounts to the same thing. Instead the result says what happened and the
 * pending list offers "copy link" and "resend".
 *
 * Two non-delivery cases are deliberately distinguished:
 *
 *   not_configured — SES env vars absent. Expected during the sandbox wait,
 *                    and the reason the UI always shows a copy-able link.
 *   send_failed    — SES rejected it. In the sandbox that is what an
 *                    unverified recipient looks like, which is the single
 *                    most likely failure before production access is granted.
 */
export async function sendInviteEmail(mail: InviteMail): Promise<InviteMailResult> {
  const env = sesEnv();
  if (!env) return { delivered: false, reason: "not_configured" };

  const roles = mail.roleLabels.length > 0 ? mail.roleLabels.join(", ") : "a member";
  const expires = new Date(mail.expiresAt).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const subject = `${mail.invitedBy} invited you to ${mail.scopeName}`;

  // Plain text first, and the URL on its own line: it is the one thing the
  // recipient must be able to copy when a mail client mangles the link.
  const text = [
    `${mail.invitedBy} has invited you to join ${mail.scopeName} as ${roles}.`,
    ``,
    `Accept the invitation:`,
    mail.inviteUrl,
    ``,
    `This link works once and expires on ${expires}.`,
    `If you weren't expecting this, you can ignore this email.`,
  ].join("\n");

  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f7f5f1;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1c1a17">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #ded8ce;border-radius:6px;padding:28px">
<p style="margin:0 0 16px;font-size:16px;line-height:1.5"><strong>${escapeHtml(mail.invitedBy)}</strong> has invited you to join <strong>${escapeHtml(mail.scopeName)}</strong> as ${escapeHtml(roles)}.</p>
<p style="margin:0 0 24px"><a href="${escapeHtml(mail.inviteUrl)}" style="display:inline-block;background:#414a8c;color:#fff;text-decoration:none;padding:11px 20px;border-radius:5px;font-size:15px">Accept invitation</a></p>
<p style="margin:0 0 8px;font-size:13px;color:#5f5a52">Or paste this link into your browser:</p>
<p style="margin:0 0 20px;font-size:12px;word-break:break-all;color:#414a8c">${escapeHtml(mail.inviteUrl)}</p>
<p style="margin:0;font-size:13px;color:#918b80">This link works once and expires on ${escapeHtml(expires)}. If you weren't expecting this, you can ignore this email.</p>
</div></body></html>`;

  try {
    const client = new SESv2Client({
      region: env.AWS_REGION,
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
      },
    });

    await client.send(
      new SendEmailCommand({
        FromEmailAddress: env.SES_FROM_ADDRESS,
        Destination: { ToAddresses: [mail.to] },
        Content: {
          Simple: {
            Subject: { Data: subject, Charset: "UTF-8" },
            Body: {
              Text: { Data: text, Charset: "UTF-8" },
              Html: { Data: html, Charset: "UTF-8" },
            },
          },
        },
      }),
    );
    return { delivered: true };
  } catch (err) {
    // Logged, never rethrown, and never including the invite URL — the token
    // is a credential and must not reach a log aggregator.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`SES invite send failed for ${mail.to}:`, message);
    return { delivered: false, reason: "send_failed", error: message };
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
