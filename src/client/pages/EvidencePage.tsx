import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelenceMutation, modelenceQuery } from '@modelence/react-query';
import { AlertTriangle, Loader2, Play, RotateCcw } from 'lucide-react';

import Page from '@/client/components/Page';
import { cn } from '@/client/lib/utils';

type SourceType =
  | 'on_chain'
  | 'market_microstructure'
  | 'narrative_social'
  | 'regulatory'
  | 'security';

type Verifiability = 'verified' | 'inferred' | 'social_claim' | 'model_inference' | 'assumption' | 'unverified';

type Overview = {
  counts: { total: number; jobRuns: number };
  bySource: { sourceType: SourceType; count: number; cadenceMs: number }[];
  byVerifiability: { verifiability: Verifiability; count: number }[];
  provenance: { simulated: number; ingested: number };
  generatorVersion: string;
  latestObservedAt: string | null;
};

type Observation = {
  id: string;
  observationKey: string;
  sourceType: SourceType;
  source: string;
  observedAt: string;
  retrievalTimestamp: string;
  verifiability: Verifiability;
  relevantEntityType: string;
  relevantEntityId: string;
  relevantJurisdictionId: string | null;
  metric: string;
  value: number | null;
  unit: string | null;
  statement: string;
  jobRunId: string;
  generatorVersion: string;
  dataOrigin: string;
};

type JobRun = {
  id: string;
  jobId: string;
  runKey: string;
  trigger: 'cron' | 'manual';
  triggeredBy: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: 'running' | 'succeeded' | 'failed';
  observationsWritten: number;
  observationsSkipped: number;
  errors: string[];
  outputSummary: string;
  sourceCoverage: string[];
  generatorVersion: string;
  dataOrigin: string;
};

const SOURCE_LABEL: Record<SourceType, string> = {
  on_chain: 'On-chain',
  market_microstructure: 'Microstructure',
  narrative_social: 'Narrative / social',
  regulatory: 'Regulatory',
  security: 'Security',
};

