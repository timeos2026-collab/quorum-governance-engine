import { dbObservations, dbJobRuns } from '../evidence/db';
import { dbTokens, dbJurisdictions, type Verifiability } from '../registry/db';
import { dbAgents, dbTheses, type Stance } from './db';
import {
  AGENT_GENERATOR_VERSION,
  CORE_AGENTS,
  type AgentDefinition,
  type ObservationRef,
  type SubjectContext,
} from './roster';

/**
 * THESIS RUN ORCHESTRATOR
 *
 * One write path for theses, on the same append-only job ledger as ingestion.
 * A thesis run is deterministic: same runKey + same evidence ⇒ identical theses,
 * and a replayed runKey writes nothing.
 *
 * The evidence window is bounded by an explicit `asOf`, so a thesis is always
 * formed over "the evidence visible at that moment" and can be re-derived later
 * even after newer observations arrive.
 */

const JOB_ID = 'agents.thesis';

/** Confidence ceiling implied by the weakest evidence a thesis leans on. */
const VERIFIABILITY_CAP: Record<Verifiability, number> = {
  verified: 100,
  inferred: 75,
  model_inference: 65,
  assumption: 50,
  unverified: 40,
  social_claim: 40,
};

const VERIFIABILITY_RANK: Record<Verifiability, number> = {
  verified: 0,
  inferred: 1,
  model_inference: 2,
  assumption: 3,
  unverified: 4,
  social_claim: 5,
};

export function thesisRunKey(at: Date, bucketMs: number) {
  return `thesis:${Math.floor(at.getTime() / bucketMs)}`;
}

/**
 * Builds one context per token from the latest observation per metric, bounded
 * by `asOf`. Nothing here invents data — a missing metric stays missing so the
 * agent can declare it as a gap.
 */
async function buildContexts(asOf: Date, lookbackMs: number) {
  const windowStart = new Date(asOf.getTime() - lookbackMs);

  const [tokens, jurisdictions, observations] = await Promise.all([
    dbTokens.fetch({}, { limit: 200 }),
    dbJurisdictions.fetch({}, { limit: 50 }),
    dbObservations.fetch(
      { observedAt: { $gte: windowStart, $lte: asOf } },
      { sort: { observedAt: -1 }, limit: 5000 }
    ),
  ]);

  const jurisdictionById = new Map(
    jurisdictions.map((j) => [
      j.jurisdictionId,
      {
        jurisdictionId: j.jurisdictionId,
        requiresPreApproval: j.requiresPreApproval,
        exchangeControlFlag: j.exchangeControlFlag,
      },
    ])
  );

  // Sorted newest-first, so the first sighting of an (entity, metric) pair wins.
  const latest = new Map<string, ObservationRef>();
  for (const o of observations) {
    const key = `${o.relevantEntityId}::${o.metric}`;
    if (latest.has(key)) continue;
    latest.set(key, {
      observationKey: o.observationKey,
      metric: o.metric,
      value: o.value ?? null,
      unit: o.unit ?? null,
      statement: o.statement,
      verifiability: o.verifiability as Verifiability,
      dataOrigin: o.dataOrigin,
      observedAt: o.observedAt,
      sourceType: o.sourceType,
    });
  }

  function metricsFor(entityId: string) {
    const out: Record<string, ObservationRef> = {};
    for (const [key, ref] of latest) {
      const [id, metric] = key.split('::');
      if (id === entityId) out[metric] = ref;
    }
    return out;
  }

  const contexts: SubjectContext[] = tokens.map((t) => ({
    tokenId: t.tokenId,
    symbol: t.symbol,
    category: t.category,
    tier: t.tier,
    chainId: t.chainId,
    liquidityLockStatus: t.liquidityLockStatus,
    lpLockExpiry: t.lpLockExpiry ?? null,
    devWalletPct: t.devWalletPct ?? null,
    top10HolderPct: t.top10HolderPct ?? null,
    contractAuditStatus: t.contractAuditStatus,
    honeypotCheckResult: t.honeypotCheckResult,
    regulatoryStatus: t.regulatoryStatus,
    capitalOriginJurisdictionId: t.capitalOriginJurisdictionId ?? null,
    liquidityVenueJurisdictionId: t.liquidityVenueJurisdictionId ?? null,
    byMetric: metricsFor(t.tokenId),
    chainByMetric: metricsFor(t.chainId),
    jurisdiction: t.liquidityVenueJurisdictionId
      ? jurisdictionById.get(t.liquidityVenueJurisdictionId) ?? null
      : null,
  }));

  return { contexts, windowStart };
}

