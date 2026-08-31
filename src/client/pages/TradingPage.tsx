import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelenceMutation, modelenceQuery } from '@modelence/react-query';
import { AlertTriangle, LineChart, Loader2, ShieldCheck, SlidersHorizontal } from 'lucide-react';

import Page from '@/client/components/Page';
import { cn } from '@/client/lib/utils';

type Mandate = {
  current: {
    mandateKey: string;
    version: number;
    allowedCategories: string[];
    maxTier: number;
    maxGrossExposureUsd: number;
    excludedCapitalOrigins: string[];
    rationale: string;
    effectiveFrom: string;
    setBy: string;
  };
  history: {
    mandateKey: string;
    version: number;
    setBy: string;
    rationale: string;
    effectiveFrom: string;
    effectiveTo: string | null;
  }[];
};

type Book = {
  positions: {
    orderKey: string;
    symbol: string;
    side: string;
    category: string;
    tier: number;
    status: string;
    permittedMode: string;
    requestedSizeUsd: number;
    permittedSizeUsd: number;
    filledSizeUsd: number;
    fillPrice: number | null;
    fillDataOrigin: string | null;
    earliestLiveAt: string;
    provenance: {
      strategyKey: string;
      assessmentKey: string;
      gateVerdict: string | null;
      decisiveRuleId: string | null;
      sizeCapReason: string;
      jobRunId: string;
      generatorVersion: string;
    };
    dataOrigin: string;
  }[];
  excluded: {
    orderKey: string;
    symbol: string;
    category: string;
    tier: number;
    filledSizeUsd: number;
    reason: string;
  }[];
  exposure: {
    grossUsd: number;
    outOfMandateGrossUsd: number;
    ceilingUsd: number;
    headroomUsd: number;
    breached?: boolean;
  };
  mandateVersion: number;
};

type Pipeline = {
  rows: {
    strategyKey: string;
    symbol: string;
    tier: number;
    stance: string;
    conviction: number;
    convictionSource: string;
    validationState: string;
    gateVerdict: string | null;
    executionStatus: string | null;
    stage: string;
    blockedBy: string | null;
  }[];
  mandateVersion: number;
};

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

