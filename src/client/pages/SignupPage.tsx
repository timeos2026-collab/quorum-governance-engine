import React, { useCallback, useState } from 'react';
import { signupWithPassword } from 'modelence/client';
import { Link } from 'react-router';
import { toast } from 'react-hot-toast';
import AuthShell from '@/client/components/AuthShell';

const fieldClass =
  'w-full rounded-md border border-line bg-ink-800 px-3 py-2 font-mono text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-signal-600 focus:ring-1 focus:ring-signal-600/40';

export default function SignupPage() {
  return (
    <AuthShell seo={{ title: 'Request access', noindex: true }}>
      <SignupForm />
    </AuthShell>
  );
}

function SignupForm() {
  const [isSignupSuccess, setIsSignupSuccess] = useState(false);

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);

    const email = String(formData.get('email'));
    const password = String(formData.get('password'));
    const confirmPassword = String(formData.get('confirmPassword'));

    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }

    try {
      await signupWithPassword({ email, password });
      setIsSignupSuccess(true);
    } catch (error) {
      console.error((error as Error).message);
    }
  }, []);

  if (isSignupSuccess) {
    return (
      <div className="animate-fade-in text-center">
        <h1 className="font-display text-lg font-semibold text-fg">Operator account created</h1>
        <p className="mt-2 text-sm text-fg-muted">
          Your account is registered. Every action you take from here is recorded in the audit
          trail against this identity.
        </p>
        <Link
          to="/login"
          className="mt-6 block w-full cursor-pointer rounded-md border border-signal-600 bg-signal-500 px-3 py-2 font-mono text-sm font-medium tracking-wider text-ink-900 transition-colors hover:bg-signal-400"
        >
          SIGN IN
        </Link>
      </div>
    );
  }

  return (
    <>
      <h1 className="font-display text-lg font-semibold text-fg">Request operator access</h1>
      <p className="mt-1 text-sm text-fg-muted">
        Operator identity is attached to every approval and override.
      </p>

      <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="email" className="label-caps mb-1.5 block">
            Email
          </label>
          <input type="email" name="email" id="email" required className={fieldClass} />
        </div>

        <div>
          <label htmlFor="password" className="label-caps mb-1.5 block">
            Password
          </label>
          <input type="password" name="password" id="password" required className={fieldClass} />
        </div>

        <div>
          <label htmlFor="confirm-password" className="label-caps mb-1.5 block">
            Confirm password
          </label>
          <input
            type="password"
            name="confirmPassword"
            id="confirm-password"
            required
            className={fieldClass}
          />
        </div>

        <div className="flex items-start gap-2.5">
          <input
            id="consent-terms"
            type="checkbox"
            name="consent-terms"
            required
            className="mt-0.5 size-4 rounded-xs border border-line-strong bg-ink-800 accent-signal-500"
          />
          <label htmlFor="consent-terms" className="text-sm text-fg-muted">
            I accept the{' '}
            <a
              className="text-signal-400 underline-offset-2 hover:underline"
              href="/terms"
              target="_blank"
              rel="noreferrer"
            >
              Terms and Conditions
            </a>
          </label>
        </div>

        <button
          type="submit"
          className="w-full cursor-pointer rounded-md border border-signal-600 bg-signal-500 px-3 py-2 font-mono text-sm font-medium tracking-wider text-ink-900 transition-colors hover:bg-signal-400"
        >
          CREATE ACCOUNT
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-fg-muted">
        Already registered?{' '}
        <Link to="/login" className="text-signal-400 underline-offset-2 hover:underline">
          Sign in
        </Link>
      </p>
    </>
  );
}
