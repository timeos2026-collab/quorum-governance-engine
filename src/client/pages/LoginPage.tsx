import React, { useCallback } from 'react';
import { getConfig, loginWithPassword } from 'modelence/client';
import { Link } from 'react-router';
import AuthShell from '@/client/components/AuthShell';

const fieldClass =
  'w-full rounded-md border border-line bg-ink-800 px-3 py-2 font-mono text-sm text-fg outline-none transition-colors placeholder:text-fg-faint focus:border-signal-600 focus:ring-1 focus:ring-signal-600/40';

export default function LoginPage() {
  return (
    <AuthShell seo={{ title: 'Sign in', noindex: true }}>
      <LoginForm />
    </AuthShell>
  );
}

function LoginForm() {
  const isSandboxEnv = getConfig('_system.env.type') === 'sandbox';
  const defaultDemoEmail = isSandboxEnv
    ? (getConfig('example.modelenceDemoUsername') as string | undefined)
    : undefined;
  const defaultDemoPassword = isSandboxEnv
    ? (getConfig('example.modelenceDemoPassword') as string | undefined)
    : undefined;

  const handleSubmit = useCallback(async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    await loginWithPassword({
      email: String(formData.get('email')),
      password: String(formData.get('password')),
    });
  }, []);

  return (
    <>
      <h1 className="font-display text-lg font-semibold text-fg">Operator sign in</h1>
      <p className="mt-1 text-sm text-fg-muted">
        Access the governance engine and its audit trail.
      </p>

      <form className="mt-6 space-y-4" onSubmit={handleSubmit}>
        <div>
          <label htmlFor="email" className="label-caps mb-1.5 block">
            Email
          </label>
          <input
            type="email"
            name="email"
            id="email"
            defaultValue={defaultDemoEmail}
            required
            className={fieldClass}
          />
        </div>

        <div>
          <label htmlFor="password" className="label-caps mb-1.5 block">
            Password
          </label>
          <input
            type="password"
            name="password"
            id="password"
            defaultValue={defaultDemoPassword}
            required
            className={fieldClass}
          />
        </div>

        <button
          type="submit"
          className="w-full cursor-pointer rounded-md border border-signal-600 bg-signal-500 px-3 py-2 font-mono text-sm font-medium tracking-wider text-ink-900 transition-colors hover:bg-signal-400"
        >
          SIGN IN
        </button>
      </form>

      <p className="mt-6 text-center text-sm text-fg-muted">
        No account?{' '}
        <Link to="/signup" className="text-signal-400 underline-offset-2 hover:underline">
          Request access
        </Link>
      </p>
    </>
  );
}
