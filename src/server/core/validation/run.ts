import { dbJobRuns, dbObservations } from '../evidence/db';
import { dbTokens } from '../registry/db';
import { dbDebateOutcomes, dbDebates } from '../debate/db';
import {
  dbStrategies,
  dbStrategyTransitions,
  dbValidationRuns,
  dbValidationTests,
  AUTOMATED_TRANSITIONS,
  type StrategyState,
} from './db';
import {
  VALIDATION_ENGINE_VERSION,
  intendedSizeForTier,
  runAllTests,
  verdictFor,
  type ObservationView,
  type StrategyContext,
} from './harness';

/**
 * VALIDATION RUN ORCHESTRATOR
 *
 * Two jobs in one cycle, in strict order:
 *  1. PROMOTE debate outcomes into strategy candidates. Only an actionable
 *     directional consensus becomes a candidate. A blocked, contested or
 *     evidence-starved debate produces nothing to validate — "we could not
 *     agree" is not a strategy, and turning it into one is how a governance
 *     engine manufactures activity out of uncertainty.
 *  2. TEST every candidate sitting at DISCOVERED or UNDER_TEST.
 *
 * Same append-only ledger and skip-on-existing-runKey semantics as every other
 * stage, so a replay is a provable no-op rather than a second opinion.
 */

const JOB_ID = 'validation.cycle';
const LOOKBACK_MS = 1000 * 60 * 60 * 24;

export function validationRunKey(debateRunKey: string) {
  return `validate:${debateRunKey}`;
}

/** Most recent debate run, or null if debate has never run. */
export async function latestDebateRunKey(): Promise<string | null> {
  const [latest] = await dbDebates.fetch({}, { sort: { openedAt: -1 }, limit: 1 });
  return latest?.runKey ?? null;
}

export type ValidationRunResult = {
  jobRunId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  candidatesCreated: number;
  validated: number;
  passed: number;
  failed: number;
  held: number;
  errors: string[];
};

/** Records a lifecycle move. Never called without a reason. */
async function transition({
  strategyKey,
  fromState,
  toState,
  actor,
  actorType,
  reason,
  validationKey,
  at,
}: {
  strategyKey: string;
  fromState?: StrategyState;
  toState: StrategyState;
  actor: string;
  actorType: 'engine' | 'human';
  reason: string;
  validationKey?: string;
  at: Date;
}) {
  // The engine may only make transitions it is explicitly permitted to make.
  // Everything past PAPER is human-only, and that is enforced here rather than
  // left to the discipline of each call site.
  if (actorType === 'engine' && fromState) {
    const allowed = AUTOMATED_TRANSITIONS[fromState] ?? [];
    if (!allowed.includes(toState)) {
      throw new Error(
        `Engine may not move ${strategyKey} from ${fromState} to ${toState}; that transition requires a human.`
      );
    }
  }

  await dbStrategyTransitions.insertOne({
    strategyKey,
    fromState,
    toState,
    actor,
    actorType,
    reason,
    validationKey,
    createdAt: at,
  });

  await dbStrategies.updateOne(
    { strategyKey },
    { $set: { state: toState, stateReason: reason, stateChangedAt: at, updatedAt: at } }
  );
}

