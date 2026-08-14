import Link from "next/link";
import { ForgotPasswordForm } from "@/components/auth/forgot-password-form";

export default function ForgotPasswordPage() {
  return (
    <div className="w-full space-y-4">
      <div className="rounded-2xl border border-brand-n-200 bg-brand-n-0 p-8 shadow-sm">
        <h1 className="mb-2 text-center text-2xl font-extrabold text-brand-n-900">Reset your password</h1>
        <p className="mb-6 text-center text-sm text-brand-n-600">
          Enter your email and we&apos;ll send you a link to reset your password.
        </p>
        <ForgotPasswordForm />
      </div>

      <div className="rounded-2xl border border-brand-n-200 bg-brand-n-0 p-4 text-center text-sm text-brand-n-600 shadow-sm">
        <Link href="/login" className="font-semibold text-brand-teal-600 underline underline-offset-4">
          Back to log in
        </Link>
      </div>
    </div>
  );
}
