import Link from "next/link";
import { Separator } from "@/components/ui/separator";
import { CredentialsForm } from "@/components/auth/credentials-form";
import { GoogleSignInButton } from "@/components/auth/google-signin-button";
import { signInWithPassword } from "@/app/(auth)/actions";

export default function LoginPage() {
  return (
    <div className="w-full space-y-4">
      <div className="rounded-2xl border border-brand-n-200 bg-brand-n-0 p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-extrabold text-brand-n-900">
          Log in
        </h1>
        <div className="space-y-4">
          <CredentialsForm action={signInWithPassword} submitLabel="Log in" pendingLabel="Logging in..." />
          <div className="flex items-center gap-3">
            <Separator className="flex-1" />
            <span className="text-xs font-medium text-brand-n-400">OR</span>
            <Separator className="flex-1" />
          </div>
          <GoogleSignInButton />
        </div>
      </div>

      <div className="rounded-2xl border border-brand-n-200 bg-brand-n-0 p-4 text-center text-sm text-brand-n-600 shadow-sm">
        Don&apos;t have an account?{" "}
        <Link href="/signup" className="font-semibold text-brand-teal-600 underline underline-offset-4">
          Sign up
        </Link>
      </div>
    </div>
  );
}