export async function runValidationCycle({
  debateRunKey,
  trigger,
  triggeredBy,
}: {
  debateRunKey: string;
  trigger: 'cron' | 'manual';
  triggeredBy?: string;
}): Promise<ValidationRunResult> {
  const runKey = validationRunKey(debateRunKey);

  const existing = await dbJobRuns.findOne({ jobId: JOB_ID, runKey });
  if (existing) {
    return {
      jobRunId: existing._id.toString(),
      status: 'skipped',
      candidatesCreated: 0,
      validated: 0,
      passed: 0,
      failed: 0,
      held: 0,
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
    inputSnapshot: JSON.stringify({ debateRunKey, engineVersion: VALIDATION_ENGINE_VERSION }),
    outputSummary: '',
    observationsWritten: 0,
    observationsSkipped: 0,
    errors: [],
    generatorVersion: VALIDATION_ENGINE_VERSION,
    sourceCoverage: [],
    dataOrigin: 'simulated',
  });
  const jobRunId = insertedId.toString();

  const errors: string[] = [];
  let candidatesCreated = 0;
  let validated = 0;
  let passed = 0;
  let failed = 0;
  let held = 0;
  const coverage = new Set<string>();

  try {
    // ---- Phase 1: debate outcomes -> strategy candidates --------------------
    const debates = await dbDebates.fetch({ runKey: debateRunKey }, { limit: 2000 });
    const debateByKey = new Map(debates.map((d) => [d.debateKey, d]));
    const outcomes = await dbDebateOutcomes.fetch(
      { debateKey: { $in: [...debateByKey.keys()] } },
      { limit: 2000 }
    );

    for (const outcome of outcomes) {
      if (outcome.outcome !== 'DIRECTIONAL_CONSENSUS') continue;
      const stance = outcome.resolvedStance;
      if (stance !== 'BULLISH' && stance !== 'BEARISH') continue;

      const debate = debateByKey.get(outcome.debateKey);
      if (!debate) continue;

      const strategyKey = `strategy:${outcome.debateKey}`;
      if (await dbStrategies.findOne({ strategyKey })) continue;

      const token = await dbTokens.findOne({ tokenId: outcome.subjectId });
      const symbol = token?.symbol ?? outcome.subjectId;

      try {
        await dbStrategies.insertOne({
          strategyKey,
          name: `${stance} ${symbol} — ${outcome.convictionSource}`,
          subjectType: debate.subjectType,
          subjectId: outcome.subjectId,
          moduleScope: 'core',
          originDebateKey: outcome.debateKey,
          originThesisRunKey: debate.thesisRunKey,
          originConvictionSource: outcome.convictionSource,
          stance,
          conviction: outcome.conviction,
          state: 'DISCOVERED',
          stateReason: `Promoted from debate ${outcome.debateKey}: ${outcome.reasoning}`,
          stateChangedAt: startedAt,
          testsPassed: 0,
          testsFailed: 0,
          testsInconclusive: 0,
          engineVersion: VALIDATION_ENGINE_VERSION,
          dataOrigin: 'simulated',
          createdAt: startedAt,
          updatedAt: startedAt,
        });
        await dbStrategyTransitions.insertOne({
          strategyKey,
          toState: 'DISCOVERED',
          actor: 'engine',
          actorType: 'engine',
          reason: `Debate produced an actionable ${stance} position carried by ${outcome.convictionSource} at conviction ${outcome.conviction}.`,
          createdAt: startedAt,
        });
        candidatesCreated++;
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        if (!message.includes('E11000')) errors.push(`${strategyKey}: ${message}`);
      }
    }

    // ---- Phase 2: test everything not yet resolved --------------------------
    const pending = await dbStrategies.fetch(
      { state: { $in: ['DISCOVERED', 'UNDER_TEST'] } },
      { limit: 500 }
    );

    const windowEnd = startedAt;
    const windowStart = new Date(startedAt.getTime() - LOOKBACK_MS);

    for (const strategy of pending) {
      const validationKey = `${strategy.strategyKey}:${runKey}`;
      if (await dbValidationRuns.findOne({ validationKey })) continue;

      try {
        const token = await dbTokens.findOne({ tokenId: strategy.subjectId });
        if (!token) {
          errors.push(`${strategy.strategyKey}: subject ${strategy.subjectId} not in registry.`);
          continue;
        }

        const observations = await dbObservations.fetch(
          {
            relevantEntityId: { $in: [strategy.subjectId, token.chainId] },
            observedAt: { $gte: windowStart, $lte: windowEnd },
          },
          { sort: { observedAt: -1 }, limit: 500 }
        );

        const byMetric = new Map<string, ObservationView>();
        for (const o of observations) {
          if (byMetric.has(o.metric)) continue; // newest wins
          byMetric.set(o.metric, {
            observationKey: o.observationKey,
            metric: o.metric,
            value: o.value,
            verifiability: o.verifiability,
            dataOrigin: o.dataOrigin,
            statement: o.statement,
          });
        }

        const tier = (token.tier === 1 || token.tier === 2 ? token.tier : 3) as 1 | 2 | 3;
        const ctx: StrategyContext = {
          strategyKey: strategy.strategyKey,
          subjectId: strategy.subjectId,
          symbol: token.symbol,
          tier,
          category: token.category,
          stance: strategy.stance,
          conviction: strategy.conviction,
          liquidityLockStatus: token.liquidityLockStatus,
          regulatoryStatus: token.regulatoryStatus,
          honeypotCheckResult: token.honeypotCheckResult,
          byMetric,
          intendedSizeUsd: intendedSizeForTier(tier),
        };

        if (strategy.state === 'DISCOVERED') {
          await transition({
            strategyKey: strategy.strategyKey,
            fromState: 'DISCOVERED',
            toState: 'UNDER_TEST',
            actor: 'engine',
            actorType: 'engine',
            reason: `Entered validation run ${runKey}.`,
            at: startedAt,
          });
        }

        const tests = runAllTests(ctx);
        const verdict = verdictFor(tests);
        const citedAll = [...new Set(tests.flatMap((t) => t.citedObservationKeys))];

        const counts = {
          passed: tests.filter((t) => t.result === 'PASS').length,
          failed: tests.filter((t) => t.result === 'FAIL').length,
          inconclusive: tests.filter((t) => t.result === 'INCONCLUSIVE').length,
        };

        await dbValidationRuns.insertOne({
          validationKey,
          strategyKey: strategy.strategyKey,
          runKey,
          jobRunId,
          evidenceWindowStart: windowStart,
          evidenceWindowEnd: windowEnd,
          citedObservationKeys: citedAll,
          testsRun: tests.length,
          passed: counts.passed,
          failed: counts.failed,
          inconclusive: counts.inconclusive,
          verdict: verdict.verdict,
          verdictRule: verdict.rule,
          verdictRationale: verdict.rationale,
          decisiveTestType: verdict.decisiveTestType,
          engineVersion: VALIDATION_ENGINE_VERSION,
          dataOrigin: 'simulated',
          createdAt: startedAt,
        });

        for (const t of tests) {
          coverage.add(t.type);
          await dbValidationTests.insertOne({
            testKey: `${validationKey}:${t.type}`,
            validationKey,
            strategyKey: strategy.strategyKey,
            type: t.type,
            result: t.result,
            rule: t.rule,
            finding: t.finding,
            metrics: t.metrics,
            limitations: t.limitations,
            citedObservationKeys: t.citedObservationKeys,
            createdAt: startedAt,
          });
        }

        await dbStrategies.updateOne(
          { strategyKey: strategy.strategyKey },
          {
            $set: {
              lastValidationRunKey: runKey,
              testsPassed: counts.passed,
              testsFailed: counts.failed,
              testsInconclusive: counts.inconclusive,
              updatedAt: startedAt,
            },
          }
        );

        if (verdict.verdict === 'FAILED') {
          await transition({
            strategyKey: strategy.strategyKey,
            fromState: 'UNDER_TEST',
            toState: 'FAILED',
            actor: 'engine',
            actorType: 'engine',
            reason: verdict.rationale,
            validationKey,
            at: startedAt,
          });
          failed++;
        } else if (verdict.verdict === 'PASSED') {
          await transition({
            strategyKey: strategy.strategyKey,
            fromState: 'UNDER_TEST',
            toState: 'PASSED',
            actor: 'engine',
            actorType: 'engine',
            reason: verdict.rationale,
            validationKey,
            at: startedAt,
          });
          // PASSED is eligible for paper, and paper only. The engine promotes
          // this far and no further; SHADOW and PRODUCTION need a human.
          await transition({
            strategyKey: strategy.strategyKey,
            fromState: 'PASSED',
            toState: 'PAPER',
            actor: 'engine',
            actorType: 'engine',
            reason:
              'Auto-promoted to PAPER. Every strategy defaults to paper execution; promotion to SHADOW or PRODUCTION requires an explicit human decision.',
            validationKey,
            at: startedAt,
          });
          passed++;
        } else {
          // HELD: stays UNDER_TEST. Recorded so the hold is visible, not silent.
          await dbStrategyTransitions.insertOne({
            strategyKey: strategy.strategyKey,
            fromState: 'UNDER_TEST',
            toState: 'UNDER_TEST',
            actor: 'engine',
            actorType: 'engine',
            reason: verdict.rationale,
            validationKey,
            createdAt: startedAt,
          });
          held++;
        }

        validated++;
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
          observationsWritten: validated,
          observationsSkipped: 0,
          errors,
          sourceCoverage: [...coverage],
          outputSummary: `${candidatesCreated} candidate(s) created, ${validated} validated (${passed} passed → paper, ${failed} failed, ${held} held), ${errors.length} errors in ${endedAt.getTime() - startedAt.getTime()}ms.`,
        },
      }
    );

    return {
      jobRunId,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      candidatesCreated,
      validated,
      passed,
      failed,
      held,
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
          observationsWritten: validated,
          errors: [...errors, message],
          sourceCoverage: [...coverage],
          outputSummary: `Validation run aborted: ${message}`,
        },
      }
    );
    return {
      jobRunId,
      status: 'failed',
      candidatesCreated,
      validated,
      passed,
      failed,
      held,
      errors: [...errors, message],
    };
  }
}