function Tag({ value, tone = 'neutral' }: { value: string; tone?: Tone }) {
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

const VERDICT_TONE: Record<string, Tone> = {
  APPROVED: 'ok',
  APPROVED_WITH_RESTRICTIONS: 'info',
  REQUIRES_HUMAN_APPROVAL: 'warn',
  BLOCKED: 'bad',
};

export default function TradingPage() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'book' | 'pipeline' | 'mandate'>('book');

  const mandate = useQuery(modelenceQuery<Mandate>('trading.mandate', {}));
  const book = useQuery(modelenceQuery<Book>('trading.book', {}));
  const pipeline = useQuery({
    ...modelenceQuery<Pipeline>('trading.pipeline', {}),
    enabled: tab === 'pipeline',
  });

  const [ceiling, setCeiling] = useState('');
  const [rationale, setRationale] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { mutate: setMandate, isPending } = useMutation({
    ...modelenceMutation('trading.setMandate'),
    onSuccess: () => {
      setCeiling('');
      setRationale('');
      setError(null);
      queryClient.invalidateQueries();
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  const m = mandate.data?.current;
  const b = book.data;

  return (
    <Page seo={{ title: 'Trading — QUORUM' }} isLoading={mandate.isLoading && book.isLoading}>
      <div className="mx-auto max-w-6xl space-y-6">
        <header>
          <p className="label-caps">Business line · trading</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight">Trading desk</h1>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fg-muted">
            The desk owns one thing: its mandate. Everything else on this page is read from the
            shared engine — the desk evaluates no risk rule, promotes no strategy and creates no
            order.
          </p>
        </header>

        <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-line bg-ink-700 px-4 py-3 text-sm text-fg-muted">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-signal-400" />
          <p className="leading-relaxed">
            A mandate can only narrow. There is no code path here that lets the desk look at
            something the risk gate blocked — the desk's filter runs after the gate, never instead
            of it. Positions shown below carry their gate verdict and the rule that sized them.
          </p>
        </div>

        {b && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Positions in mandate"
              value={b.positions.length}
              hint={`${b.excluded.length} order(s) outside mandate`}
            />
            <Metric label="Gross exposure" value={usd(b.exposure.grossUsd)} hint="synthetic fills" />
            <Metric
              label="Desk headroom"
              value={usd(b.exposure.headroomUsd)}
              hint={`ceiling ${usd(b.exposure.ceilingUsd)}`}
            />
            <Metric
              label="Mandate"
              value={`v${b.mandateVersion}`}
              hint={m ? `Tier ≤ ${m.maxTier} · ${m.allowedCategories.join(', ')}` : ''}
            />
          </div>
        )}

        {b?.exposure.breached && (
          <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-blocked-500/40 bg-blocked-soft px-4 py-3 text-sm text-blocked-500">
            <AlertTriangle className="mt-0.5 size-4 shrink-0" />
            <p className="leading-relaxed">
              Gross exposure exceeds the desk ceiling. This is reported, not auto-corrected — the
              desk does not get to quietly unwind a position that the engine and a human put on.
            </p>
          </div>
        )}

        <div className="flex flex-wrap gap-1.5">
          {(['book', 'pipeline', 'mandate'] as const).map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                'rounded-md border px-2.5 py-1.5 font-mono text-[11px] tracking-wide uppercase transition-colors',
                tab === t
                  ? 'border-signal-600 bg-signal-soft text-signal-400'
                  : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
              )}
            >
              {t}
            </button>
          ))}
        </div>

        {tab === 'book' && (
          <div className="space-y-2">
            {b?.positions.length === 0 && (
              <div className="flex items-start gap-3 rounded-lg border border-line bg-ink-700 px-4 py-6 text-sm text-fg-muted">
                <LineChart className="mt-0.5 size-4 shrink-0 text-fg-faint" />
                <p className="leading-relaxed">
                  No positions in mandate. The desk's book is derived from execution orders rather
                  than stored separately, so an empty book means the engine has produced nothing
                  inside this mandate — not that the book failed to load.
                </p>
              </div>
            )}

            {b?.positions.map((p) => (
              <div key={p.orderKey} className="animate-fade-in rounded-lg border border-line bg-ink-700">
                <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <Tag value={p.status} tone={p.status === 'FILLED' ? 'ok' : 'info'} />
                  <span className="font-mono text-xs text-fg">
                    {p.side} {p.symbol}
                  </span>
                  <Tag value={`TIER ${p.tier}`} />
                  <span className="font-mono text-[11px] text-fg-muted">
                    {usd(p.requestedSizeUsd)} → <span className="text-fg">{usd(p.permittedSizeUsd)}</span>
                    {p.filledSizeUsd > 0 && <> · filled {usd(p.filledSizeUsd)}</>}
                  </span>
                  <Tag value={p.permittedMode} tone={p.permittedMode === 'PRODUCTION' ? 'bad' : 'neutral'} />
                  {p.provenance.gateVerdict && (
                    <Tag
                      value={p.provenance.gateVerdict}
                      tone={VERDICT_TONE[p.provenance.gateVerdict] ?? 'neutral'}
                    />
                  )}
                  {p.fillDataOrigin && <Tag value={p.fillDataOrigin} />}
                </div>
                <div className="border-t border-line px-4 py-2.5">
                  <p className="text-xs leading-relaxed text-fg-muted">
                    {p.provenance.sizeCapReason}
                  </p>
                  <p className="mt-1 font-mono text-[10px] leading-snug text-fg-faint">
                    {p.provenance.strategyKey} → {p.provenance.assessmentKey} ·{' '}
                    {p.provenance.generatorVersion} · run {p.provenance.jobRunId}
                  </p>
                </div>
              </div>
            ))}

            {b && b.excluded.length > 0 && (
              <section className="animate-fade-in rounded-lg border border-line bg-ink-700">
                <div className="border-b border-line px-4 py-2.5">
                  <p className="label-caps">Outside mandate — visible, not hidden</p>
                  <p className="mt-1 text-[11px] leading-snug text-fg-faint">
                    Taken under an earlier mandate version. Still counted in gross exposure —{' '}
                    {usd(b.exposure.outOfMandateGrossUsd)} of the {usd(b.exposure.grossUsd)} total.
                    Narrowing a mandate does not make money already at risk disappear.
                  </p>
                </div>
                <ul className="divide-y divide-line">
                  {b.excluded.map((e) => (
                    <li key={e.orderKey} className="flex flex-wrap items-center gap-2 px-4 py-2.5">
                      <span className="font-mono text-[11px] text-fg">{e.symbol}</span>
                      <Tag value={`TIER ${e.tier}`} />
                      <span className="font-mono text-[11px] text-caution-500">
                        {usd(e.filledSizeUsd)}
                      </span>
                      <span className="flex-1 text-[11px] leading-snug text-fg-faint">
                        {e.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        )}

        {tab === 'pipeline' && (
          <div className="space-y-2">
            {pipeline.isLoading && (
              <p className="font-mono text-xs text-fg-faint">Loading engine pipeline…</p>
            )}
            {pipeline.data?.rows.length === 0 && (
              <div className="rounded-lg border border-line bg-ink-700 px-4 py-6 text-sm text-fg-muted">
                Nothing in the engine currently falls inside this mandate.
              </div>
            )}
            {pipeline.data?.rows.map((r) => (
              <div
                key={r.strategyKey}
                className="animate-fade-in rounded-lg border border-line bg-ink-700 px-4 py-3"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <span className="font-mono text-xs text-fg">
                    {r.stance} {r.symbol}
                  </span>
                  <Tag value={`TIER ${r.tier}`} />
                  <span className="font-mono text-[11px] text-fg-muted">{r.stage}</span>
                  {r.blockedBy && <Tag value={r.blockedBy} tone="warn" />}
                </div>
                <p className="mt-1 font-mono text-[10px] text-fg-faint">
                  conviction {r.conviction} carried by {r.convictionSource} — one named thesis, not
                  a blended score
                </p>
              </div>
            ))}
          </div>
        )}

        {tab === 'mandate' && m && (
          <div className="space-y-4">
            <section className="animate-fade-in rounded-lg border border-line bg-ink-700 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <p className="label-caps">Mandate {m.mandateKey}</p>
                <Tag value={`SET BY ${m.setBy}`} />
              </div>
              <p className="mt-2 text-sm leading-relaxed text-fg-muted">{m.rationale}</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <div className="rounded-sm border border-line bg-ink-800/60 px-2.5 py-2">
                  <p className="label-caps">Categories</p>
                  <p className="mt-0.5 font-mono text-[11px] text-fg">
                    {m.allowedCategories.join(', ')}
                  </p>
                </div>
                <div className="rounded-sm border border-line bg-ink-800/60 px-2.5 py-2">
                  <p className="label-caps">Max tier</p>
                  <p className="mt-0.5 font-mono text-[11px] text-fg">{m.maxTier}</p>
                </div>
                <div className="rounded-sm border border-line bg-ink-800/60 px-2.5 py-2">
                  <p className="label-caps">Gross ceiling</p>
                  <p className="mt-0.5 font-mono text-[11px] text-fg">
                    {usd(m.maxGrossExposureUsd)}
                  </p>
                </div>
              </div>
            </section>

            <section className="animate-fade-in rounded-lg border border-line bg-ink-700 p-4">
              <div className="flex items-center gap-2">
                <SlidersHorizontal className="size-3.5 text-fg-faint" />
                <p className="label-caps">Revise gross exposure ceiling</p>
              </div>
              <p className="mt-1 text-xs leading-relaxed text-fg-faint">
                Writes mandate v{m.version + 1} and closes v{m.version}. The old mandate is never
                deleted — positions taken under it stay judgeable against it.
              </p>
              <input
                value={ceiling}
                onChange={(e) => setCeiling(e.target.value)}
                inputMode="numeric"
                placeholder={`New ceiling in USD (current ${m.maxGrossExposureUsd})`}
                className="mt-2 w-full rounded-sm border border-line bg-ink-800 px-2.5 py-1.5 font-mono text-[11px] text-fg placeholder:text-fg-faint focus:border-signal-600 focus:outline-none"
              />
              <textarea
                value={rationale}
                onChange={(e) => setRationale(e.target.value)}
                rows={2}
                placeholder="Rationale — recorded permanently against this mandate version (min 20 characters)"
                className="mt-2 w-full resize-none rounded-sm border border-line bg-ink-800 px-2.5 py-1.5 font-mono text-[11px] text-fg placeholder:text-fg-faint focus:border-signal-600 focus:outline-none"
              />
              <button
                disabled={isPending || rationale.trim().length < 20 || !Number(ceiling)}
                onClick={() =>
                  setMandate({
                    allowedCategories: m.allowedCategories,
                    maxTier: m.maxTier,
                    maxGrossExposureUsd: Number(ceiling),
                    excludedCapitalOrigins: m.excludedCapitalOrigins,
                    rationale,
                  })
                }
                className="mt-2 flex items-center gap-2 rounded-md border border-signal-600 bg-signal-soft px-2.5 py-1.5 font-mono text-[11px] text-signal-400 transition-colors hover:bg-signal-600/25 disabled:opacity-40"
              >
                {isPending && <Loader2 className="size-3 animate-spin" />}
                Publish new mandate version
              </button>
              {error && <p className="mt-1.5 font-mono text-[10px] text-blocked-500">{error}</p>}
            </section>

            <section className="animate-fade-in rounded-lg border border-line bg-ink-700">
              <div className="border-b border-line px-4 py-2.5">
                <p className="label-caps">Mandate history — append-only</p>
              </div>
              <ul className="divide-y divide-line">
                {mandate.data?.history.map((h) => (
                  <li key={h.mandateKey} className="px-4 py-2.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-[11px] text-fg">v{h.version}</span>
                      <Tag value={h.effectiveTo ? 'SUPERSEDED' : 'IN FORCE'} tone={h.effectiveTo ? 'neutral' : 'ok'} />
                      <span className="font-mono text-[10px] text-fg-faint">{h.setBy}</span>
                    </div>
                    <p className="mt-1 text-[11px] leading-snug text-fg-muted">{h.rationale}</p>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        )}
      </div>
    </Page>
  );
}
