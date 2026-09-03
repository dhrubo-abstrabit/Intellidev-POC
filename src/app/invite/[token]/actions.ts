"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";

/**
 * Accepts an invitation and lands the user where it granted them access.
 *
 * All the authorization lives in `accept_invitation()`, which is SECURITY
 * DEFINER for the obvious reason: the caller holds no membership yet, so every
 * RLS write policy in the schema would reject them. It hashes the plaintext
 * token internally, so the hash never travels in a query this layer builds,
 * and it provisions tenant → workspace → space → project in the one order the
 * composite FKs permit — atomically, so a caller either gets the whole scope
 * or none of it.
 *
 * This action therefore does almost nothing, which is the point. Re-checking
 * expiry or revocation here would be a second implementation of a decision the
 * function already makes correctly.
 */
export async function acceptInvitation(token: string): Promise<{ error?: string }> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_invitation", { p_token: token });

  if (error) {
    // The function raises with a plain sentence — "invitation has expired",
    // "invitation has already been accepted" — which is more useful to the
    // recipient than anything this layer could substitute.
    return { error: error.message.replace(/^.*?:\s*/, "") };
  }

  // `never` return: redirect() throws, so this is the end of the function.
  return await redirectIntoGrantedScope();
}

const passwordSchema = z.object({
  password: z.string().min(6, "Password must be at least 6 characters"),
});

/**
 * Creates an account for an invited person and accepts in one step.
 *
 * WHY THIS EXISTS RATHER THAN A LINK TO /signup.
 *
 * Ordinary signup requires the new user to confirm their email address before
 * they get a session — correct for self-service registration, where nothing
 * yet proves the person controls the mailbox they typed. An invitee has
 * already proved exactly that: the tokenised link was mailed to that address
 * and they opened it. Sending a second confirmation email asks them to prove
 * the same fact twice, and adds a round trip that depends on Supabase Auth's
 * shared, rate-limited sender arriving promptly.
 *
 * So this creates the user through the ADMIN API with `email_confirm: true`.
 * That flag is scoped to this one path — `enable_confirmations` stays ON at
 * the project level, so ordinary signup keeps its proof-of-address. Turning it
 * off globally would have been the easy version of this and a genuine hole,
 * because self-service registration remains open: anyone could then register
 * an address they do not control.
 *
 * The email is taken from the INVITATION, never from user input. A caller who
 * could choose it would be able to mint a confirmed account for any address
 * they liked.
 */
export async function acceptWithNewAccount(
  token: string,
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string }> {
  const parsed = passwordSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid password" };
  }

  const anon = await createClient();

  // Re-read the invitation server-side. The token is the only input trusted
  // here, and this both validates it and yields the address to register.
  const { data: preview } = await anon.rpc("invite_preview", { p_token: token });
  const invite = preview?.[0];
  if (!invite) return { error: "This invitation link isn't valid." };
  if (invite.status !== "valid") {
    return { error: `This invitation is ${invite.status} and can no longer be used.` };
  }

  const service = createServiceClient();
  const { error: createError } = await service.auth.admin.createUser({
    email: invite.email,
    password: parsed.data.password,
    // The whole point: they proved control of this mailbox by opening the
    // link, so do not make them prove it again.
    email_confirm: true,
  });

  if (createError) {
    // Already registered is the common case — someone who was invited, made an
    // account earlier, and came back. Send them to sign in rather than failing.
    if (/already|exists|registered/i.test(createError.message)) {
      return { error: "An account already exists for this address. Sign in instead." };
    }
    return { error: "Could not create your account. Please try again." };
  }

  // Sign in through the USER-scoped client so the session cookie is written
  // for this browser; the service client holds no session and persists none.
  const { error: signInError } = await anon.auth.signInWithPassword({
    email: invite.email,
    password: parsed.data.password,
  });
  if (signInError) {
    return { error: "Account created, but sign-in failed. Try signing in." };
  }

  const { error: acceptError } = await anon.rpc("accept_invitation", { p_token: token });
  if (acceptError) {
    return { error: acceptError.message.replace(/^.*?:\s*/, "") };
  }

  // `never` return: redirect() throws, so this is the end of the function.
  return await redirectIntoGrantedScope();
}

/**
 * Lands the user on the deepest thing the invitation actually opened up.
 *
 * Queried AFTER accepting and through the USER-scoped client, so each read
 * succeeds only because the membership now exists — which makes this a check
 * of what was really granted rather than a guess from the invitation's
 * columns. Prefers a project (the useful screen) over the workspace shell.
 */
async function redirectIntoGrantedScope(): Promise<never> {
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("id, workspace_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (project) redirect(`/w/${project.workspace_id}/p/${project.id}`);

  const { data: workspace } = await supabase.from("workspaces").select("id").limit(1).maybeSingle();
  redirect(workspace ? `/w/${workspace.id}` : "/");
}
