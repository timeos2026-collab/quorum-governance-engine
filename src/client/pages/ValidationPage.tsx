import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelenceMutation, modelenceQuery } from '@modelence/react-query';
import { ChevronDown, FlaskConical, Loader2, Play, ShieldAlert } from 'lucide-react';

import Page from '@/client/components/Page';
import { cn } from '@/client/lib/utils';

type StrategyState =
  | 'DISCOVERED'
  | 'UNDER_TEST'
  | 'FAILED'
  | 'PASSED'
  | 'PAPER'
  | 'SHADOW'
  | 'PRODUCTION'
  | 'RETIRED';

type TestResult = 'PASS' | 'FAIL' | 'INCONCLUSIVE';

type Overview = {
  counts: { strategies: number; runs: number; tests: number };
  byState: { state: StrategyState; count: number }[];
  byTest: { type: string; pass: number; fail: number; inconclusive: number }[];
  execution: { inPaper: number; inShadow: number; inProduction: number };
  engineVersion: string;
  latestDebateRun: string | null;
};

type Strategy = {
  strategyKey: string;
  name: string;
  subjectId: string;
  moduleScope: string;
  stance: string;
  conviction: number;
  convictionSource: string;
  state: StrategyState;
  stateReason: string;
  stateChangedAt: string;
  promotedBy: string | null;
  testsPassed: number;
  testsFailed: number;
  testsInconclusive: number;
  originDebateKey: string;
  dataOrigin: string;
  createdAt: string;
};

type Dossier = {
  strategy: {
    strategyKey: string;
    name: string;
    subjectId: string;
    state: StrategyState;
    originDebateKey: string;
    originThesisRunKey: string;
    convictionSource: string;
  };
  runs: {
    validationKey: string;
    runKey: string;
    verdict: 'PASSED' | 'FAILED' | 'HELD';
    verdictRule: string;
    verdictRationale: string;
    decisiveTestType: string | null;
    testsRun: number;
    passed: number;
    failed: number;
    inconclusive: number;
    citedObservationCount: number;
    evidenceWindowStart: string;
    evidenceWindowEnd: string;
  }[];
  tests: {
    testKey: string;
    type: string;
    result: TestResult;
    rule: string;
    finding: string;
    metrics: {
      label: string;
      value: number;
      unit: string;
      threshold?: number;
      comparator?: string;
    }[];
    limitations: string[];
    citedObservationKeys: string[];
  }[];
  transitions: {
    fromState: StrategyState | null;
    toState: StrategyState;
    actor: string;
    actorType: 'engine' | 'human';
    reason: string;
    createdAt: string;
  }[];
};

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

const STATE_TONE: Record<StrategyState, Tone> = {
  DISCOVERED: 'neutral',
  UNDER_TEST: 'info',
  FAILED: 'bad',
  PASSED: 'ok',
  PAPER: 'warn',
  SHADOW: 'warn',
  PRODUCTION: 'ok',
  RETIRED: 'neutral',
};

const RESULT_TONE: Record<TestResult, Tone> = {
  PASS: 'ok',
  FAIL: 'bad',
  INCONCLUSIVE: 'warn',
};

/** Tests computed from actually-observed evidence vs derived track record. */
const MEASURED_TESTS = new Set([
  'SLIPPAGE_ON_REAL_DEPTH',
  'WASH_ADJUSTED_VOLUME',
  'ADVERSARIAL_RED_TEAM',
]);

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

