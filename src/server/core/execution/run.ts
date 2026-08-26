import { dbJobRuns, dbObservations } from '../evidence/db';
import { dbTokens } from '../registry/db';
import { dbStrategies, dbValidationTests } from '../validation/db';
import {
  dbRiskAssessments,
  dbRiskFindings,
  dbRiskOverrides,
  mostRestrictive,
  type RiskVerdict,
} from '../risk/db';
import {
  dbExecutionFills,
  dbExecutionOrders,
  leastPermissiveMode,
  OBSERVED_EVIDENCE_TESTS,
  type ExecutionMode,
  type OrderStatus,
} from './db';

/**
 * PAPER / SHADOW EXECUTION ORCHESTRATOR
 *
 * Consumes risk-gate assessments and produces orders and synthetic fills.
 *
 * What this stage will NOT do:
 *  - act on a BLOCKED or REQUIRES_HUMAN_APPROVAL assessment (zero orders);
 *  - trust that the caller checked validation (it re-checks, inline);
 *  - re-implement a risk rule (it reads findings and obeys them);
 *  - grant PRODUCTION on a derived track record alone;
 *  - fetch a price.
 */

export const EXECUTION_GENERATOR_VERSION = 'execution-synth@1.0.0';
const JOB_ID = 'execution.paper';
const LOOKBACK_MS = 1000 * 60 * 60 * 24;
export const EMBARGO_HOURS = 48;

/** Business lines whose exposure always serves the full paper embargo. */
const EMBARGOED_MODULE_SCOPES = ['privateEquity', 'private_equity', 'pre-launch', 'preLaunch'];

/**
 * Deterministic run key.
 *
 * The override count is part of the key so that a human decision on a pending
 * assessment can actually take effect on the next cycle. Without it, the first
 * pass would permanently claim the key and every later cycle would replay to a
 * no-op — the human's decision would be recorded and then silently ignored.
 * With it, a cycle is still idempotent for a given state of the world: same
 * gate run + same overrides ⇒ same key ⇒ zero new rows.
 */
export function paperRunKey(riskRunKey: string, overrideCount = 0) {
  return overrideCount > 0 ? `paper:${riskRunKey}:ov${overrideCount}` : `paper:${riskRunKey}`;
}

/** FNV-1a. Same primitive as the evidence generators, kept local on purpose:
 *  execution must not accidentally inherit a future change to that module. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rand(seed: string): number {
  let t = hashString(seed) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Deterministic SYNTHETIC fill price. A pure function of (orderKey, symbol) —
 * the same order always fills at the same price, on any machine, forever.
 * This is not a market price and is never labelled as one.
 */
export function syntheticFillPrice(orderKey: string, symbol: string): number {
  const magnitude = 10 ** (Math.floor(rand(`${symbol}:magnitude`) * 5) - 2);
  const base = (0.5 + rand(`${orderKey}:${symbol}:price`)) * magnitude;
  return Math.round(base * 1e6) / 1e6;
}

export function syntheticFillRatio(orderKey: string): number {
  // Most orders fill whole; a minority fill partially. Deterministic either way.
  const r = rand(`${orderKey}:fillratio`);
  return r < 0.75 ? 1 : Math.round((0.35 + r * 0.5) * 100) / 100;
}

/** Latest risk-gate run, or null. */
export async function latestRiskRunKey(): Promise<string | null> {
  const [latest] = await dbRiskAssessments.fetch({}, { sort: { createdAt: -1 }, limit: 1 });
  return latest?.runKey ?? null;
}

export type PaperCycleResult = {
  jobRunId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  ordersCreated: number;
  ordersHeld: number;
  fillsCreated: number;
  refusedNonApproving: number;
  refusedValidation: number;
  errors: string[];
};

type ModeDecision = {
  mode: ExecutionMode;
  reason: string;
  restriction?: string;
};

/**
 * PRODUCTION gate. Three observed-evidence tests must ALL be present and PASS
 * on the strategy's most recent validation run. A clean derived track record is
 * explicitly not a substitute — those tests describe a synthetic history, and a
 * synthetic history cannot authorise real capital.
 */
