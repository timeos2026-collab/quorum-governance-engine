import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelenceMutation, modelenceQuery } from '@modelence/react-query';
import { AlertTriangle, ChevronDown, Loader2, Play, Gavel } from 'lucide-react';

import Page from '@/client/components/Page';
import { cn } from '@/client/lib/utils';

type OutcomeType =
  | 'BLOCKED_BY_DEBATE'
  | 'DIRECTIONAL_CONSENSUS'
  | 'CONTESTED'
  | 'NO_ACTIONABLE_POSITION'
  | 'INSUFFICIENT_EVIDENCE';

type Dissent = {
  agentId: string;
  stance: string;
  confidence: number;
  argument: string;
  survived: boolean;
};

type Overview = {
  counts: { debates: number; challenges: number; outcomes: number };
  byOutcome: { outcome: OutcomeType; count: number }[];
  adjudication: { upheld: number; dismissed: number; thesesDefeated: number };
  engineVersion: string;
  latestThesisRun: string | null;
};

type Outcome = {
  id: string;
  debateKey: string;
  subjectId: string;
  outcome: OutcomeType;
  resolvedStance: string | null;
  conviction: number;
  convictionSource: string;
  convictionFloor: number;
  survivingCount: number;
  defeatedCount: number;
  dissent: Dissent[];
  unresolvedQuestions: string[];
  reasoning: string;
  requiresValidation: boolean;
  engineVersion: string;
  dataOrigin: string;
  createdAt: string;
};

type Transcript = {
  debate: {
    debateKey: string;
    subjectId: string;
    thesisRunKey: string;
    participantCount: number;
    challengeCount: number;
    engineVersion: string;
  };
  rounds: {
    round: number;
    phase: string;
    summary: string;
    challengesRaised: number;
    challengesUpheld: number;
    thesesDefeated: number;
  }[];
  participants: {
    agentId: string;
    stance: string;
    statedConfidence: number;
    survived: boolean;
    upheldChallengesAgainst: number;
    defeatedBy: string[];
    weakestVerifiability: string;
    citedObservationCount: number;
  }[];
  challenges: {
    challengeKey: string;
    challengerAgentId: string;
    targetAgentId: string;
    type: string;
    argument: string;
    ruling: 'UPHELD' | 'DISMISSED';
    rulingRule: string;
    rulingRationale: string;
  }[];
};

const OUTCOME_TONE: Record<OutcomeType, 'ok' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  BLOCKED_BY_DEBATE: 'bad',
  DIRECTIONAL_CONSENSUS: 'ok',
  CONTESTED: 'warn',
  NO_ACTIONABLE_POSITION: 'neutral',
  INSUFFICIENT_EVIDENCE: 'info',
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

