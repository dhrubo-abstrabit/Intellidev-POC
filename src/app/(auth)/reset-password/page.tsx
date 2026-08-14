import { ResetPasswordForm } from "@/components/auth/reset-password-form";

export default function ResetPasswordPage() {
  return (
    <div className="w-full space-y-4">
      <div className="rounded-2xl border border-brand-n-200 bg-brand-n-0 p-8 shadow-sm">
        <h1 className="mb-6 text-center text-2xl font-extrabold text-brand-n-900">Set a new password</h1>
        <ResetPasswordForm />
      </div>
    </div>
  );
}
