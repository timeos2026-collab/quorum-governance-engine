import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { modelenceMutation, modelenceQuery } from '@modelence/react-query';
import { ChevronDown, Loader2, Lock, Play, ShieldCheck, Scale } from 'lucide-react';

import Page from '@/client/components/Page';
import { cn } from '@/client/lib/utils';

type Verdict = 'APPROVED' | 'APPROVED_WITH_RESTRICTIONS' | 'REQUIRES_HUMAN_APPROVAL' | 'BLOCKED';

type Overview = {
  counts: { assessments: number; findings: number; overrides: number; policies: number };
  byVerdict: { verdict: Verdict; count: number }[];
  byDomain: {
    domain: string;
    blocked: number;
    human: number;
    restricted: number;
    approved: number;
  }[];
  engineVersion: string;
  latestValidationRun: string | null;
};

type Policy = {
  policyKey: string;
  ruleId: string;
  version: string;
  domain: string;
  title: string;
  statement: string;
  rationale: string;
  maxVerdict: Verdict;
  overridable: boolean;
  effectiveFrom: string;
};

type Assessment = {
  assessmentKey: string;
  strategyKey: string;
  subjectId: string;
  moduleScope: string;
  proposedAction: string;
  proposedSizeUsd: number;
  verdict: Verdict;
  decisiveRuleId: string | null;
  rationale: string;
  restrictions: string[];
  permittedSizeUsd: number;
  permittedExecutionMode: string;
  findingCount: number;
  blockingFindingCount: number;
  citedObservationCount: number;
  engineVersion: string;
  dataOrigin: string;
  createdAt: string;
};

type FindingsPayload = {
  findings: {
    findingKey: string;
    ruleId: string;
    policyKey: string;
    domain: string;
    verdict: Verdict;
    finding: string;
    evidence: string[];
    citedObservationKeys: string[];
    overridable: boolean;
  }[];
  overrides: {
    actor: string;
    decision: string;
    overriddenVerdict: Verdict;
    resultingVerdict: Verdict;
    reason: string;
    acknowledgedFindings: string[];
    createdAt: string;
  }[];
};

type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'neutral';

