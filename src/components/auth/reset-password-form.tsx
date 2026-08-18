"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { updatePassword, type AuthActionResult } from "@/app/(auth)/actions";

export function ResetPasswordForm() {
  const [state, formAction, isPending] = useActionState<AuthActionResult, FormData>(updatePassword, {});

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="password" className="text-brand-n-700">
          New password
        </Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" required minLength={6} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirmPassword" className="text-brand-n-700">
          Confirm password
        </Label>
        <Input
          id="confirmPassword"
          name="confirmPassword"
          type="password"
          autoComplete="new-password"
          required
          minLength={6}
        />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" className="w-full rounded-full" disabled={isPending}>
        {isPending ? "Updating..." : "Update password"}
      </Button>
    </form>
  );
}
