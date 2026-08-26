import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelenceMutation, modelenceQuery } from '@modelence/react-query';
import { AlertTriangle, ChevronDown, Clock, Loader2, Play, Terminal } from 'lucide-react';

import Page from '@/client/components/Page';
import { cn } from '@/client/lib/utils';

type Mode = 'PAPER' | 'SHADOW' | 'PRODUCTION';

type Overview = {
  counts: { orders: number; fills: number };
  byStatus: { status: string; count: number }[];
  byMode: { mode: Mode; count: number }[];
  provenance: { ingestedFills: number; generatorVersion: string };
  paperWindow: { embargoHours: number; underEmbargo: number; heldForDepth: number };
  latestRiskRun: string | null;
};

type Order = {
  orderKey: string;
  strategyKey: string;
  assessmentKey: string;
  symbol: string;
  side: string;
  moduleScope: string;
  requestedSizeUsd: number;
  permittedSizeUsd: number;
  sizeCapReason: string;
  sizeCaps: { ruleId: string; capUsd: number; binding: boolean; note: string }[];
  permittedMode: Mode;
  modeReason: string;
  restrictions: string[];
  sourceVerdict: string;
  decisiveRuleId: string | null;
  status: string;
  statusReason: string;
  earliestLiveAt: string;
  embargoHours: number;
  embargoReason: string;
  requiresHumanForDepth: boolean;
  dataOrigin: string;
  generatorVersion: string;
  jobRunId: string;
  createdAt: string;
  fill: {
    filledSizeUsd: number;
    fillPrice: number;
    slippageBps: number;
    partial: boolean;
    dataOrigin: string;
    filledAt: string;
  } | null;
};

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

const STATUS_TONE: Record<string, Tone> = {
  PROPOSED: 'neutral',
  RISK_CHECK: 'warn',
  APPROVED: 'info',
  SUBMITTED: 'info',
  PARTIALLY_FILLED: 'warn',
  FILLED: 'ok',
  ACTIVE: 'ok',
  CANCELLED: 'bad',
  EXPIRED: 'bad',
  MATURED: 'neutral',
};

const MODE_TONE: Record<Mode, Tone> = {
  PAPER: 'neutral',
  SHADOW: 'warn',
  PRODUCTION: 'bad',
};

function Tag({ value, tone }: { value: string; tone: Tone }) {
  const map = {
    ok: 'border-verified-500/40 bg-verified-soft text-verified-500',
    warn: 'border-caution-500/40 bg-caution-soft text-caution-500',
    bad: 'border-blocked-500/40 bg-blocked-soft text-blocked-500',
    info: 'border-inferred-500/40 bg-inferred-soft text-inferred-500',
    neutral: 'border-line-strong bg-ink-600 text-fg-muted',
  } as const;
  return (
    <span
      className={cn(
        'inline-block rounded-sm border px-1.5 py-0.5 font-mono text-[10px] tracking-wider',
        map[tone]
      )}
    >
      {value.replace(/_/g, ' ').toUpperCase()}
    </span>
  );
}

function Metric({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="animate-slide-up rounded-lg border border-line bg-ink-700 p-4">
      <p className="label-caps">{label}</p>
      <p className="mt-1.5 font-mono text-2xl text-fg">{value}</p>
      {hint && <p className="mt-1 text-xs text-fg-faint">{hint}</p>}
    </div>
  );
}

function usd(n: number) {
  return `$${n.toLocaleString()}`;
}