const VERDICT_TONE: Record<Verdict, Tone> = {
  APPROVED: 'ok',
  APPROVED_WITH_RESTRICTIONS: 'info',
  REQUIRES_HUMAN_APPROVAL: 'warn',
  BLOCKED: 'bad',
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

function OverridePanel({ a }: { a: Assessment }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { mutate, isPending } = useMutation({
    ...modelenceMutation('risk.overrideAssessment'),
    onSuccess: () => {
      setReason('');
      setError(null);
      queryClient.invalidateQueries();
    },
    onError: (e: unknown) => setError((e as Error).message),
  });

  if (a.verdict === 'BLOCKED') {
    return (
      <div className="flex items-start gap-2 rounded-sm border border-blocked-500/30 bg-blocked-soft/40 px-3 py-2.5">
        <Lock className="mt-0.5 size-3.5 shrink-0 text-blocked-500" />
        <p className="text-xs leading-relaxed text-blocked-500">
          A hard block is not dismissible from this screen. Clear it by changing the rule or the
          underlying fact — both versioned and attributable — rather than by waving it through at
          2am.
        </p>
      </div>
    );
  }

  if (a.verdict !== 'REQUIRES_HUMAN_APPROVAL') {
    return (
      <p className="font-mono text-[10px] text-fg-faint">
        No pending human decision on this assessment.
      </p>
    );
  }

  return (
    <div className="rounded-sm border border-caution-500/30 bg-caution-soft/25 px-3 py-2.5">
      <p className="label-caps">Human decision required</p>
      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        placeholder="Reason — recorded permanently against your account (min 20 characters)"
        className="mt-2 w-full resize-none rounded-sm border border-line bg-ink-800 px-2.5 py-1.5 font-mono text-[11px] text-fg placeholder:text-fg-faint focus:border-signal-600 focus:outline-none"
      />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button
          disabled={isPending || reason.trim().length < 20}
          onClick={() => mutate({ assessmentKey: a.assessmentKey, decision: 'APPROVE', reason })}
          className="rounded-md border border-verified-500/40 bg-verified-soft px-2.5 py-1.5 font-mono text-[11px] text-verified-500 transition-colors hover:bg-verified-500/20 disabled:opacity-40"
        >
          Approve with restrictions
        </button>
        <button
          disabled={isPending || reason.trim().length < 20}
          onClick={() => mutate({ assessmentKey: a.assessmentKey, decision: 'REJECT', reason })}
          className="rounded-md border border-blocked-500/40 bg-blocked-soft px-2.5 py-1.5 font-mono text-[11px] text-blocked-500 transition-colors hover:bg-blocked-500/20 disabled:opacity-40"
        >
          Reject
        </button>
        {isPending && <Loader2 className="size-3.5 animate-spin text-fg-faint" />}
        <span className="font-mono text-[10px] text-fg-faint">
          the original assessment is never edited
        </span>
      </div>
      {error && <p className="mt-1.5 font-mono text-[10px] text-blocked-500">{error}</p>}
    </div>
  );
}

function AssessmentCard({ a }: { a: Assessment }) {
  const [open, setOpen] = useState(false);
  const detail = useQuery({
    ...modelenceQuery<FindingsPayload>('risk.findings', { assessmentKey: a.assessmentKey }),
    enabled: open,
  });

  return (
    <div className="animate-fade-in rounded-lg border border-line bg-ink-700">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full flex-wrap items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-ink-600/50"
      >
        <Tag value={a.verdict} tone={VERDICT_TONE[a.verdict]} />
        <span className="font-mono text-xs text-fg">{a.subjectId}</span>
        <span className="font-mono text-[11px] text-fg-faint">{a.proposedAction}</span>
        <span className="font-mono text-[11px] text-fg-muted">
          {usd(a.proposedSizeUsd)} → {usd(a.permittedSizeUsd)}
        </span>
        <Tag value={a.permittedExecutionMode} tone={a.permittedExecutionMode === 'NONE' ? 'neutral' : 'warn'} />
        <ChevronDown
          className={cn(
            'ml-auto size-4 shrink-0 text-fg-faint transition-transform duration-200',
            open && 'rotate-180'
          )}
        />
      </button>

      <div className="border-t border-line px-4 py-3">
        <p className="text-sm leading-relaxed text-fg-muted">{a.rationale}</p>
        <p className="mt-1 font-mono text-[10px] text-fg-faint">
          decisive rule {a.decisiveRuleId ?? '—'} · {a.findingCount} findings ·{' '}
          {a.blockingFindingCount} blocking · {a.citedObservationCount} observation(s) cited
        </p>
        {a.restrictions.length > 0 && (
          <ul className="mt-2 space-y-0.5">
            {a.restrictions.map((r) => (
              <li key={r} className="font-mono text-[10px] leading-snug text-inferred-500">
                restriction: {r}
              </li>
            ))}
          </ul>
        )}
      </div>

      {open && (
        <div className="animate-slide-up space-y-4 border-t border-line bg-ink-800/60 px-4 py-3">
          {detail.isLoading && (
            <p className="font-mono text-xs text-fg-faint">Loading rule-by-rule findings…</p>
          )}

          {detail.data && (
            <>
              <div>
                <p className="label-caps">Every rule, evaluated — most restrictive wins</p>
                <div className="mt-1.5 space-y-1.5">
                  {detail.data.findings.map((f) => (
                    <div
                      key={f.findingKey}
                      className={cn(
                        'rounded-sm border px-3 py-2',
                        f.verdict === 'BLOCKED'
                          ? 'border-blocked-500/30 bg-blocked-soft/30'
                          : f.verdict === 'REQUIRES_HUMAN_APPROVAL'
                            ? 'border-caution-500/25 bg-caution-soft/20'
                            : 'border-line bg-ink-700'
                      )}
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <Tag value={f.verdict} tone={VERDICT_TONE[f.verdict]} />
                        <span className="font-mono text-[11px] text-fg">{f.ruleId}</span>
                        <span className="font-mono text-[10px] text-fg-faint">{f.domain}</span>
                        <span className="ml-auto font-mono text-[10px] text-fg-faint">
                          {f.policyKey} · {f.overridable ? 'overridable' : 'not overridable'}
                        </span>
                      </div>
                      <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{f.finding}</p>
                      {f.evidence.length > 0 && (
                        <ul className="mt-1 space-y-0.5">
                          {f.evidence.map((e) => (
                            <li key={e} className="font-mono text-[10px] leading-snug text-fg-faint">
                              · {e}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              </div>

              {detail.data.overrides.length > 0 && (
                <div>
                  <p className="label-caps">Human overrides — permanent</p>
                  <ul className="mt-1.5 space-y-1">
                    {detail.data.overrides.map((o, i) => (
                      <li
                        key={`${o.createdAt}-${i}`}
                        className="rounded-sm border border-inferred-500/30 bg-ink-700 px-2.5 py-2"
                      >
                        <div className="flex flex-wrap items-center gap-2">
                          <Tag value={o.decision} tone={o.decision === 'APPROVE' ? 'ok' : 'bad'} />
                          <span className="font-mono text-[10px] text-fg-faint">
                            {o.overriddenVerdict} → {o.resultingVerdict} · {o.actor}
                          </span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-fg-muted">{o.reason}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              <OverridePanel a={a} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

const VERDICT_FILTERS: (Verdict | 'all')[] = [
  'all',
  'APPROVED',
  'APPROVED_WITH_RESTRICTIONS',
  'REQUIRES_HUMAN_APPROVAL',
  'BLOCKED',
];

export default function RiskGatePage() {
  const queryClient = useQueryClient();
  const [verdict, setVerdict] = useState<Verdict | 'all'>('all');
  const [showPolicies, setShowPolicies] = useState(false);

  const overview = useQuery(modelenceQuery<Overview>('risk.overview', {}));
  const assessments = useQuery(
    modelenceQuery<Assessment[]>('risk.assessments', verdict === 'all' ? {} : { verdict })
  );
  const policies = useQuery({
    ...modelenceQuery<Policy[]>('risk.policies', {}),
    enabled: showPolicies,
  });

  const { mutate: runCycle, isPending } = useMutation({
    ...modelenceMutation('risk.runCycle'),
    onSuccess: () => queryClient.invalidateQueries(),
  });

  const o = overview.data;

  return (
    <Page
      seo={{ title: 'Risk Gate — QUORUM' }}
      isLoading={overview.isLoading && assessments.isLoading}
    >
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="label-caps">Governance engine · stage 6</p>
            <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight">Risk gate</h1>
            <p className="mt-1 max-w-2xl text-sm leading-relaxed text-fg-muted">
              One chokepoint, shared by every business line. No module carries its own risk logic —
              trading, private equity, private credit, banking and AUM route through this ruleset or
              they do not act.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowPolicies((v) => !v)}
              className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs text-fg-muted transition-colors hover:border-line-strong hover:text-fg"
            >
              <Scale className="size-3.5" />
              {showPolicies ? 'Hide ruleset' : 'Ruleset in force'}
            </button>
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
              Run gate cycle
            </button>
          </div>
        </header>

        <div className="flex animate-fade-in items-start gap-3 rounded-lg border border-line bg-ink-700 px-4 py-3 text-sm text-fg-muted">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-signal-400" />
          <p className="leading-relaxed">
            Findings are never averaged or scored — the most restrictive verdict across all rules
            becomes the verdict, and the rule that produced it is named. Validation is re-checked
            here as a rule rather than assumed by the caller, so consensus cannot route around it.
            Blocking requires less evidence than acting: a missing depth observation is itself a
            finding.
          </p>
        </div>

        {o && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric
              label="Assessments"
              value={o.counts.assessments}
              hint={o.engineVersion}
            />
            <Metric label="Findings" value={o.counts.findings} hint={`${o.counts.policies} rules in force`} />
            <Metric
              label="Awaiting a human"
              value={o.byVerdict.find((v) => v.verdict === 'REQUIRES_HUMAN_APPROVAL')?.count ?? 0}
              hint="cannot execute until decided"
            />
            <Metric
              label="Blocked"
              value={o.byVerdict.find((v) => v.verdict === 'BLOCKED')?.count ?? 0}
              hint={`${o.counts.overrides} human override(s) on record`}
            />
          </div>
        )}

        {showPolicies && (
          <section className="animate-slide-up rounded-lg border border-line bg-ink-700">
            <div className="border-b border-line px-4 py-2.5">
              <p className="label-caps">Ruleset in force — versioned, mirrored from code</p>
            </div>
            <div className="divide-y divide-line">
              {policies.isLoading && (
                <p className="px-4 py-3 font-mono text-xs text-fg-faint">Loading ruleset…</p>
              )}
              {policies.data?.map((p) => (
                <div key={p.policyKey} className="px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <Tag value={p.maxVerdict} tone={VERDICT_TONE[p.maxVerdict]} />
                    <span className="font-mono text-[11px] text-fg">{p.title}</span>
                    <span className="font-mono text-[10px] text-fg-faint">{p.domain}</span>
                    <span className="ml-auto font-mono text-[10px] text-fg-faint">
                      {p.policyKey} · {p.overridable ? 'overridable' : 'not overridable'}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs leading-relaxed text-fg-muted">{p.statement}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-fg-faint">{p.rationale}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {o && (
          <section className="animate-fade-in rounded-lg border border-line bg-ink-700">
            <div className="border-b border-line px-4 py-2.5">
              <p className="label-caps">Findings by risk domain</p>
            </div>
            <div className="grid gap-2 p-4 sm:grid-cols-2 lg:grid-cols-4">
              {o.byDomain.map((d) => {
                const total = d.blocked + d.human + d.restricted + d.approved;
                return (
                  <div key={d.domain} className="rounded-sm border border-line bg-ink-800/60 p-3">
                    <p className="font-mono text-[11px] text-fg">{d.domain.replace(/_/g, ' ')}</p>
                    <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-ink-600">
                      {total > 0 && (
                        <>
                          <div
                            className="bg-blocked-500 transition-all duration-500"
                            style={{ width: `${(d.blocked / total) * 100}%` }}
                          />
                          <div
                            className="bg-caution-500 transition-all duration-500"
                            style={{ width: `${(d.human / total) * 100}%` }}
                          />
                          <div
                            className="bg-inferred-500 transition-all duration-500"
                            style={{ width: `${(d.restricted / total) * 100}%` }}
                          />
                          <div
                            className="bg-verified-500 transition-all duration-500"
                            style={{ width: `${(d.approved / total) * 100}%` }}
                          />
                        </>
                      )}
                    </div>
                    <p className="mt-1.5 font-mono text-[10px] text-fg-faint">
                      {d.blocked} blocked · {d.human} human · {d.restricted} restricted ·{' '}
                      {d.approved} clear
                    </p>
                  </div>
                );
              })}
            </div>
          </section>
        )}

        <div className="flex flex-wrap gap-1.5">
          {VERDICT_FILTERS.map((v) => (
            <button
              key={v}
              onClick={() => setVerdict(v)}
              className={cn(
                'rounded-md border px-2.5 py-1.5 font-mono text-[11px] tracking-wide transition-colors',
                verdict === v
                  ? 'border-signal-600 bg-signal-soft text-signal-400'
                  : 'border-line text-fg-muted hover:border-line-strong hover:text-fg'
              )}
            >
              {v === 'all' ? 'ALL' : v.replace(/_/g, ' ')}
              {o && v !== 'all' && (
                <span className="ml-1.5 text-fg-faint">
                  {o.byVerdict.find((b) => b.verdict === v)?.count ?? 0}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="space-y-2">
          {assessments.data?.length === 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-line bg-ink-700 px-4 py-6 text-sm text-fg-muted">
              <ShieldCheck className="mt-0.5 size-4 shrink-0 text-fg-faint" />
              <p className="leading-relaxed">
                Nothing to assess in this verdict. The gate only sees strategies that validation
                promoted to paper or beyond — an empty gate usually means validation is doing its
                job, not that the gate is broken.
              </p>
            </div>
          )}
          {assessments.data?.map((a) => (
            <AssessmentCard key={a.assessmentKey} a={a} />
          ))}
        </div>
      </div>
    </Page>
  );
}
