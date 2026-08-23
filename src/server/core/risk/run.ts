import { dbJobRuns, dbObservations } from '../evidence/db';
import { dbJurisdictions, dbRegulatoryFacts, dbTokens } from '../registry/db';
import { dbStrategies } from '../validation/db';
import {
  dbRiskAssessments,
  dbRiskFindings,
  dbRiskPolicies,
  mostRestrictive,
  type RiskVerdict,
} from './db';
import {
  RISK_ENGINE_VERSION,
  RISK_RULES,
  policyKeyOf,
  type GateContext,
  type JurisdictionView,
  type ObservationRef,
} from './rules';

/**
 * RISK GATE ORCHESTRATOR
 *
 * Assesses every strategy that has cleared validation. The gate reads the
 * registry and the evidence layer directly — it never accepts a caller's
 * summary of the facts, because the whole point of a chokepoint is that it does
 * not depend on the good behaviour of what is passing through it.
 */

const JOB_ID = 'risk.gate';
const LOOKBACK_MS = 1000 * 60 * 60 * 24;

export function gateRunKey(validationRunKey: string) {
  return `gate:${validationRunKey}`;
}

/** Latest validation run, or null. */
export async function latestValidationRunKey(): Promise<string | null> {
  const [latest] = await dbStrategies.fetch(
    { lastValidationRunKey: { $exists: true } },
    { sort: { updatedAt: -1 }, limit: 1 }
  );
  return latest?.lastValidationRunKey ?? null;
}

/** Mirrors the in-code ruleset into the policy store so it is auditable. */
export async function syncPolicies(): Promise<number> {
  const now = new Date();
  for (const rule of RISK_RULES) {
    await dbRiskPolicies.upsertOne(
      { policyKey: policyKeyOf(rule) },
      {
        $set: {
          ruleId: rule.ruleId,
          version: rule.version,
          domain: rule.domain,
          title: rule.title,
          statement: rule.statement,
          rationale: rule.rationale,
          maxVerdict: rule.maxVerdict,
          overridable: rule.overridable,
          dataOrigin: 'seed',
          updatedAt: now,
        },
        $setOnInsert: { effectiveFrom: now, createdAt: now },
      }
    );
  }
  return RISK_RULES.length;
}

async function jurisdictionView(id?: string): Promise<JurisdictionView | null> {
  if (!id) return null;
  // Latest still-effective assertion for this jurisdiction. Superseded rows are
  // retained, so a past decision can be replayed against what was known then.
  const [j] = await dbJurisdictions.fetch(
    { jurisdictionId: id, effectiveTo: { $exists: false } },
    { sort: { effectiveFrom: -1 }, limit: 1 }
  );
  if (!j) return null;
  return {
    jurisdictionId: j.jurisdictionId,
    name: j.name,
    regimeType: j.regimeType,
    requiresPreApproval: j.requiresPreApproval,
    exchangeControlFlag: j.exchangeControlFlag,
    source: j.source,
    effectiveFrom: j.effectiveFrom,
  };
}

export type GateRunResult = {
  jobRunId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  assessed: number;
  byVerdict: Record<RiskVerdict, number>;
  errors: string[];
};

