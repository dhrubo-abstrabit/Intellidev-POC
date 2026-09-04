"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/env";

const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

const signUpSchema = credentialsSchema.extend({
  fullName: z.string().trim().min(1, "Enter your name").max(120),
});

export interface AuthActionResult {
  error?: string;
}

/**
 * Where to send someone after authenticating.
 *
 * Only same-site absolute PATHS are honoured. `next` reaches this from a query
 * string a user controls, so anything else — "https://evil.example",
 * "//evil.example", or a scheme-relative form — must not be followed, or the
 * login page becomes an open redirect that phishing can point anywhere.
 * Rejecting "//" specifically matters: the browser reads it as protocol-
 * relative and leaves the site, even though it starts with "/".
 */
function safeNext(raw: FormDataEntryValue | null): string {
  const value = typeof raw === "string" ? raw : "";
  if (!value.startsWith("/") || value.startsWith("//")) return "/";
  return value;
}

export async function signUpWithPassword(_prev: AuthActionResult, formData: FormData): Promise<AuthActionResult> {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    fullName: formData.get("fullName"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  // Carried through the confirmation email so an invited user lands back on
  // their invitation rather than a bare dashboard. /api/auth/callback already
  // honours `next` — the password-reset flow uses the same plumbing.
  const next = safeNext(formData.get("next"));

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: `${appUrl()}/api/auth/callback?next=${encodeURIComponent(next)}`,
      // handle_new_auth_user() mirrors raw_user_meta_data ->> 'full_name' into
      // public.users. Omit it and every members table shows this person as "—"
      // permanently, because no later screen collects it.
      data: { full_name: parsed.data.fullName },
    },
  });

  if (error) {
    return { error: error.message };
  }

  // If email confirmation is required (the production default), signUp
  // succeeds but returns no session — there's nothing to redirect into yet.
  if (!data.session) {
    return { error: "Check your email to confirm your account, then log in." };
  }

  redirect(next);
}

export async function signInWithPassword(_prev: AuthActionResult, formData: FormData): Promise<AuthActionResult> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const next = safeNext(formData.get("next"));

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: "Incorrect email or password" };
  }

  redirect(next);
}

/**
 * Bound directly to a `<form action={signInWithGoogle}>` (not driven through
 * `useActionState` like the credential flows above) — it either redirects to
 * Google or redirects back to /login with an error, so it has no state to
 * return.
 */
export async function signInWithGoogle(): Promise<void> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${appUrl()}/api/auth/callback` },
  });

  if (error || !data.url) {
    redirect("/login?error=google_oauth_unavailable");
  }

  redirect(data.url);
}

export async function signOut(): Promise<void> {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

const emailOnlySchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
});

export interface ForgotPasswordResult {
  error?: string;
  success?: boolean;
}

export async function requestPasswordReset(
  _prev: ForgotPasswordResult,
  formData: FormData,
): Promise<ForgotPasswordResult> {
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  // Supabase returns success here regardless of whether the email has an
  // account (documented anti-enumeration behavior) — the UI must never say
  // "no account with that email," only this one generic message.
  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: `${appUrl()}/api/auth/callback?next=/reset-password`,
  });

  if (error) {
    return { error: "Something went wrong. Please try again." };
  }

  return { success: true };
}

const newPasswordSchema = z
  .object({
    password: z.string().min(6, "Password must be at least 6 characters"),
    confirmPassword: z.string(),
  })
  .refine((data) => data.password === data.confirmPassword, {
    message: "Passwords don't match",
    path: ["confirmPassword"],
  });

export async function updatePassword(_prev: AuthActionResult, formData: FormData): Promise<AuthActionResult> {
  const parsed = newPasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  // Requires the recovery session created by the reset-link's callback
  // exchange (see api/auth/callback/route.ts) — a missing/expired one
  // surfaces here as an error rather than needing a separate page guard.
  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return { error: "Your reset link may have expired. Request a new one." };
  }

  redirect("/");
}