async function decideMode(
  strategyKey: string,
  lastValidationRunKey: string | undefined,
  strategyState: string,
  gateMode: string
): Promise<ModeDecision> {
  const lifecycleCeiling: ExecutionMode =
    strategyState === 'PRODUCTION' ? 'PRODUCTION' : strategyState === 'SHADOW' ? 'SHADOW' : 'PAPER';

  const gateCeiling: ExecutionMode =
    gateMode === 'PRODUCTION' ? 'PRODUCTION' : gateMode === 'SHADOW' ? 'SHADOW' : 'PAPER';

  let ceiling = leastPermissiveMode([lifecycleCeiling, gateCeiling]);
  const notes = [
    `lifecycle state ${strategyState} permits ${lifecycleCeiling}`,
    `risk gate permits ${gateCeiling}`,
  ];

  if (ceiling !== 'PRODUCTION') {
    return { mode: ceiling, reason: `Capped at ${ceiling}: ${notes.join('; ')}.` };
  }

  // Only now is the observed-evidence check even relevant.
  const validationKey = lastValidationRunKey ? `${strategyKey}:${lastValidationRunKey}` : null;
  const tests = validationKey
    ? await dbValidationTests.fetch(
        { validationKey, type: { $in: [...OBSERVED_EVIDENCE_TESTS] } },
        { limit: 10 }
      )
    : [];

  const byType = new Map(tests.map((t) => [t.type, t]));
  const failing = OBSERVED_EVIDENCE_TESTS.filter((t) => byType.get(t)?.result !== 'PASS');

  if (failing.length > 0) {
    ceiling = 'PAPER';
    const detail = failing
      .map((t) => `${t}=${byType.get(t)?.result ?? 'MISSING'}`)
      .join(', ');
    return {
      mode: 'PAPER',
      reason: `PRODUCTION blocked: observed-evidence tests not clean — 3/3 required, ${OBSERVED_EVIDENCE_TESTS.length - failing.length}/3 clean (${detail}). The survivorship, walk-forward and regime tests are DERIVED TRACK RECORD and cannot substitute; only SLIPPAGE_ON_REAL_DEPTH, WASH_ADJUSTED_VOLUME and ADVERSARIAL_RED_TEAM are FROM OBSERVED EVIDENCE.`,
      restriction: 'PRODUCTION blocked: observed-evidence tests not clean — 3/3 required',
    };
  }

  return {
    mode: 'PRODUCTION',
    reason: `All three FROM OBSERVED EVIDENCE tests PASS on ${validationKey}; ${notes.join('; ')}.`,
  };
}