export async function runGateCycle({
  validationRunKey,
  trigger,
  triggeredBy,
}: {
  validationRunKey: string;
  trigger: 'cron' | 'manual';
  triggeredBy?: string;
}): Promise<GateRunResult> {
  const runKey = gateRunKey(validationRunKey);
  const emptyTally: Record<RiskVerdict, number> = {
    APPROVED: 0,
    APPROVED_WITH_RESTRICTIONS: 0,
    REQUIRES_HUMAN_APPROVAL: 0,
    BLOCKED: 0,
  };

  const existing = await dbJobRuns.findOne({ jobId: JOB_ID, runKey });
  if (existing) {
    return {
      jobRunId: existing._id.toString(),
      status: 'skipped',
      assessed: 0,
      byVerdict: emptyTally,
      errors: [],
    };
  }

  await syncPolicies();

  const startedAt = new Date();
  const { insertedId } = await dbJobRuns.insertOne({
    jobId: JOB_ID,
    runKey,
    trigger,
    triggeredBy,
    startedAt,
    status: 'running',
    inputSnapshot: JSON.stringify({
      validationRunKey,
      engineVersion: RISK_ENGINE_VERSION,
      policies: RISK_RULES.map(policyKeyOf),
    }),
    outputSummary: '',
    observationsWritten: 0,
    observationsSkipped: 0,
    errors: [],
    generatorVersion: RISK_ENGINE_VERSION,
    sourceCoverage: [],
    dataOrigin: 'simulated',
  });
  const jobRunId = insertedId.toString();

  const errors: string[] = [];
  const byVerdict = { ...emptyTally };
  let assessed = 0;
  const coverage = new Set<string>();

  try {
    // The gate assesses everything that cleared validation. It deliberately
    // also re-reads the strategy state itself rather than trusting the filter,
    // via VALIDATION_PREREQUISITE.
    const strategies = await dbStrategies.fetch(
      { state: { $in: ['PAPER', 'SHADOW', 'PRODUCTION'] } },
      { limit: 500 }
    );

    const windowStart = new Date(startedAt.getTime() - LOOKBACK_MS);

    for (const strategy of strategies) {
      const assessmentKey = `${strategy.strategyKey}:${runKey}`;
      if (await dbRiskAssessments.findOne({ assessmentKey })) continue;

      try {
        const token = await dbTokens.findOne({ tokenId: strategy.subjectId });
        if (!token) {
          errors.push(`${strategy.strategyKey}: subject ${strategy.subjectId} not in registry.`);
          continue;
        }

        const observations = await dbObservations.fetch(
          {
            relevantEntityId: { $in: [strategy.subjectId, token.chainId] },
            observedAt: { $gte: windowStart, $lte: startedAt },
          },
          { sort: { observedAt: -1 }, limit: 500 }
        );
        const byMetric = new Map<string, ObservationRef>();
        for (const o of observations) {
          if (byMetric.has(o.metric)) continue;
          byMetric.set(o.metric, {
            observationKey: o.observationKey,
            metric: o.metric,
            value: o.value,
            verifiability: o.verifiability,
            statement: o.statement,
          });
        }

        const [capitalOrigin, liquidityVenue] = await Promise.all([
          jurisdictionView(token.capitalOriginJurisdictionId),
          jurisdictionView(token.liquidityVenueJurisdictionId),
        ]);

        // A pre-approval must exist as a versioned fact about THIS token. The
        // absence of a fact is never read as approval.
        const preApproval = await dbRegulatoryFacts.findOne({
          entityType: 'token',
          entityId: token.tokenId,
          claim: 'pre_approval',
          claimValue: 'granted',
          effectiveTo: { $exists: false },
        });

        const tier = (token.tier === 1 || token.tier === 2 ? token.tier : 3) as 1 | 2 | 3;
        const proposedSizeUsd = tier === 1 ? 500_000 : tier === 2 ? 100_000 : 15_000;

        const ctx: GateContext = {
          strategyKey: strategy.strategyKey,
          subjectId: strategy.subjectId,
          symbol: token.symbol,
          tier,
          category: token.category,
          stance: strategy.stance,
          strategyState: strategy.state,
          proposedSizeUsd,
          liquidityLockStatus: token.liquidityLockStatus,
          regulatoryStatus: token.regulatoryStatus,
          contractAuditStatus: token.contractAuditStatus,
          honeypotCheckResult: token.honeypotCheckResult,
          devWalletPct: token.devWalletPct,
          top10HolderPct: token.top10HolderPct,
          capitalOrigin,
          liquidityVenue,
          hasPreApprovalOnRecord: !!preApproval,
          byMetric,
        };

        const results = RISK_RULES.map((rule) => ({ rule, finding: rule.evaluate(ctx) }));

        // MOST RESTRICTIVE WINS. Findings are never summed or scored — a single
        // BLOCK is not outvoted by eight clean checks.
        const verdict = mostRestrictive(results.map((r) => r.finding.verdict));
        const decisive = results.find((r) => r.finding.verdict === verdict);

        const sizeCaps = results
          .map((r) => r.finding.sizeCapUsd)
          .filter((v): v is number => typeof v === 'number');
        const permittedSizeUsd =
          verdict === 'BLOCKED'
            ? 0
            : Math.min(proposedSizeUsd, ...(sizeCaps.length > 0 ? sizeCaps : [proposedSizeUsd]));

        const permittedExecutionMode =
          verdict === 'BLOCKED' || verdict === 'REQUIRES_HUMAN_APPROVAL'
            ? 'NONE'
            : strategy.state === 'PRODUCTION'
              ? 'PRODUCTION'
              : strategy.state === 'SHADOW'
                ? 'SHADOW'
                : 'PAPER';

        const restrictions = results
          .map((r) => r.finding.restriction)
          .filter((v): v is string => !!v);
        const cited = [
          ...new Set(results.flatMap((r) => r.finding.citedObservationKeys ?? [])),
        ];
        const blocking = results.filter(
          (r) => r.finding.verdict === 'BLOCKED' || r.finding.verdict === 'REQUIRES_HUMAN_APPROVAL'
        );

        await dbRiskAssessments.insertOne({
          assessmentKey,
          strategyKey: strategy.strategyKey,
          subjectId: strategy.subjectId,
          moduleScope: strategy.moduleScope,
          runKey,
          jobRunId,
          proposedAction: `${strategy.stance} ${token.symbol}`,
          proposedSizeUsd,
          stance: strategy.stance,
          verdict,
          decisiveRuleId: decisive?.rule.ruleId,
          rationale:
            verdict === 'APPROVED'
              ? `All ${RISK_RULES.length} rules cleared. Approved for ${permittedExecutionMode.toLowerCase()} execution at $${permittedSizeUsd.toLocaleString()}.`
              : `${decisive?.rule.ruleId} set the verdict: ${decisive?.finding.finding} Findings are not averaged — the most restrictive one governs.`,
          restrictions,
          permittedSizeUsd,
          permittedExecutionMode,
          findingCount: results.length,
          blockingFindingCount: blocking.length,
          policyKeys: RISK_RULES.map(policyKeyOf),
          citedObservationKeys: cited,
          engineVersion: RISK_ENGINE_VERSION,
          dataOrigin: 'simulated',
          createdAt: startedAt,
        });

        for (const { rule, finding } of results) {
          coverage.add(rule.ruleId);
          await dbRiskFindings.insertOne({
            findingKey: `${assessmentKey}:${rule.ruleId}`,
            assessmentKey,
            strategyKey: strategy.strategyKey,
            ruleId: rule.ruleId,
            policyKey: policyKeyOf(rule),
            domain: rule.domain,
            verdict: finding.verdict,
            finding: finding.finding,
            evidence: finding.evidence,
            citedObservationKeys: finding.citedObservationKeys ?? [],
            overridable: rule.overridable,
            createdAt: startedAt,
          });
        }

        byVerdict[verdict]++;
        assessed++;
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        if (message.includes('E11000') || message.toLowerCase().includes('duplicate')) continue;
        errors.push(`${strategy.strategyKey}: ${message}`);
      }
    }

    const endedAt = new Date();
    await dbJobRuns.updateOne(
      { _id: insertedId },
      {
        $set: {
          endedAt,
          status: errors.length > 0 ? 'failed' : 'succeeded',
          observationsWritten: assessed,
          errors,
          sourceCoverage: [...coverage],
          outputSummary: `${assessed} assessed — ${byVerdict.APPROVED} approved, ${byVerdict.APPROVED_WITH_RESTRICTIONS} restricted, ${byVerdict.REQUIRES_HUMAN_APPROVAL} pending human, ${byVerdict.BLOCKED} blocked. ${errors.length} errors in ${endedAt.getTime() - startedAt.getTime()}ms.`,
        },
      }
    );

    return {
      jobRunId,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      assessed,
      byVerdict,
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
          observationsWritten: assessed,
          errors: [...errors, message],
          sourceCoverage: [...coverage],
          outputSummary: `Risk gate run aborted: ${message}`,
        },
      }
    );
    return { jobRunId, status: 'failed', assessed, byVerdict, errors: [...errors, message] };
  }
}