export type ThesisRunResult = {
  jobRunId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  written: number;
  skipped: number;
  errors: string[];
};

export async function runThesisCycle({
  runKey,
  trigger,
  triggeredBy,
  asOf = new Date(),
  lookbackMs = 24 * 60 * 60 * 1000,
}: {
  runKey: string;
  trigger: 'cron' | 'manual';
  triggeredBy?: string;
  asOf?: Date;
  lookbackMs?: number;
}): Promise<ThesisRunResult> {
  const existing = await dbJobRuns.findOne({ jobId: JOB_ID, runKey });
  if (existing) {
    return {
      jobRunId: existing._id.toString(),
      status: 'skipped',
      written: 0,
      skipped: existing.observationsWritten,
      errors: [],
    };
  }

  const startedAt = new Date();
  const { insertedId } = await dbJobRuns.insertOne({
    jobId: JOB_ID,
    runKey,
    trigger,
    triggeredBy,
    startedAt,
    status: 'running',
    inputSnapshot: JSON.stringify({
      runKey,
      asOf: asOf.toISOString(),
      lookbackMs,
      agents: CORE_AGENTS.map((a) => `${a.agentId}@${a.agentVersion}`),
    }),
    outputSummary: '',
    observationsWritten: 0,
    observationsSkipped: 0,
    errors: [],
    generatorVersion: AGENT_GENERATOR_VERSION,
    sourceCoverage: [],
    dataOrigin: 'simulated',
  });
  const jobRunId = insertedId.toString();

  const errors: string[] = [];
  let written = 0;
  let skipped = 0;
  const coverage = new Set<string>();

  try {
    const enabledRows = await dbAgents.fetch({ enabled: false }, { limit: 50 });
    const disabled = new Set(enabledRows.map((r) => r.agentId));
    const active = CORE_AGENTS.filter((a) => !disabled.has(a.agentId));

    const { contexts, windowStart } = await buildContexts(asOf, lookbackMs);

    for (const ctx of contexts) {
      for (const agent of active) {
        try {
          const result = runAgent(agent, ctx);
          coverage.add(agent.agentId);

          const thesisKey = `${JOB_ID}:${runKey}:${agent.agentId}:${ctx.tokenId}`;
          await dbTheses.insertOne({
            thesisKey,
            agentId: agent.agentId,
            agentVersion: agent.agentVersion,
            discipline: agent.discipline,
            subjectType: 'token',
            subjectId: ctx.tokenId,
            stance: result.stance,
            confidence: result.confidence,
            confidenceCap: result.cap,
            confidenceCapReason: result.capReason,
            rationale: result.rationale,
            falsifiableCondition: result.falsifiableCondition,
            weakestLink: result.weakestLink,
            citedObservationKeys: result.citedKeys,
            citedObservationCount: result.citedKeys.length,
            evidenceGaps: result.evidenceGaps,
            weakestVerifiability: result.weakestVerifiability,
            evidenceOrigins: result.evidenceOrigins,
            evidenceWindowStart: windowStart,
            evidenceWindowEnd: asOf,
            status: 'ACTIVE',
            jobRunId,
            runKey,
            generatorVersion: AGENT_GENERATOR_VERSION,
            dataOrigin: result.evidenceOrigins.includes('ingested')
              ? 'ingested'
              : 'simulated',
            createdAt: startedAt,
          });
          written++;
        } catch (e) {
          const message = (e as Error).message ?? String(e);
          if (message.includes('E11000') || message.toLowerCase().includes('duplicate')) {
            skipped++;
          } else {
            errors.push(`${agent.agentId}/${ctx.tokenId}: ${message}`);
          }
        }
      }
    }

    const endedAt = new Date();
    await dbJobRuns.updateOne(
      { _id: insertedId },
      {
        $set: {
          endedAt,
          status: errors.length > 0 ? 'failed' : 'succeeded',
          observationsWritten: written,
          observationsSkipped: skipped,
          errors,
          sourceCoverage: [...coverage],
          outputSummary: `${written} theses written, ${skipped} already present, ${errors.length} errors from ${coverage.size} agents across ${contexts.length} subjects in ${endedAt.getTime() - startedAt.getTime()}ms.`,
        },
      }
    );

    return {
      jobRunId,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      written,
      skipped,
      errors,
    };
  } catch (e) {
    const message = (e as Error).message ?? String(e);
    await dbJobRuns.updateOne(
      { _id: insertedId },
      {
        $set: {
          endedAt: new Date(),
          status: 'failed',
          observationsWritten: written,
          observationsSkipped: skipped,
          errors: [...errors, message],
          sourceCoverage: [...coverage],
          outputSummary: `Thesis run aborted: ${message}`,
        },
      }
    );
    return { jobRunId, status: 'failed', written, skipped, errors: [...errors, message] };
  }
}

