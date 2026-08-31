/**
 * QUORUM application shell.
 *
 * Every screen renders inside this shell: a left rail listing the governance
 * pipeline + the five business-line modules, and a top bar carrying the global
 * execution-mode banner (PAPER / SHADOW) and session state.
 */

import React from 'react';
import { Link, useLocation } from 'react-router';
import { useSession } from 'modelence/client';
import {
  Database,
  Radar,
  Users,
  Swords,
  FlaskConical,
  ShieldCheck,
  Terminal,
  FileClock,
  LineChart,
  Landmark,
  Banknote,
  Briefcase,
  PieChart,
  LogOut,
} from 'lucide-react';
import LoadingSpinner from '@/client/components/LoadingSpinner';
import { Seo, type SeoProps } from '@/client/components/Seo';
import { cn } from '@/client/lib/utils';

interface PageProps {
  children?: React.ReactNode;
  isLoading?: boolean;
  className?: string;
  seo?: SeoProps;
}

type NavItem = {
  label: string;
  to?: string;
  icon: React.ComponentType<{ className?: string }>;
};

const ENGINE_NAV: NavItem[] = [
  { label: 'Registry', to: '/', icon: Database },
  { label: 'Evidence', to: '/evidence', icon: Radar },
  { label: 'Agent Swarm', to: '/agents', icon: Users },
  { label: 'Debate', to: '/debate', icon: Swords },
  { label: 'Validation', to: '/validation', icon: FlaskConical },
  { label: 'Risk Gate', to: '/risk', icon: ShieldCheck },
  { label: 'Execution', to: '/execution', icon: Terminal },
  { label: 'Audit Trail', icon: FileClock },
];

const MODULE_NAV: NavItem[] = [
  { label: 'Trading', to: '/trading', icon: LineChart },
  { label: 'Private Equity', icon: Landmark },
  { label: 'Private Credit', icon: Banknote },
  { label: 'Investment Banking', icon: Briefcase },
  { label: 'AUM', icon: PieChart },
];

function NavSection({ title, items }: { title: string; items: NavItem[] }) {
  const { pathname } = useLocation();

  return (
    <div className="space-y-1">
      <p className="label-caps px-3 pb-1">{title}</p>
      {items.map(({ label, to, icon: Icon }) => {
        const isActive = to !== undefined && to === pathname;
        const base =
          'flex items-center gap-2.5 rounded-md px-3 py-1.5 text-sm transition-colors duration-150';

        if (!to) {
          return (
            <div
              key={label}
              title="Not built yet"
              className={cn(base, 'cursor-not-allowed text-fg-faint/70')}
            >
              <Icon className="size-4 shrink-0" />
              <span className="truncate">{label}</span>
              <span className="ml-auto font-mono text-[9px] tracking-widest text-fg-faint/60">
                SOON
              </span>
            </div>
          );
        }

        return (
          <Link
            key={label}
            to={to}
            className={cn(
              base,
              isActive
                ? 'bg-signal-soft text-signal-400'
                : 'text-fg-muted hover:bg-ink-600 hover:text-fg'
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="truncate">{label}</span>
          </Link>
        );
      })}
    </div>
  );
}

function Sidebar() {
  return (
    <aside className="hidden w-60 shrink-0 flex-col gap-6 border-r border-line bg-ink-800 p-3 lg:flex">
      <Link to="/" className="flex items-center gap-2.5 px-2 pt-1">
        <span className="flex size-7 items-center justify-center rounded-sm border border-signal-600 font-mono text-xs font-semibold text-signal-400">
          Q
        </span>
        <span className="font-display text-base font-semibold tracking-tight">QUORUM</span>
      </Link>

      <NavSection title="Governance Engine" items={ENGINE_NAV} />
      <NavSection title="Business Lines" items={MODULE_NAV} />

      <div className="mt-auto rounded-md border border-line bg-ink-700 p-3">
        <p className="label-caps">Execution mode</p>
        <p className="mt-1 font-mono text-sm text-caution-500">PAPER / SHADOW</p>
        <p className="mt-1 text-xs leading-snug text-fg-faint">
          All modules default to paper until explicitly promoted by a human.
        </p>
      </div>
    </aside>
  );
}

function TopBar() {
  const { user } = useSession();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-4 border-b border-line bg-ink-800 px-4">
      <div className="flex items-center gap-3">
        <Link to="/" className="flex items-center gap-2 lg:hidden">
          <span className="flex size-6 items-center justify-center rounded-sm border border-signal-600 font-mono text-[11px] text-signal-400">
            Q
          </span>
          <span className="font-display text-sm font-semibold">QUORUM</span>
        </Link>
        <div className="hidden items-center gap-2 sm:flex">
          <span className="size-1.5 animate-pulse-signal rounded-full bg-verified-500" />
          <span className="font-mono text-xs text-fg-muted">ENGINE ONLINE</span>
        </div>
      </div>

      <div className="flex items-center gap-3">
        <span className="hidden rounded-sm border border-caution-500/40 bg-caution-soft px-2 py-1 font-mono text-[10px] tracking-widest text-caution-500 sm:inline">
          PAPER MODE
        </span>
        {user ? (
          <div className="flex items-center gap-3">
            <span className="font-mono text-xs text-fg-muted">{user.handle}</span>
            <Link
              to="/logout"
              className="flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              <LogOut className="size-3.5" />
              Sign out
            </Link>
          </div>
        ) : (
          <Link
            to="/login"
            className="rounded-md border border-signal-600 bg-signal-soft px-3 py-1.5 text-xs text-signal-400 transition-colors hover:bg-signal-600/25"
          >
            Sign in
          </Link>
        )}
      </div>
    </header>
  );
}

export default function Page({ children, className, isLoading = false, seo }: PageProps) {
  return (
    <div className="flex min-h-screen max-w-full overflow-x-hidden bg-ink-900 text-fg">
      <Seo {...seo} />
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className={cn('min-h-0 flex-1 overflow-x-hidden p-6', className)}>
          {isLoading ? (
            <div className="flex h-full w-full items-center justify-center">
              <LoadingSpinner />
            </div>
          ) : (
            children
          )}
        </main>
      </div>
    </div>
  );
}
