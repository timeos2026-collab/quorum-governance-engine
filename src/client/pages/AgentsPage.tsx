import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelenceMutation, modelenceQuery } from '@modelence/react-query';
import { AlertTriangle, ChevronDown, Loader2, Play } from 'lucide-react';

import Page from '@/client/components/Page';
import { cn } from '@/client/lib/utils';

type Stance = 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'ABSTAIN' | 'BLOCK_RECOMMENDED';

type Overview = {
  counts: { total: number; active: number; agents: number };
  byStance: { stance: Stance; count: number }[];
  integrity: { confidenceCapped: number; singleObservation: number };
  generatorVersion: string;
  latestRunKey: string | null;
  latestAt: string | null;
};

type RosterEntry = {
  agentId: string;
  name: string;
  discipline: string;
  mandate: string;
  sourceScope: string[];
  metricScope: string[];
  maxConfidence: number;
  agentVersion: string;
  enabled: boolean;
  moduleScope: string | null;
  thesisCount: number;
};

type Thesis = {
  id: string;
  thesisKey: string;
  agentId: string;
  agentVersion: string;
  discipline: string;
  subjectId: string;
  stance: Stance;
  confidence: number;
  confidenceCap: number;
  confidenceCapReason: string;
  rationale: string;
  falsifiableCondition: string;
  weakestLink: string;
  citedObservationKeys: string[];
  citedObservationCount: number;
  evidenceGaps: string[];
  weakestVerifiability: string;
  evidenceOrigins: string[];
  runKey: string;
  createdAt: string;
  dataOrigin: string;
};

type ThesisEvidence = {
  thesisKey: string;
  citations: {
    observationKey: string;
    sourceType: string;
    source: string;
    metric: string;
    value: number | null;
    unit: string | null;
    statement: string;
    verifiability: string;
    observedAt: string;
    dataOrigin: string;
  }[];
  unresolvedCitations: string[];
};

const STANCE_TONE: Record<Stance, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  BULLISH: 'ok',
  BEARISH: 'warn',
  NEUTRAL: 'neutral',
  ABSTAIN: 'info',
  BLOCK_RECOMMENDED: 'bad',
};

function Tag({
  value,
  tone,
}: {
  value: string;
  tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral';
}) {
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

function ConfidenceBar({ value, cap }: { value: number; cap: number }) {
  const binding = value >= cap && cap < 100;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-1.5 w-20 overflow-hidden rounded-full bg-ink-500">
        <div
          className={cn(
            'h-full transition-all duration-500',
            binding ? 'bg-caution-500' : 'bg-signal-500'
          )}
          style={{ width: `${value}%` }}
        />
        {cap < 100 && (
          <div
            className="absolute top-0 h-full w-px bg-blocked-500"
            style={{ left: `${cap}%` }}
            title={`Cap: ${cap}`}
          />
        )}
      </div>
      <span className="font-mono text-xs text-fg-muted">{value}</span>
    </div>
  );
}