function OrderRow({ o }: { o: Order }) {
  const [open, setOpen] = useState(false);
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const embargoPending = new Date(o.earliestLiveAt) > new Date();

  const { mutate: submit, isPending } = useMutation({
    ...modelenceMutation('execution.submitOrder'),
    onSuccess: () => {
      setError(null);
      queryClient.invalidateQueries();
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  return (
    <div className="animate-fade-in rounded-lg border border-line bg-ink-700">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-600/50"
      >
        <Tag value={o.status} tone={STATUS_TONE[o.status] ?? 'neutral'} />
        <span className="font-mono text-xs text-fg">
          {o.side} {o.symbol}
        </span>
        <span className="font-mono text-[11px] text-fg-muted">
          {usd(o.requestedSizeUsd)} → <span className="text-fg">{usd(o.permittedSizeUsd)}</span>
        </span>
        <Tag value={o.permittedMode} tone={MODE_TONE[o.permittedMode]} />
        <span className="font-mono text-[10px] text-fg-faint">
          {o.decisiveRuleId ?? 'no decisive rule'}
        </span>
        {embargoPending && (
          <span className="flex items-center gap-1 font-mono text-[10px] text-caution-500">
            <Clock className="size-3" />
            live {new Date(o.earliestLiveAt).toLocaleString()}
          </span>
        )}
        <Tag value={o.dataOrigin} tone={o.dataOrigin === 'ingested' ? 'ok' : 'neutral'} />
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 text-fg-faint transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      {open && (
        <div className="animate-slide-up space-y-3 border-t border-line bg-ink-800/60 px-4 py-3">
          <div>
            <p className="label-caps">Size ceiling — min() over named rules</p>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">{o.sizeCapReason}</p>
            <div className="mt-1.5 grid gap-1 sm:grid-cols-3">
              {o.sizeCaps.map((c) => (
                <div
                  key={c.ruleId}
                  className={cn(
                    'rounded-sm border px-2 py-1.5',
                    c.binding ? 'border-signal-600/50 bg-signal-soft' : 'border-line bg-ink-700'
                  )}
                >
                  <p className="font-mono text-[10px] text-fg">{c.ruleId}</p>
                  <p className="font-mono text-[11px] text-fg-muted">
                    {c.capUsd < 0 ? 'no cap' : usd(c.capUsd)}
                    {c.binding && <span className="text-signal-400"> · binding</span>}
                  </p>
                  <p className="mt-0.5 text-[10px] leading-snug text-fg-faint">{c.note}</p>
                </div>
              ))}
            </div>
          </div>

          <div>
            <p className="label-caps">Execution mode</p>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">{o.modeReason}</p>
          </div>

          <div>
            <p className="label-caps">Paper embargo</p>
            <p className="mt-1 text-xs leading-relaxed text-fg-muted">{o.embargoReason}</p>
          </div>

          {o.restrictions.length > 0 && (
            <ul className="space-y-0.5">
              {o.restrictions.map((r) => (
                <li key={r} className="font-mono text-[10px] leading-snug text-inferred-500">
                  restriction: {r}
                </li>
              ))}
            </ul>
          )}

          {o.fill && (
            <div className="rounded-sm border border-line bg-ink-700 px-3 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <p className="label-caps">Fill</p>
                <Tag value={o.fill.dataOrigin} tone="neutral" />
                {o.fill.partial && <Tag value="PARTIAL" tone="warn" />}
              </div>
              <p className="mt-1 font-mono text-[11px] text-fg-muted">
                {usd(o.fill.filledSizeUsd)} @ {o.fill.fillPrice} · {o.fill.slippageBps} bps
                modelled slippage
              </p>
              <p className="mt-0.5 text-[10px] leading-snug text-fg-faint">
                Price is a deterministic function of the order key and symbol. No venue was
                contacted and this is not a market price.
              </p>
            </div>
          )}

          <p className="text-xs leading-relaxed text-fg-muted">{o.statusReason}</p>

          {o.status === 'APPROVED' && (
            <div>
              <button
                disabled={isPending}
                onClick={() => submit({ orderKey: o.orderKey })}
                className="rounded-md border border-signal-600 bg-signal-soft px-2.5 py-1.5 font-mono text-[11px] text-signal-400 transition-colors hover:bg-signal-600/25 disabled:opacity-50"
              >
                {isPending ? 'Submitting…' : 'Submit order'}
              </button>
              {error && <p className="mt-1.5 font-mono text-[10px] text-blocked-500">{error}</p>}
            </div>
          )}

          <p className="font-mono text-[10px] leading-snug text-fg-faint">
            {o.orderKey} · from {o.assessmentKey} ({o.sourceVerdict}) · {o.generatorVersion} · run{' '}
            {o.jobRunId}
          </p>
        </div>
      )}
    </div>
  );
}

const STATUS_FILTERS = ['all', 'RISK_CHECK', 'APPROVED', 'SUBMITTED', 'PARTIALLY_FILLED', 'FILLED'];

export default function ExecutionPage() {
  const queryClient = useQueryClient();
  const [status, setStatus] = useState<string>('all');

  const overview = useQuery(modelenceQuery<Overview>('execution.overview', {}));
  const orders = useQuery(
    modelenceQuery<Order[]>('execution.orders', status === 'all' ? {} : { status })
  );

  const { mutate: runCycle, isPending } = useMutation({
    ...modelenceMutation('execution.runCycle'),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const o = overview.data;
  const allSimulated = !o || o.provenance.ingestedFills === 0;

  return (
    <Page
      seo={{ title: 'Execution — QUORUM' }}
      isLoading={overview.isLoading && orders.isLoading}
    >
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label-caps">Governance engine · stage 7</p>
            <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight">
              Paper / shadow execution
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fg-muted">
              The only stage that acts, and the one that acts least. It reads the gate's findings
              and obeys them — it owns no risk logic of its own and cannot promote a strategy.
            </p>
          </div>

          <button
            onClick={() => runCycle({})}
            disabled={isPending}
            className="flex items-center gap-2 rounded-md border border-signal-600 bg-signal-soft px-3 py-2 text-xs text-signal-400 transition-colors hover:bg-signal-600/25 disabled:opacity-50"
          >
            {isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            Run paper cycle
          </button>
        </header>

        {allSimulated && (
          <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-caution-500/40 bg-caution-soft px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution-500" />
            <div>
              <p className="font-mono text-xs tracking-wider text-caution-500">
                PAPER EXECUTION — SIMULATED FILLS, NOT LIVE
              </p>
              <p className="mt-1 text-sm text-fg-muted">
                No venue is connected. Every fill below was produced by{' '}
                <span className="font-mono text-xs">
                  {o?.provenance.generatorVersion ?? 'execution-synth@1.0.0'}
                </span>{' '}
                as a deterministic function of the order key, is tagged{' '}
                <span className="font-mono text-xs">SIMULATED</span>, and is not a market price. This
                banner disappears only when a fill arrives tagged{' '}
                <span className="font-mono text-xs">INGESTED</span> from a real venue.
              </p>
            </div>
          </div>
        )}

        {o && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Orders" value={o.counts.orders} hint={`${o.counts.fills} synthetic fills`} />
            <Metric
              label="Under embargo"
              value={o.paperWindow.underEmbargo}
              hint={`${o.paperWindow.embargoHours}h wall-clock, Tier 3 + pre-launch`}
            />
            <Metric
              label="Held for depth"
              value={o.paperWindow.heldForDepth}
              hint="no observed 2% depth — never sized on a guess"
            />
            <Metric
              label="In production mode"
              value={o.byMode.find((m) => m.mode === 'PRODUCTION')?.count ?? 0}
              hint={`${o.byMode.find((m) => m.mode === 'PAPER')?.count ?? 0} paper · ${o.byMode.find((m) => m.mode === 'SHADOW')?.count ?? 0} shadow`}
            />
          </div>
        )}

        <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-line bg-ink-700 px-4 py-3 text-sm text-fg-muted">
          <Terminal className="mt-0.5 size-4 shrink-0 text-signal-400" />
          <p className="leading-relaxed">
            PRODUCTION mode requires all three FROM OBSERVED EVIDENCE validation tests
            (slippage-on-depth, wash-adjusted volume, red team) to pass. The survivorship,
            walk-forward and regime tests are DERIVED TRACK RECORD and can never authorise it on
            their own — a synthetic history is not a reason to move real capital.
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {STATUS_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={cn(
                'rounded-md border px-2.5 py-1.5 font-mono text-[11px] tracking-wide transition-colors',
                status === s
                  ? 'border-signal-600 bg-signal-soft text-signal-400'
                  : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
              )}
            >
              {s === 'all' ? 'ALL' : s.replace(/_/g, ' ')}
              {o && s !== 'all' && (
                <span className="ml-1.5 text-fg-faint">
                  {o.byStatus.find((b) => b.status === s)?.count ?? 0}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {orders.data?.length === 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-line bg-ink-700 px-4 py-6 text-sm text-fg-muted">
              <Terminal className="mt-0.5 size-4 shrink-0 text-fg-faint" />
              <p className="leading-relaxed">
                No orders in this state. Execution only ever sees assessments the gate marked
                APPROVED or APPROVED_WITH_RESTRICTIONS — blocked and pending-human assessments
                produce nothing here by construction, not by filtering.
              </p>
            </div>
          )}
          {orders.data?.map((row) => (
            <OrderRow key={row.orderKey} o={row} />
          ))}
        </div>
      </div>
    </Page>
  );
}