function formatCadence(ms: number) {
  if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 60_000)}m`;
}

function Tag({ value, tone }: { value: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral' }) {
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
      {value.toUpperCase()}
    </span>
  );
}

function verifiabilityTone(v: Verifiability) {
  if (v === 'verified') return 'ok' as const;
  if (v === 'inferred' || v === 'model_inference') return 'info' as const;
  if (v === 'social_claim') return 'warn' as const;
  return 'bad' as const;
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

function Th({ children }: { children: React.ReactNode }) {
  return <th className="label-caps whitespace-nowrap px-3 py-2 text-left font-normal">{children}</th>;
}

function Td({ children, mono, wrap }: { children: React.ReactNode; mono?: boolean; wrap?: boolean }) {
  return (
    <td
      className={cn(
        'px-3 py-2 text-sm text-fg-muted',
        !wrap && 'whitespace-nowrap',
        mono && 'font-mono text-xs'
      )}
    >
      {children}
    </td>
  );
}

const TABS = ['feed', 'runs'] as const;
type Tab = (typeof TABS)[number];

export default function EvidencePage() {
  const [tab, setTab] = useState<Tab>('feed');
  const [sourceFilter, setSourceFilter] = useState<SourceType | 'all'>('all');
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const overview = useQuery(modelenceQuery<Overview>('evidence.overview', {}));
  const feed = useQuery(
    modelenceQuery<Observation[]>('evidence.feed', {
      ...(sourceFilter === 'all' ? {} : { sourceType: sourceFilter }),
      limit: 80,
    })
  );
  const runs = useQuery(modelenceQuery<JobRun[]>('evidence.jobRuns', { limit: 25 }));

  function refreshAll() {
    queryClient.invalidateQueries({ predicate: () => true });
  }

  const { mutate: runCycle, isPending: isRunning } = useMutation({
    ...modelenceMutation('evidence.runCycle'),
    onSuccess: (data: unknown) => {
      const d = data as { written: number; skipped: number };
      setNotice(
        `Cycle complete — ${d.written} new observations written, ${d.skipped} already present in the current cadence bucket.`
      );
      refreshAll();
    },
    onError: (e: unknown) => setNotice(`Cycle failed: ${(e as Error).message}`),
  });

  const { mutate: replayRun, isPending: isReplaying } = useMutation({
    ...modelenceMutation('evidence.replayRun'),
    onSuccess: (data: unknown) => {
      const d = data as { deterministic: boolean; note: string; written: number };
      setNotice(
        `${d.deterministic ? 'DETERMINISTIC' : 'NEW RUN'} — ${d.note} (${d.written} written)`
      );
      refreshAll();
    },
    onError: (e: unknown) => setNotice(`Replay failed: ${(e as Error).message}`),
  });

  const o = overview.data;
  const isAllSimulated = !!o && o.provenance.ingested === 0;

  return (
    <Page
      seo={{
        title: 'Evidence',
        description:
          'QUORUM evidence layer: provenance-tagged observations across on-chain, microstructure, narrative, regulatory and security sources.',
      }}
      className="bg-ink-900"
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6">
        <header className="animate-fade-in flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="label-caps">Core Engine · Slice 2</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Evidence Layer</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-fg-muted">
              Every observation the engine will ever reason over lands here first, carrying its
              source, source type, retrieval timestamp and verifiability. Agents, debate, validation
              and the risk gate read from this store and nowhere else — no module gets a private
              feed.
            </p>
          </div>
          <button
            onClick={() => runCycle({})}
            disabled={isRunning}
            className="flex items-center gap-2 rounded-md border border-signal-500/50 bg-signal-soft px-3.5 py-2 font-mono text-xs tracking-wider text-signal-400 transition-colors hover:bg-signal-500/15 disabled:opacity-50"
          >
            {isRunning ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            RUN INGESTION CYCLE
          </button>
        </header>

        {isAllSimulated && (
          <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-caution-500/40 bg-caution-soft px-4 py-3">
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution-500" />
            <div>
              <p className="font-mono text-xs tracking-wider text-caution-500">
                SIMULATED EVIDENCE — NOT LIVE
              </p>
              <p className="mt-1 text-sm text-fg-muted">
                No real market, on-chain, or regulatory feed is connected. Every observation below
                was produced by deterministic synthetic generators (
                <span className="font-mono text-xs">{o?.generatorVersion}</span>) and is tagged{' '}
                <span className="font-mono text-xs">SIMULATED</span> with a{' '}
                <span className="font-mono text-xs">synthetic:</span> source prefix. Swapping in a
                real feed replaces the generators only — the observation shape and every downstream
                consumer stay unchanged.
              </p>
            </div>
          </div>
        )}

        {notice && (
          <div className="animate-fade-in rounded-lg border border-line-strong bg-ink-700 px-4 py-3 font-mono text-xs text-fg-muted">
            {notice}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-8">
          <Metric label="Observations" value={o?.counts.total ?? '—'} hint="all sources" />
          <Metric label="Job runs" value={o?.counts.jobRuns ?? '—'} hint="append-only ledger" />
          {o?.bySource.map((s) => (
            <Metric
              key={s.sourceType}
              label={SOURCE_LABEL[s.sourceType]}
              value={s.count}
              hint={`every ${formatCadence(s.cadenceMs)}`}
            />
          ))}
          <Metric
            label="Live rows"
            value={o?.provenance.ingested ?? '—'}
            hint={`${o?.provenance.simulated ?? 0} simulated`}
          />
        </div>

        {o && o.byVerifiability.length > 0 && (
          <div className="animate-fade-in flex flex-wrap items-center gap-3 rounded-lg border border-line bg-ink-700 px-4 py-3">
            <span className="label-caps">Verifiability mix</span>
            {o.byVerifiability.map((v) => (
              <span key={v.verifiability} className="flex items-center gap-1.5">
                <Tag value={v.verifiability} tone={verifiabilityTone(v.verifiability)} />
                <span className="font-mono text-xs text-fg-muted">{v.count}</span>
              </span>
            ))}
            <span className="ml-auto text-xs text-fg-faint">
              A KOL claim is never stored as a verified fact. Downstream agents must respect this
              field.
            </span>
          </div>
        )}

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
              {t === 'feed' ? 'OBSERVATION FEED' : 'JOB RUN LEDGER'}
            </button>
          ))}
        </div>

        {tab === 'feed' && (
          <section className="animate-fade-in flex flex-col gap-3">
            <div className="flex flex-wrap gap-1.5">
              {(['all', ...(Object.keys(SOURCE_LABEL) as SourceType[])] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setSourceFilter(s as SourceType | 'all')}
                  className={cn(
                    'rounded-sm border px-2 py-1 font-mono text-[11px] tracking-wider transition-colors',
                    sourceFilter === s
                      ? 'border-signal-500/50 bg-signal-soft text-signal-400'
                      : 'border-line bg-ink-700 text-fg-faint hover:text-fg-muted'
                  )}
                >
                  {s === 'all' ? 'ALL' : SOURCE_LABEL[s as SourceType].toUpperCase()}
                </button>
              ))}
            </div>

            <div className="overflow-hidden rounded-lg border border-line bg-ink-700">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead className="border-b border-line bg-ink-600">
                    <tr>
                      <Th>Observed</Th>
                      <Th>Source type</Th>
                      <Th>Entity</Th>
                      <Th>Metric</Th>
                      <Th>Value</Th>
                      <Th>Verifiability</Th>
                      <Th>Source</Th>
                      <Th>Origin</Th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {feed.isLoading && (
                      <tr>
                        <Td>Loading evidence…</Td>
                      </tr>
                    )}
                    {feed.data?.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-3 py-8 text-center text-sm text-fg-faint">
                          No observations recorded yet. Run an ingestion cycle to populate the
                          evidence layer.
                        </td>
                      </tr>
                    )}
                    {feed.data?.map((obs) => (
                      <tr key={obs.id} className="transition-colors hover:bg-ink-600/60">
                        <Td mono>{new Date(obs.observedAt).toLocaleTimeString()}</Td>
                        <Td>
                          <Tag value={SOURCE_LABEL[obs.sourceType]} tone="neutral" />
                        </Td>
                        <Td mono>
                          {obs.relevantEntityId}
                          {obs.relevantJurisdictionId && (
                            <span className="ml-1.5 text-fg-faint">
                              · {obs.relevantJurisdictionId}
                            </span>
                          )}
                        </Td>
                        <Td mono>{obs.metric}</Td>
                        <Td mono>
                          {obs.value === null
                            ? '—'
                            : `${obs.value.toLocaleString()}${obs.unit === '%' ? '%' : ''}`}
                          {obs.unit && obs.unit !== '%' && (
                            <span className="ml-1 text-fg-faint">{obs.unit}</span>
                          )}
                        </Td>
                        <Td>
                          <Tag value={obs.verifiability} tone={verifiabilityTone(obs.verifiability)} />
                        </Td>
                        <Td mono>{obs.source}</Td>
                        <Td>
                          <Tag
                            value={obs.dataOrigin}
                            tone={obs.dataOrigin === 'ingested' ? 'ok' : 'warn'}
                          />
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <p className="text-xs text-fg-faint">
              Showing the {feed.data?.length ?? 0} most recent observations. Each row is immutable
              and keyed to the job run that produced it, so any later decision can be replayed
              against exactly the evidence it saw.
            </p>
          </section>
        )}

        {tab === 'runs' && (
          <section className="animate-fade-in overflow-hidden rounded-lg border border-line bg-ink-700">
            <div className="overflow-x-auto">
              <table className="w-full border-collapse">
                <thead className="border-b border-line bg-ink-600">
                  <tr>
                    <Th>Started</Th>
                    <Th>Job</Th>
                    <Th>Run key</Th>
                    <Th>Trigger</Th>
                    <Th>Status</Th>
                    <Th>Written</Th>
                    <Th>Skipped</Th>
                    <Th>Duration</Th>
                    <Th>Replay</Th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {runs.data?.length === 0 && (
                    <tr>
                      <td colSpan={9} className="px-3 py-8 text-center text-sm text-fg-faint">
                        No job runs recorded yet.
                      </td>
                    </tr>
                  )}
                  {runs.data?.map((r) => {
                    const sourceType = r.jobId.replace('evidence.ingest.', '') as SourceType;
                    return (
                      <tr key={r.id} className="transition-colors hover:bg-ink-600/60">
                        <Td mono>{new Date(r.startedAt).toLocaleString()}</Td>
                        <Td mono>{sourceType}</Td>
                        <Td mono>{r.runKey}</Td>
                        <Td>
                          <Tag value={r.trigger} tone={r.trigger === 'cron' ? 'neutral' : 'info'} />
                        </Td>
                        <Td>
                          <Tag
                            value={r.status}
                            tone={
                              r.status === 'succeeded'
                                ? 'ok'
                                : r.status === 'failed'
                                  ? 'bad'
                                  : 'warn'
                            }
                          />
                        </Td>
                        <Td mono>{r.observationsWritten}</Td>
                        <Td mono>{r.observationsSkipped}</Td>
                        <Td mono>{r.durationMs === null ? '—' : `${r.durationMs}ms`}</Td>
                        <Td>
                          <button
                            onClick={() => replayRun({ sourceType, runKey: r.runKey })}
                            disabled={isReplaying}
                            className="flex items-center gap-1.5 rounded-sm border border-line-strong bg-ink-600 px-2 py-1 font-mono text-[11px] tracking-wider text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
                          >
                            <RotateCcw className="size-3" />
                            REPLAY
                          </button>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="border-t border-line px-4 py-3 text-xs text-fg-faint">
              The ledger is append-only. Replaying a recorded run key writes nothing and leaves the
              original run untouched — that no-op is the proof that historical evidence is never
              silently overwritten.
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}