function ThesisCard({ t }: { t: Thesis }) {
  const [open, setOpen] = useState(false);
  const evidence = useQuery({
    ...modelenceQuery<ThesisEvidence>('agents.thesisEvidence', { thesisKey: t.thesisKey }),
    enabled: open,
  });

  return (
    <div className="animate-fade-in rounded-lg border border-line bg-ink-700">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-600/50"
      >
        <Tag value={t.stance} tone={STANCE_TONE[t.stance]} />
        <span className="font-mono text-xs text-fg">{t.subjectId}</span>
        <span className="font-mono text-xs text-fg-faint">{t.agentId}</span>
        <ConfidenceBar value={t.confidence} cap={t.confidenceCap} />
        <span className="font-mono text-[11px] text-fg-faint">
          {t.citedObservationCount} cited
          {t.evidenceGaps.length > 0 && ` · ${t.evidenceGaps.length} gap(s)`}
        </span>
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 text-fg-faint transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      <div className="border-t border-line px-4 py-3">
        <p className="text-sm leading-relaxed text-fg-muted">{t.rationale}</p>
      </div>

      {open && (
        <div className="animate-slide-up space-y-3 border-t border-line bg-ink-800/60 px-4 py-3">
          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <p className="label-caps">Falsifiable if</p>
              <p className="mt-1 text-sm text-fg-muted">{t.falsifiableCondition}</p>
            </div>
            <div>
              <p className="label-caps">Weakest link</p>
              <p className="mt-1 text-sm text-fg-muted">{t.weakestLink}</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="label-caps">Confidence</span>
            <span className="font-mono text-xs text-fg-muted">{t.confidenceCapReason}</span>
            <Tag value={t.weakestVerifiability} tone="info" />
            {t.evidenceOrigins.map((o) => (
              <Tag key={o} value={o} tone={o === 'ingested' ? 'ok' : 'warn'} />
            ))}
          </div>

          {t.evidenceGaps.length > 0 && (
            <div>
              <p className="label-caps">Declared metrics not found</p>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {t.evidenceGaps.map((g) => (
                  <span
                    key={g}
                    className="rounded-sm border border-blocked-500/30 bg-blocked-soft px-1.5 py-0.5 font-mono text-[10px] text-blocked-500"
                  >
                    {g}
                  </span>
                ))}
              </div>
            </div>
          )}

          <div>
            <p className="label-caps">Evidence cited ({t.citedObservationCount})</p>
            {evidence.isLoading && (
              <p className="mt-1 font-mono text-xs text-fg-faint">Resolving citations…</p>
            )}
            {evidence.data && (
              <>
                {evidence.data.unresolvedCitations.length > 0 && (
                  <p className="mt-1 font-mono text-xs text-blocked-500">
                    {evidence.data.unresolvedCitations.length} citation(s) could not be resolved —
                    provenance break.
                  </p>
                )}
                <ul className="mt-1.5 space-y-1.5">
                  {evidence.data.citations.map((c) => (
                    <li
                      key={c.observationKey}
                      className="rounded-sm border border-line bg-ink-700 px-2.5 py-2"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-[11px] text-fg">{c.metric}</span>
                        <span className="font-mono text-[11px] text-fg-muted">
                          {c.value === null ? '—' : c.value.toLocaleString()}
                          {c.unit && c.unit !== '%' ? ` ${c.unit}` : c.unit === '%' ? '%' : ''}
                        </span>
                        <Tag value={c.verifiability} tone={c.verifiability === 'verified' ? 'ok' : 'info'} />
                        <span className="font-mono text-[10px] text-fg-faint">{c.source}</span>
                        <span className="ml-auto font-mono text-[10px] text-fg-faint">
                          {new Date(c.observedAt).toLocaleTimeString()}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-fg-muted">{c.statement}</p>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <p className="font-mono text-[10px] text-fg-faint">
            {t.thesisKey} · {t.agentId}@{t.agentVersion} · run {t.runKey}
          </p>
        </div>
      )}
    </div>
  );
}

const TABS = ['theses', 'roster'] as const;
type Tab = (typeof TABS)[number];

export default function AgentsPage() {
  const [tab, setTab] = useState<Tab>('theses');
  const [stanceFilter, setStanceFilter] = useState<Stance | 'all'>('all');
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const overview = useQuery(modelenceQuery<Overview>('agents.overview', {}));
  const roster = useQuery(modelenceQuery<RosterEntry[]>('agents.roster', {}));
  const theses = useQuery(
    modelenceQuery<Thesis[]>('agents.theses', {
      ...(stanceFilter === 'all' ? {} : { stance: stanceFilter }),
      limit: 80,
    })
  );

  const { mutate: runCycle, isPending } = useMutation({
    ...modelenceMutation('agents.runCycle'),
    onSuccess: (data: unknown) => {
      const d = data as { written: number; skipped: number; status: string };
      setNotice(
        `Thesis cycle ${d.status} — ${d.written} theses written, ${d.skipped} already present for this cycle bucket.`
      );
      queryClient.invalidateQueries({ predicate: () => true });
    },
    onError: (e: unknown) => setNotice(`Cycle failed: ${(e as Error).message}`),
  });

  const o = overview.data;
  const abstains = o?.byStance.find((s) => s.stance === 'ABSTAIN')?.count ?? 0;
  const blocks = o?.byStance.find((s) => s.stance === 'BLOCK_RECOMMENDED')?.count ?? 0;

  return (
    <Page
      seo={{
        title: 'Agent Swarm',
        description:
          'QUORUM agent swarm: eight specialist agents emitting cited, falsifiable, confidence-capped theses from the shared evidence layer.',
      }}
      className="bg-ink-900"
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6">
        <header className="animate-fade-in flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="label-caps">Core Engine · Slice 3</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Agent Swarm</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-fg-muted">
              Eight specialists, each with a narrow mandate and a declared evidence scope. Every
              thesis cites the exact observations it rests on, states what would prove it wrong, and
              carries a confidence ceiling set by the weakest evidence beneath it. A thesis is an
              input to debate — agreement between agents confers no authority to act.
            </p>
          </div>
          <button
            onClick={() => runCycle({})}
            disabled={isPending}
            className="flex items-center gap-2 rounded-md border border-signal-500/50 bg-signal-soft px-3.5 py-2 font-mono text-xs tracking-wider text-signal-400 transition-colors hover:bg-signal-500/15 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            RUN THESIS CYCLE
          </button>
        </header>

        <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-caution-500/40 bg-caution-soft px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution-500" />
          <div>
            <p className="font-mono text-xs tracking-wider text-caution-500">
              THESES DERIVED FROM SIMULATED EVIDENCE
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              Reasoning is deterministic and rule-based (
              <span className="font-mono text-xs">{o?.generatorVersion}</span>), but it runs over the
              synthetic evidence layer. A thesis can never be more live than its citations — every
              one below inherits <span className="font-mono text-xs">SIMULATED</span> provenance.
              None of these are recommendations.
            </p>
          </div>
        </div>

        {notice && (
          <div className="animate-fade-in rounded-lg border border-line-strong bg-ink-700 px-4 py-3 font-mono text-xs text-fg-muted">
            {notice}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-6">
          <Metric label="Theses" value={o?.counts.total ?? '—'} hint="all cycles" />
          <Metric label="Agents" value={o?.counts.agents ?? '—'} hint="core swarm" />
          <Metric label="Block calls" value={blocks} hint="recommended, not enforced" />
          <Metric label="Abstentions" value={abstains} hint="insufficient evidence" />
          <Metric
            label="Confidence capped"
            value={o?.integrity.confidenceCapped ?? '—'}
            hint="ceiling was binding"
          />
          <Metric
            label="Single-obs"
            value={o?.integrity.singleObservation ?? '—'}
            hint="capped at 45"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 border-b border-line">
          {TABS.map((t) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 font-mono text-xs tracking-wider transition-colors',
                tab === t
                  ? 'border-signal-500 text-signal-400'
                  : 'border-transparent text-fg-faint hover:text-fg-muted'
              )}
            >
              {t === 'theses' ? 'THESIS FEED' : 'AGENT ROSTER'}
            </button>
          ))}
        </div>

        {tab === 'theses' && (
          <section className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {(['all', 'BLOCK_RECOMMENDED', 'BEARISH', 'NEUTRAL', 'BULLISH', 'ABSTAIN'] as const).map(
                (s) => (
                  <button
                    key={s}
                    onClick={() => setStanceFilter(s as Stance | 'all')}
                    className={cn(
                      'rounded-sm border px-2 py-1 font-mono text-[11px] tracking-wider transition-colors',
                      stanceFilter === s
                        ? 'border-signal-500/50 bg-signal-soft text-signal-400'
                        : 'border-line bg-ink-700 text-fg-faint hover:text-fg-muted'
                    )}
                  >
                    {s === 'all' ? 'ALL' : s.replace(/_/g, ' ')}
                  </button>
                )
              )}
            </div>

            {theses.data?.length === 0 && (
              <div className="rounded-lg border border-line bg-ink-700 px-4 py-8 text-center text-sm text-fg-faint">
                No theses yet. Run a thesis cycle to have the swarm read the evidence layer.
              </div>
            )}

            <div className="flex flex-col gap-2">
              {theses.data?.map((t) => (
                <ThesisCard key={t.id} t={t} />
              ))}
            </div>
          </section>
        )}

        {tab === 'roster' && (
          <section className="grid animate-fade-in gap-3 lg:grid-cols-2">
            {roster.data?.map((a) => (
              <div key={a.agentId} className="rounded-lg border border-line bg-ink-700 p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="font-display text-sm font-semibold text-fg">{a.name}</h3>
                  <Tag value={a.discipline} tone="neutral" />
                  {!a.enabled && <Tag value="disabled" tone="bad" />}
                  <span className="ml-auto font-mono text-[11px] text-fg-faint">
                    max conf {a.maxConfidence}
                  </span>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-fg-muted">{a.mandate}</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <div>
                    <p className="label-caps">Source scope</p>
                    <p className="mt-1 font-mono text-[11px] text-fg-muted">
                      {a.sourceScope.join(', ')}
                    </p>
                  </div>
                  <div>
                    <p className="label-caps">Metric scope</p>
                    <p className="mt-1 font-mono text-[11px] text-fg-muted">
                      {a.metricScope.join(', ')}
                    </p>
                  </div>
                </div>
                <p className="mt-3 font-mono text-[10px] text-fg-faint">
                  {a.agentId}@{a.agentVersion} · {a.thesisCount} theses ·{' '}
                  {a.moduleScope ? `module: ${a.moduleScope}` : 'core engine'}
                </p>
              </div>
            ))}
            <div className="rounded-lg border border-dashed border-line-strong bg-ink-800/50 p-4">
              <p className="label-caps">Module-specific agents</p>
              <p className="mt-2 text-sm text-fg-muted">
                The three module-specific agents (Private Equity allocation, Private Credit
                underwriting, Investment Banking jurisdiction advisory) arrive with their modules in
                Slices 9–11. They will extend this roster and inherit the same citation, cap and
                falsifiability rules — they do not get their own reasoning path.
              </p>
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}