function OutcomeCard({ o }: { o: Outcome }) {
  const [open, setOpen] = useState(false);
  const transcript = useQuery({
    ...modelenceQuery<Transcript>('debate.transcript', { debateKey: o.debateKey }),
    enabled: open,
  });

  return (
    <div className="animate-fade-in rounded-lg border border-line bg-ink-700">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-600/50"
      >
        <Tag value={o.outcome} tone={OUTCOME_TONE[o.outcome]} />
        <span className="font-mono text-xs text-fg">{o.subjectId}</span>
        {o.resolvedStance && <Tag value={o.resolvedStance} tone="neutral" />}
        <span className="font-mono text-[11px] text-fg-faint">
          {o.survivingCount} survived · {o.defeatedCount} defeated
        </span>
        {o.conviction > 0 && (
          <span className="font-mono text-[11px] text-fg-muted">
            conviction {o.conviction}
            {o.convictionFloor !== o.conviction && (
              <span className="text-fg-faint"> (floor {o.convictionFloor})</span>
            )}
          </span>
        )}
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 text-fg-faint transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      <div className="border-t border-line px-4 py-3">
        <p className="text-sm leading-relaxed text-fg-muted">{o.reasoning}</p>
        {o.conviction > 0 && (
          <p className="mt-2 font-mono text-[11px] text-fg-faint">
            Conviction carried by {o.convictionSource} — a single agent's own stated confidence, not
            a blend.
          </p>
        )}
      </div>

      {open && (
        <div className="animate-slide-up space-y-4 border-t border-line bg-ink-800/60 px-4 py-3">
          {o.unresolvedQuestions.length > 0 && (
            <div>
              <p className="label-caps">Unresolved</p>
              <ul className="mt-1 space-y-1">
                {o.unresolvedQuestions.map((q) => (
                  <li key={q} className="font-mono text-[11px] text-caution-500">
                    · {q}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div>
            <p className="label-caps">Positions on record (dissent preserved)</p>
            <ul className="mt-1.5 space-y-1.5">
              {o.dissent.map((d) => (
                <li
                  key={d.agentId}
                  className={cn(
                    'rounded-sm border px-2.5 py-2',
                    d.survived ? 'border-line bg-ink-700' : 'border-line bg-ink-800 opacity-70'
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-[11px] text-fg">{d.agentId}</span>
                    <Tag value={d.stance} tone={d.survived ? 'neutral' : 'bad'} />
                    <span className="font-mono text-[11px] text-fg-muted">{d.confidence}</span>
                    <span className="ml-auto font-mono text-[10px] text-fg-faint">
                      {d.survived ? 'SURVIVED' : 'DEFEATED'}
                    </span>
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-fg-muted">{d.argument}</p>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <p className="label-caps">Challenge transcript</p>
            {transcript.isLoading && (
              <p className="mt-1 font-mono text-xs text-fg-faint">Loading transcript…</p>
            )}
            {transcript.data && transcript.data.challenges.length === 0 && (
              <p className="mt-1 text-xs text-fg-faint">
                No challenges were raised — no agent's mandate gave it grounds to attack another's
                position here.
              </p>
            )}
            {transcript.data && (
              <ul className="mt-1.5 space-y-1.5">
                {transcript.data.challenges.map((c) => (
                  <li
                    key={c.challengeKey}
                    className="rounded-sm border border-line bg-ink-700 px-2.5 py-2"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <Gavel className="size-3 text-fg-faint" />
                      <span className="font-mono text-[11px] text-fg">
                        {c.challengerAgentId} → {c.targetAgentId}
                      </span>
                      <Tag value={c.type} tone="neutral" />
                      <Tag value={c.ruling} tone={c.ruling === 'UPHELD' ? 'bad' : 'ok'} />
                    </div>
                    <p className="mt-1 text-xs leading-relaxed text-fg-muted">{c.argument}</p>
                    <p className="mt-1 font-mono text-[10px] text-fg-faint">
                      rule {c.rulingRule} — {c.rulingRationale}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {transcript.data && (
            <div>
              <p className="label-caps">Rounds</p>
              <ol className="mt-1 space-y-1">
                {transcript.data.rounds.map((r) => (
                  <li key={r.round} className="text-xs text-fg-muted">
                    <span className="font-mono text-[10px] text-fg-faint">
                      R{r.round} {r.phase}
                    </span>{' '}
                    {r.summary}
                  </li>
                ))}
              </ol>
            </div>
          )}

          <p className="font-mono text-[10px] text-fg-faint">
            {o.debateKey} · {o.engineVersion} · requires validation:{' '}
            {String(o.requiresValidation).toUpperCase()}
          </p>
        </div>
      )}
    </div>
  );
}

export default function DebatePage() {
  const [filter, setFilter] = useState<OutcomeType | 'all'>('all');
  const [notice, setNotice] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const overview = useQuery(modelenceQuery<Overview>('debate.overview', {}));
  const outcomes = useQuery(
    modelenceQuery<Outcome[]>('debate.outcomes', {
      ...(filter === 'all' ? {} : { outcome: filter }),
      limit: 40,
    })
  );

  const { mutate: runCycle, isPending } = useMutation({
    ...modelenceMutation('debate.runCycle'),
    onSuccess: (data: unknown) => {
      const d = data as { written: number; skipped: number; note: string };
      setNotice(`${d.note} ${d.written} debate(s) resolved, ${d.skipped} already on record.`);
      queryClient.invalidateQueries({ predicate: () => true });
    },
    onError: (e: unknown) => setNotice(`Debate cycle failed: ${(e as Error).message}`),
  });

  const o = overview.data;
  const blocked = o?.byOutcome.find((b) => b.outcome === 'BLOCKED_BY_DEBATE')?.count ?? 0;
  const contested = o?.byOutcome.find((b) => b.outcome === 'CONTESTED')?.count ?? 0;

  return (
    <Page
      seo={{
        title: 'Debate',
        description:
          'QUORUM debate engine: agent theses challenged on named rules, reconciled without averaging confidence.',
      }}
      className="bg-ink-900"
    >
      <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6">
        <header className="animate-fade-in flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="label-caps">Core Engine · Slice 4</p>
            <h1 className="mt-1 font-display text-2xl font-semibold">Debate &amp; Reconciliation</h1>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-fg-muted">
              Theses are put in opposition and challenged on their stated weakest links. Confidence
              is never averaged and votes are never counted — a thesis survives or is defeated by
              named, individually recorded rulings, and the outcome is carried by one named agent's
              own stated confidence. Dissent is preserved permanently, including when it loses.
            </p>
          </div>
          <button
            onClick={() => runCycle({})}
            disabled={isPending}
            className="flex items-center gap-2 rounded-md border border-signal-500/50 bg-signal-soft px-3.5 py-2 font-mono text-xs tracking-wider text-signal-400 transition-colors hover:bg-signal-500/15 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />}
            RUN DEBATE CYCLE
          </button>
        </header>

        <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-caution-500/40 bg-caution-soft px-4 py-3">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-caution-500" />
          <div>
            <p className="font-mono text-xs tracking-wider text-caution-500">
              A DEBATE OUTCOME AUTHORISES NOTHING
            </p>
            <p className="mt-1 text-sm text-fg-muted">
              Agreement between agents is not permission to act. Every outcome below carries{' '}
              <span className="font-mono text-xs">requiresValidation</span> and must still pass
              validation (Slice 5) and the risk gate (Slice 6) before it can reach even paper
              execution. Underlying theses derive from simulated evidence.
            </p>
          </div>
        </div>

        {notice && (
          <div className="animate-fade-in rounded-lg border border-line-strong bg-ink-700 px-4 py-3 font-mono text-xs text-fg-muted">
            {notice}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
          <Metric label="Debates" value={o?.counts.debates ?? '—'} hint="one per subject per run" />
          <Metric label="Challenges" value={o?.counts.challenges ?? '—'} hint="all rounds" />
          <Metric
            label="Upheld"
            value={o?.adjudication.upheld ?? '—'}
            hint={`${o?.adjudication.dismissed ?? 0} dismissed`}
          />
          <Metric
            label="Theses defeated"
            value={o?.adjudication.thesesDefeated ?? '—'}
            hint="lost on challenge"
          />
          <Metric label="Blocked" value={blocked} hint="by surviving blocker" />
          <Metric label="Contested" value={contested} hint="disagreement not split" />
        </div>

        <div className="flex flex-wrap gap-1.5">
          {(
            [
              'all',
              'BLOCKED_BY_DEBATE',
              'CONTESTED',
              'DIRECTIONAL_CONSENSUS',
              'NO_ACTIONABLE_POSITION',
              'INSUFFICIENT_EVIDENCE',
            ] as const
          ).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f as OutcomeType | 'all')}
              className={cn(
                'rounded-sm border px-2 py-1 font-mono text-[11px] tracking-wider transition-colors',
                filter === f
                  ? 'border-signal-500/50 bg-signal-soft text-signal-400'
                  : 'border-line bg-ink-700 text-fg-faint hover:text-fg-muted'
              )}
            >
              {f === 'all' ? 'ALL' : f.replace(/_/g, ' ')}
            </button>
          ))}
        </div>

        {outcomes.data?.length === 0 && (
          <div className="rounded-lg border border-line bg-ink-700 px-4 py-8 text-center text-sm text-fg-faint">
            No debates on record. Run a debate cycle to reconcile the latest thesis run.
          </div>
        )}

        <div className="flex flex-col gap-2">
          {outcomes.data?.map((o) => (
            <OutcomeCard key={o.id} o={o} />
          ))}
        </div>
      </div>
    </Page>
  );
}
