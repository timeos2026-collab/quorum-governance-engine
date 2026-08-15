import React from 'react';
import { Link } from 'react-router';
import { Seo, type SeoProps } from '@/client/components/Seo';

/**
 * Full-bleed shell for unauthenticated surfaces (sign in / sign up).
 * Deliberately does not render the operator sidebar — no engine state is
 * exposed before authentication.
 */
export default function AuthShell({
  children,
  seo,
}: {
  children: React.ReactNode;
  seo?: SeoProps;
}) {
  return (
    <div className="quorum-grid flex min-h-screen flex-col items-center justify-center bg-ink-900 px-4 py-10">
      <Seo {...seo} />

      <div className="w-full max-w-sm animate-slide-up">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-sm border border-signal-600 font-mono text-sm font-semibold text-signal-400">
            Q
          </span>
          <span className="font-display text-lg font-semibold tracking-tight text-fg">QUORUM</span>
        </Link>

        <div className="rounded-lg border border-line bg-ink-700/90 p-6 backdrop-blur-sm">
          {children}
        </div>

        <p className="mt-6 text-center font-mono text-[11px] leading-relaxed tracking-wider text-fg-faint">
          DECISION-GOVERNANCE ENGINE · PAPER / SHADOW MODE
          <br />
          ALL ACTIONS ARE RECORDED IN THE AUDIT TRAIL
        </p>
      </div>
    </div>
  );
}