/**
 * Applies the engine-level rules on top of whatever the agent proposed. These
 * are not the agent's to negotiate:
 *  - no citations ⇒ forced ABSTAIN at zero confidence
 *  - confidence clamped by the agent ceiling and by weakest verifiability
 *  - thin citation counts are explicitly penalised
 */
export function runAgent(agent: AgentDefinition, ctx: SubjectContext) {
  const raw = agent.reason(ctx);
  const cited = raw.cited.filter(Boolean);
  const citedKeys = cited.map((c) => c.observationKey);

  const weakestVerifiability: Verifiability = cited.length
    ? cited.reduce<Verifiability>(
        (worst, c) =>
          VERIFIABILITY_RANK[c.verifiability] > VERIFIABILITY_RANK[worst] ? c.verifiability : worst,
        'verified'
      )
    : 'unverified';

  const evidenceOrigins = [...new Set(cited.map((c) => c.dataOrigin))];

  // No evidence, no assertion.
  if (citedKeys.length === 0) {
    return {
      stance: 'ABSTAIN' as Stance,
      confidence: 0,
      cap: 0,
      capReason: 'No cited evidence — an agent may not assert beyond its evidence.',
      rationale: raw.rationale,
      falsifiableCondition: raw.falsifiableCondition,
      weakestLink: raw.weakestLink,
      citedKeys,
      evidenceGaps: raw.evidenceGaps,
      weakestVerifiability,
      evidenceOrigins,
    };
  }

  const caps: { value: number; reason: string }[] = [
    { value: agent.maxConfidence, reason: `${agent.name} ceiling (${agent.maxConfidence})` },
    {
      value: VERIFIABILITY_CAP[weakestVerifiability],
      reason: `weakest cited evidence is "${weakestVerifiability}"`,
    },
  ];
  /**
   * ASYMMETRIC EVIDENCE BURDEN.
   *
   * The thin-citation penalty applies to theses that argue FOR taking exposure.
   * A block is a refusal to act, and a refusal needs less evidence than an
   * action, not more — otherwise a single decisive sanctions hit or rule breach
   * gets discounted into irrelevance. Blocks are still capped by verifiability
   * and by the agent's own ceiling; they are simply not penalised for being
   * based on one decisive fact.
   */
  if (citedKeys.length < 2 && raw.stance !== 'BLOCK_RECOMMENDED') {
    caps.push({ value: 45, reason: 'single-observation thesis' });
  }

  const binding = caps.reduce((a, b) => (b.value < a.value ? b : a));
  const confidence = Math.max(0, Math.min(Math.round(raw.confidence), binding.value));

  return {
    stance: raw.stance,
    confidence,
    cap: binding.value,
    capReason:
      confidence === binding.value
        ? `Capped at ${binding.value}: ${binding.reason}.`
        : `Ceiling ${binding.value} (${binding.reason}); not binding.`,
    rationale: raw.rationale,
    falsifiableCondition: raw.falsifiableCondition,
    weakestLink: raw.weakestLink,
    citedKeys,
    evidenceGaps: raw.evidenceGaps,
    weakestVerifiability,
    evidenceOrigins,
  };
}