export async function runPaperCycle({
  riskRunKey,
  trigger,
  triggeredBy,
}: {
  riskRunKey: string;
  trigger: 'cron' | 'manual';
  triggeredBy?: string;
}): Promise<PaperCycleResult> {
  const overrideCount = await dbRiskOverrides.countDocuments({});
  const runKey = paperRunKey(riskRunKey, overrideCount);

  const existing = await dbJobRuns.findOne({ jobId: JOB_ID, runKey });
  if (existing) {
    // Replay is a provable no-op: the ledger already owns this run key.
    return {
      jobRunId: existing._id.toString(),
      status: 'skipped',
      ordersCreated: 0,
      ordersHeld: 0,
      fillsCreated: 0,
      refusedNonApproving: 0,
      refusedValidation: 0,
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
      riskRunKey,
      overrideCount,
      generatorVersion: EXECUTION_GENERATOR_VERSION,
    }),
    outputSummary: '',
    observationsWritten: 0,
    observationsSkipped: 0,
    errors: [],
    generatorVersion: EXECUTION_GENERATOR_VERSION,
    sourceCoverage: [],
    dataOrigin: 'simulated',
  });
  const jobRunId = insertedId.toString();

  const errors: string[] = [];
  const coverage = new Set<string>();
  let ordersCreated = 0;
  let ordersHeld = 0;
  let fillsCreated = 0;
  let refusedNonApproving = 0;
  let refusedValidation = 0;

  try {
    // ---- PHASE 1: turn approving assessments into orders -------------------
    const assessments = await dbRiskAssessments.fetch({ runKey: riskRunKey }, { limit: 500 });

    for (const a of assessments) {
      try {
        // A human APPROVE on a REQUIRES_HUMAN_APPROVAL assessment is the one
        // thing that can change the effective verdict. The assessment itself is
        // never edited — the override is a separate permanent record, and this
        // is where it is read. BLOCKED is unreachable here by construction: the
        // gate refuses to write an override against it at all.
        const [override] = await dbRiskOverrides.fetch(
          { assessmentKey: a.assessmentKey },
          { sort: { createdAt: -1 }, limit: 1 }
        );
        const effectiveVerdict: RiskVerdict = override ? override.resultingVerdict : a.verdict;
        const verdictProvenance = override
          ? `${a.verdict} → ${effectiveVerdict} by human override (${override.actor})`
          : a.verdict;

        // Only the two approving verdicts produce anything at all.
        if (effectiveVerdict !== 'APPROVED' && effectiveVerdict !== 'APPROVED_WITH_RESTRICTIONS') {
          refusedNonApproving++;
          continue;
        }

        const orderKey = `execution:${a.assessmentKey}`;
        if (await dbExecutionOrders.findOne({ orderKey })) continue;

        const strategy = await dbStrategies.findOne({ strategyKey: a.strategyKey });
        if (!strategy) {
          errors.push(`${a.assessmentKey}: strategy ${a.strategyKey} missing.`);
          continue;
        }

        // (a) VALIDATION_PREREQUISITE, re-verified inline. Execution does not
        // take the gate's word for it any more than the gate took validation's.
        if (!['PAPER', 'SHADOW', 'PRODUCTION'].includes(strategy.state)) {
          refusedValidation++;
          coverage.add('VALIDATION_PREREQUISITE');
          continue;
        }

        const token = await dbTokens.findOne({ tokenId: a.subjectId });
        if (!token) {
          errors.push(`${a.assessmentKey}: subject ${a.subjectId} not in registry.`);
          continue;
        }
        const tier = (token.tier === 1 || token.tier === 2 ? token.tier : 3) as 1 | 2 | 3;

        // ---- (c) size caps -------------------------------------------------
        const findings = await dbRiskFindings.fetch({ assessmentKey: a.assessmentKey }, { limit: 50 });
        const byRule = new Map(findings.map((f) => [f.ruleId, f]));

        const observations = await dbObservations.fetch(
          {
            relevantEntityId: a.subjectId,
            metric: 'pool_depth_2pct_usd',
            observedAt: { $gte: new Date(startedAt.getTime() - LOOKBACK_MS) },
          },
          { sort: { observedAt: -1 }, limit: 1 }
        );
        const depthObs = observations[0];
        const requiresHumanForDepth = !depthObs || depthObs.value === undefined;

        const tierCeiling = tier === 1 ? 500_000 : tier === 2 ? 100_000 : 15_000;
        const capitalFinding = byRule.get('CAPITAL_ORIGIN_VENUE_MISMATCH');
        const capitalCapFired = !!capitalFinding && capitalFinding.verdict !== 'APPROVED';
        const capitalCap = capitalCapFired ? 50_000 : Number.POSITIVE_INFINITY;
        const depthCap = requiresHumanForDepth
          ? Number.POSITIVE_INFINITY
          : (depthObs!.value as number);

        const candidates = [
          {
            ruleId: 'TIER_POSITION_CEILING',
            capUsd: tierCeiling,
            note: `Tier ${tier} ceiling.`,
          },
          {
            ruleId: 'CAPITAL_ORIGIN_VENUE_MISMATCH',
            capUsd: capitalCap,
            note: capitalCapFired
              ? 'Exchange-control cap on outward deployment of controlled capital.'
              : 'Capital origin and liquidity venue aligned; no cap.',
          },
          {
            ruleId: 'EXIT_DEPTH_SUFFICIENCY',
            capUsd: depthCap,
            note: requiresHumanForDepth
              ? 'No 2% depth observation; no depth-derived cap can be computed.'
              : `Observed 2% pool depth ${depthObs!.observationKey}.`,
          },
        ];

        const requested = a.proposedSizeUsd;
        const permittedSizeUsd = Math.min(requested, ...candidates.map((c) => c.capUsd));

        const bindingRules = candidates
          .filter((c) => Number.isFinite(c.capUsd) && c.capUsd === permittedSizeUsd)
          .map((c) => c.ruleId);

        // Verdict governing the size decision: most restrictive among the
        // findings that actually bound it. Never a sum, never an average.
        const contributingVerdicts = bindingRules
          .map((r) => byRule.get(r)?.verdict)
          .filter((v): v is RiskVerdict => !!v);
        const governingVerdict = mostRestrictive(
          contributingVerdicts.length > 0 ? contributingVerdicts : ['APPROVED']
        );

        const sizeCapReason =
          bindingRules.length > 0
            ? `$${permittedSizeUsd.toLocaleString()} set by ${bindingRules.join(' + ')} (governing verdict ${governingVerdict}); requested $${requested.toLocaleString()}.`
            : `Requested $${requested.toLocaleString()} sits below every applicable ceiling; no rule bound the size.`;

        // ---- (d)/(e) mode ---------------------------------------------------
        const modeDecision = await decideMode(
          a.strategyKey,
          strategy.lastValidationRunKey,
          strategy.state,
          a.permittedExecutionMode
        );

        // ---- (b) 48h mandatory paper embargo, wall-clock ---------------------
        const scopeEmbargoed = EMBARGOED_MODULE_SCOPES.some(
          (s) => a.moduleScope.toLowerCase() === s.toLowerCase()
        );
        const embargoed = tier === 3 || scopeEmbargoed;
        const embargoHours = embargoed ? EMBARGO_HOURS : 0;
        const earliestLiveAt = new Date(startedAt.getTime() + embargoHours * 3600_000);
        const embargoReason = embargoed
          ? `${EMBARGO_HOURS}h mandatory paper embargo (${tier === 3 ? 'Tier 3' : `module scope ${a.moduleScope}`}). Measured in wall-clock time, so running the cycle more often does not shorten it.`
          : 'No embargo: not Tier 3 and not a pre-launch scope.';

        const restrictions = [...a.restrictions];
        if (modeDecision.restriction) restrictions.push(modeDecision.restriction);
        if (requiresHumanForDepth) {
          restrictions.push(
            'Held at RISK_CHECK: no observed 2% depth — size cannot be bounded by measured exit.'
          );
        }
        if (embargoed) restrictions.push(`Not submittable before ${earliestLiveAt.toISOString()}.`);

        // Depth unobserved ⇒ held, not approved. Absence of a measurement is
        // never read as an absence of risk.
        const status: OrderStatus = requiresHumanForDepth ? 'RISK_CHECK' : 'APPROVED';
        const statusReason = requiresHumanForDepth
          ? 'No pool-depth observation exists for this subject. The order is held for a human rather than sized on an assumed exit.'
          : `Cleared for ${modeDecision.mode} execution at $${permittedSizeUsd.toLocaleString()}.`;

        await dbExecutionOrders.insertOne({
          orderKey,
          strategyKey: a.strategyKey,
          assessmentKey: a.assessmentKey,
          subjectId: a.subjectId,
          symbol: token.symbol,
          moduleScope: a.moduleScope,
          side: a.stance,
          requestedSizeUsd: requested,
          permittedSizeUsd,
          sizeCapReason,
          sizeCaps: candidates.map((c) => ({
            ruleId: c.ruleId,
            capUsd: Number.isFinite(c.capUsd) ? c.capUsd : -1,
            binding: bindingRules.includes(c.ruleId),
            note: c.note,
          })),
          permittedMode: modeDecision.mode,
          modeReason: modeDecision.reason,
          restrictions,
          sourceVerdict: verdictProvenance,
          decisiveRuleId: a.decisiveRuleId,
          status,
          statusReason,
          earliestLiveAt,
          embargoHours,
          embargoReason,
          requiresHumanForDepth,
          runKey,
          jobRunId,
          generatorVersion: EXECUTION_GENERATOR_VERSION,
          dataOrigin: 'simulated',
          createdAt: startedAt,
          updatedAt: startedAt,
        });

        coverage.add(effectiveVerdict);
        if (requiresHumanForDepth) ordersHeld++;
        else ordersCreated++;
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        if (message.includes('E11000') || message.toLowerCase().includes('duplicate')) continue;
        errors.push(`${a.assessmentKey}: ${message}`);
      }
    }

    // ---- PHASE 2: fill orders whose embargo has actually elapsed -----------
    const fillable = await dbExecutionOrders.fetch(
      { status: 'APPROVED', earliestLiveAt: { $lte: startedAt } },
      { limit: 500 }
    );

    for (const order of fillable) {
      try {
        const fillKey = `fill:${order.orderKey}`;
        if (await dbExecutionFills.findOne({ fillKey })) continue;

        const ratio = syntheticFillRatio(order.orderKey);
        const filledSizeUsd = Math.round(order.permittedSizeUsd * ratio);
        const fillPrice = syntheticFillPrice(order.orderKey, order.symbol);
        const slippageBps = Math.round(rand(`${order.orderKey}:slippage`) * 120);
        const partial = ratio < 1;

        await dbExecutionFills.insertOne({
          fillKey,
          orderKey: order.orderKey,
          strategyKey: order.strategyKey,
          symbol: order.symbol,
          filledSizeUsd,
          fillPrice,
          slippageBps,
          mode: order.permittedMode,
          partial,
          filledAt: startedAt,
          runKey,
          jobRunId,
          generatorVersion: EXECUTION_GENERATOR_VERSION,
          dataOrigin: 'simulated',
          createdAt: startedAt,
        });

        await dbExecutionOrders.updateOne(
          { orderKey: order.orderKey },
          {
            $set: {
              status: partial ? 'PARTIALLY_FILLED' : 'FILLED',
              statusReason: partial
                ? `Synthetic partial fill: $${filledSizeUsd.toLocaleString()} of $${order.permittedSizeUsd.toLocaleString()} permitted.`
                : `Synthetic fill: $${filledSizeUsd.toLocaleString()} at a generated reference price. No market was contacted.`,
              submittedAt: startedAt,
              submittedBy: 'engine:execution.paper',
              updatedAt: startedAt,
            },
          }
        );

        fillsCreated++;
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        if (message.includes('E11000') || message.toLowerCase().includes('duplicate')) continue;
        errors.push(`${order.orderKey}: ${message}`);
      }
    }

    const endedAt = new Date();
    await dbJobRuns.updateOne(
      { _id: insertedId },
      {
        $set: {
          endedAt,
          status: errors.length > 0 ? 'failed' : 'succeeded',
          observationsWritten: ordersCreated + fillsCreated,
          observationsSkipped: refusedNonApproving + refusedValidation,
          errors,
          sourceCoverage: [...coverage],
          outputSummary: `${ordersCreated} order(s) approved, ${ordersHeld} held at RISK_CHECK, ${fillsCreated} synthetic fill(s). Refused ${refusedNonApproving} non-approving assessment(s) and ${refusedValidation} on validation prerequisite. ${errors.length} errors in ${endedAt.getTime() - startedAt.getTime()}ms.`,
        },
      }
    );

    return {
      jobRunId,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      ordersCreated,
      ordersHeld,
      fillsCreated,
      refusedNonApproving,
      refusedValidation,
      errors,
    };
  } catch (e) {
    // The run row is always closed, even on an unexpected throw, so the ledger
    // never leaves a phantom 'running' entry that blocks a future replay.
    const message = (e as Error).message ?? String(e);
    await dbJobRuns.updateOne(
      { _id: insertedId },
      {
        $set: {
          endedAt: new Date(),
          status: 'failed',
          observationsWritten: ordersCreated + fillsCreated,
          errors: [...errors, message],
          sourceCoverage: [...coverage],
          outputSummary: `Paper execution run aborted: ${message}`,
        },
      }
    );
    return {
      jobRunId,
      status: 'failed',
      ordersCreated,
      ordersHeld,
      fillsCreated,
      refusedNonApproving,
      refusedValidation,
      errors: [...errors, message],
    };
  }
}

/**
 * The embargo guard. Called by the submit path. Wall-clock only — there is
 * deliberately no "cycles elapsed" alternative, because a cycle count is
 * something an operator can accelerate.
 */
export function assertSubmittable(
  order: { earliestLiveAt: Date; status: string; embargoHours: number },
  now = new Date()
) {
  if (order.status === 'RISK_CHECK') {
    throw new Error(
      'Order is held at RISK_CHECK. Resolve the open risk finding before submitting; execution will not size a position on an unmeasured exit.'
    );
  }
  if (order.status !== 'APPROVED') {
    throw new Error(`Order is ${order.status}; only an APPROVED order can be submitted.`);
  }
  if (now < order.earliestLiveAt) {
    const hoursLeft = (order.earliestLiveAt.getTime() - now.getTime()) / 3600_000;
    throw new Error(
      `Rejected: ${order.embargoHours}h mandatory paper embargo has not elapsed. ${hoursLeft.toFixed(1)}h remaining until ${order.earliestLiveAt.toISOString()}. This window is wall-clock and cannot be shortened by re-running the cycle.`
    );
  }
}