function TestBlock({ t }: { t: Dossier['tests'][number] }) {
  const measured = MEASURED_TESTS.has(t.type);
  return (
    <div
      className={cn(
        'rounded-sm border px-3 py-2.5',
        t.result === 'FAIL' ? 'border-blocked-500/30 bg-blocked-soft/30' : 'border-line bg-ink-700'
      )}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Tag value={t.result} tone={RESULT_TONE[t.result]} />
        <span className="font-mono text-[11px] text-fg">{t.type.replace(/_/g, ' ')}</span>
        <span className="ml-auto font-mono text-[10px] text-fg-faint">
          {measured ? 'FROM OBSERVED EVIDENCE' : 'DERIVED TRACK RECORD'}
        </span>
      </div>

      <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{t.finding}</p>
      <p className="mt-1 font-mono text-[10px] text-fg-faint">rule: {t.rule}</p>

      {t.metrics.length > 0 && (
        <div className="mt-2 grid gap-1 sm:grid-cols-2">
          {t.metrics.map((m) => (
            <div
              key={m.label}
              className="flex items-baseline justify-between gap-2 rounded-sm bg-ink-800/60 px-2 py-1"
            >
              <span className="text-[11px] text-fg-faint">{m.label}</span>
              <span className="font-mono text-[11px] text-fg">
                {m.value.toLocaleString()} {m.unit}
                {m.threshold !== undefined && (
                  <span className="text-fg-faint">
                    {' '}
                    ({m.comparator} {m.threshold.toLocaleString()})
                  </span>
                )}
              </span>
            </div>
          ))}
        </div>
      )}

      {t.limitations.length > 0 && (
        <ul className="mt-2 space-y-0.5">
          {t.limitations.map((l) => (
            <li key={l} className="font-mono text-[10px] leading-snug text-caution-500/80">
              limitation: {l}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StrategyCard({ s }: { s: Strategy }) {
  const [open, setOpen] = useState(false);
  const dossier = useQuery({
    ...modelenceQuery<Dossier>('validation.dossier', { strategyKey: s.strategyKey }),
    enabled: open,
  });

  return (
    <div className="animate-fade-in rounded-lg border border-line bg-ink-700">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-600/50"
      >
        <Tag value={s.state} tone={STATE_TONE[s.state]} />
        <span className="font-mono text-xs text-fg">{s.name}</span>
        <span className="font-mono text-[11px] text-fg-faint">
          {s.testsPassed}P / {s.testsFailed}F / {s.testsInconclusive}I
        </span>
        <span className="font-mono text-[11px] text-fg-muted">conviction {s.conviction}</span>
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 text-fg-faint transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      <div className="border-t border-line px-4 py-3">
        <p className="text-sm leading-relaxed text-fg-muted">{s.stateReason}</p>
        <p className="mt-1 font-mono text-[10px] text-fg-faint">
          conviction carried by {s.convictionSource} · origin {s.originDebateKey}
        </p>
      </div>

      {open && (
        <div className="animate-slide-up space-y-4 border-t border-line bg-ink-800/60 px-4 py-3">
          {dossier.isLoading && (
            <p className="font-mono text-xs text-fg-faint">Loading validation dossier…</p>
          )}

          {dossier.data && (
            <>
              {dossier.data.runs.length > 0 && (
                <div>
                  <p className="label-caps">Verdicts</p>
                  <ul className="mt-1.5 space-y-1.5">
                    {dossier.data.runs.map((r) => (
                      <li key={r.validationKey} className="rounded-sm border border-line bg-ink-700 px-2.5 py-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Tag
                            value={r.verdict}
                            tone={
                              r.verdict === 'PASSED' ? 'ok' : r.verdict === 'FAILED' ? 'bad' : 'warn'
                            }
                          />
                          <span className="font-mono text-[10px] text-fg-faint">{r.verdictRule}</span>
                          <span className="ml-auto font-mono text-[10px] text-fg-faint">
                            {r.citedObservationCount} observation(s) cited
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-fg-muted">
                          {r.verdictRationale}
                        </p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <div>
                <p className="label-caps">Tests — each independently dispositive</p>
                <div className="mt-1.5 space-y-1.5">
                  {dossier.data.tests.map((t) => (
                    <TestBlock key={t.testKey} t={t} />
                  ))}
                </div>
              </div>

              <div>
                <p className="label-caps">Lifecycle ledger</p>
                <ul className="mt-1.5 space-y-1">
                  {dossier.data.transitions.map((t, i) => (
                    <li
                      key={`${t.toState}-${i}`}
                      className="flex flex-wrap items-baseline gap-2 rounded-sm bg-ink-700 px-2.5 py-1.5"
                    >
                      <span className="font-mono text-[11px] text-fg">
                        {t.fromState ?? '—'} → {t.toState}
                      </span>
                      <Tag value={t.actorType} tone={t.actorType === 'human' ? 'info' : 'neutral'} />
                      <span className="flex-1 text-[11px] leading-snug text-fg-faint">
                        {t.reason}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

const STATE_FILTERS: (StrategyState | 'all')[] = [
  'all',
  'UNDER_TEST',
  'FAILED',
  'PAPER',
  'SHADOW',
  'PRODUCTION',
  'RETIRED',
];

export default function ValidationPage() {
  const queryClient = useQueryClient();
  const [state, setState] = useState<StrategyState | 'all'>('all');

  const overview = useQuery(modelenceQuery<Overview>('validation.overview', {}));
  const strategies = useQuery(
    modelenceQuery<Strategy[]>('validation.strategies', state === 'all' ? {} : { state })
  );

  const { mutate: runCycle, isPending } = useMutation({
    ...modelenceMutation('validation.runCycle'),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const o = overview.data;

  return (
    <Page
      seo={{ title: 'Validation — QUORUM' }}
      isLoading={overview.isLoading && strategies.isLoading}
    >
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label-caps">Governance engine · stage 5</p>
            <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight">
              Validation engine
            </h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fg-muted">
              Six independent tests, none of them averaged. One failure fails the strategy — a
              profitable backtest cannot buy forgiveness for a position that cannot be exited,
              because those are different claims about the world.
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
            Run validation cycle
          </button>
        </header>

        <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-caution-500/40 bg-caution-soft px-4 py-3 text-sm text-caution-500">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <p className="leading-relaxed">
            PASSED means eligible for paper, nothing more. The engine can promote a strategy as far
            as PAPER and no further — SHADOW and PRODUCTION require a named human, and the
            transition guard refuses the move otherwise. Slippage, wash-adjusted volume and the red
            team read real observations; the backtest, walk-forward and regime tests derive a
            synthetic track record because no price history is connected yet, and every one of them
            is labelled as such.
          </p>
        </div>

        {o && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Metric label="Candidates" value={o.counts.strategies} hint="from debate outcomes" />
              <Metric label="Validation runs" value={o.counts.runs} hint={o.engineVersion} />
              <Metric label="Tests executed" value={o.counts.tests} hint="6 per run" />
              <Metric
                label="In production"
                value={o.execution.inProduction}
                hint={`${o.execution.inPaper} paper · ${o.execution.inShadow} shadow`}
              />
            </div>

            <section className="animate-fade-in rounded-lg border border-line bg-ink-700">
              <div className="border-b border-line px-4 py-2.5">
                <p className="label-caps">Test outcomes by type</p>
              </div>
              <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-3">
                {o.byTest.map((t) => {
                  const total = t.pass + t.fail + t.inconclusive;
                  return (
                    <div key={t.type} className="rounded-sm border border-line bg-ink-800/60 p-3">
                      <p className="font-mono text-[11px] text-fg">{t.type.replace(/_/g, ' ')}</p>
                      <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-ink-600">
                        {total > 0 && (
                          <>
                            <div
                              className="bg-verified-500 transition-all duration-500"
                              style={{ width: `${(t.pass / total) * 100}%` }}
                            />
                            <div
                              className="bg-blocked-500 transition-all duration-500"
                              style={{ width: `${(t.fail / total) * 100}%` }}
                            />
                            <div
                              className="bg-caution-500 transition-all duration-500"
                              style={{ width: `${(t.inconclusive / total) * 100}%` }}
                            />
                          </>
                        )}
                      </div>
                      <p className="mt-1.5 font-mono text-[10px] text-fg-faint">
                        {t.pass} pass · {t.fail} fail · {t.inconclusive} inconclusive
                      </p>
                    </div>
                  );
                })}
              </div>
            </section>
          </>
        )}

        <div className="flex flex-wrap gap-1.5">
          {STATE_FILTERS.map((s) => (
            <button
              key={s}
              onClick={() => setState(s)}
              className={cn(
                'rounded-md border px-2.5 py-1.5 font-mono text-[11px] tracking-wide transition-colors',
                state === s
                  ? 'border-signal-600 bg-signal-soft text-signal-400'
                  : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
              )}
            >
              {s === 'all' ? 'ALL' : s.replace(/_/g, ' ')}
              {o && s !== 'all' && (
                <span className="ml-1.5 text-fg-faint">
                  {o.byState.find((b) => b.state === s)?.count ?? 0}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {strategies.data?.length === 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-line bg-ink-700 px-4 py-6 text-sm text-fg-muted">
              <FlaskConical className="mt-0.5 size-4 shrink-0 text-fg-faint" />
              <p className="leading-relaxed">
                No strategy candidates in this state. Candidates are only created from debates that
                reached an actionable directional consensus — a blocked or contested debate produces
                nothing to validate, which is the correct behaviour rather than a gap.
              </p>
            </div>
          )}
          {strategies.data?.map((s) => (
            <StrategyCard key={s.strategyKey} s={s} />
          ))}
        </div>
      </div>
    </Page>
  );
}
