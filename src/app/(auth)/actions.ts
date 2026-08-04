"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { publicEnv } from "@/lib/env";

const credentialsSchema = z.object({
  email: z.string().trim().email("Enter a valid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
});

export interface AuthActionResult {
  error?: string;
}

export async function signUpWithPassword(_prev: AuthActionResult, formData: FormData): Promise<AuthActionResult> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: { emailRedirectTo: `${publicEnv().NEXT_PUBLIC_APP_URL}/api/auth/callback` },
  });

  if (error) {
    return { error: error.message };
  }

  // If email confirmation is required (the production default), signUp
  // succeeds but returns no session — there's nothing to redirect into yet.
  if (!data.session) {
    return { error: "Check your email to confirm your account, then log in." };
  }

  redirect("/");
}

export async function signInWithPassword(_prev: AuthActionResult, formData: FormData): Promise<AuthActionResult> {
  const parsed = credentialsSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return { error: "Incorrect email or password" };
  }

  redirect("/");
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
    options: { redirectTo: `${publicEnv().NEXT_PUBLIC_APP_URL}/api/auth/callback` },
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
