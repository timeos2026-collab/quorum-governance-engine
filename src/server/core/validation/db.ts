import { Store, schema } from 'modelence/server';
import { dataOriginValues } from '../registry/db';
import { stanceValues } from '../agents/db';

/**
 * QUORUM VALIDATION ENGINE
 *
 * Debate produces a *position*. Validation decides whether that position has
 * ever been shown to work under conditions resembling reality. Nothing reaches
 * the risk gate without a validation record.
 *
 * THE CORE RULE: tests are not scored and averaged. Every test is independently
 * dispositive. One FAIL fails the strategy, no matter how strong the other five
 * look. A profitable backtest does not buy forgiveness for a position that
 * cannot be exited — those are different claims about the world.
 *
 * INCONCLUSIVE is not a pass. A strategy with an inconclusive test stays at
 * UNDER_TEST indefinitely. Absence of evidence of failure is not evidence of
 * safety, and the engine must never quietly treat it as one.
 */

/**
 * Lifecycle. Forward-only except RETIRED, which any state can reach.
 * PASSED does NOT mean tradeable — it means eligible for paper. Promotion past
 * PAPER always requires a human, which is enforced in the transition guard.
 */
export const strategyStateValues = [
  'DISCOVERED',
  'UNDER_TEST',
  'FAILED',
  'PASSED',
  'PAPER',
  'SHADOW',
  'PRODUCTION',
  'RETIRED',
] as const;
export type StrategyState = (typeof strategyStateValues)[number];

/** Transitions the engine may make on its own. Everything else needs a human. */
export const AUTOMATED_TRANSITIONS: Record<string, StrategyState[]> = {
  DISCOVERED: ['UNDER_TEST'],
  UNDER_TEST: ['PASSED', 'FAILED'],
  PASSED: ['PAPER'],
  // PAPER -> SHADOW -> PRODUCTION are human-only, deliberately absent here.
  PAPER: [],
  SHADOW: [],
  PRODUCTION: [],
  FAILED: [],
  RETIRED: [],
};

export const testTypeValues = [
  /** Includes dead/delisted tokens. A backtest over survivors only is fiction. */
  'SURVIVORSHIP_CORRECTED_BACKTEST',
  /** Out-of-sample degradation vs in-sample. Catches curve fitting. */
  'WALK_FORWARD',
  /** Performance decomposed by market regime. Single-regime edge is an artifact. */
  'REGIME_DECOMPOSITION',
  /** Fill simulation against observed pool depth, not notional volume. */
  'SLIPPAGE_ON_REAL_DEPTH',
  /** Volume discounted by observed wash-trading score. */
  'WASH_ADJUSTED_VOLUME',
  /** Adversarial attempt to break the position deliberately. */
  'ADVERSARIAL_RED_TEAM',
] as const;
export type TestType = (typeof testTypeValues)[number];

export const testResultValues = ['PASS', 'FAIL', 'INCONCLUSIVE'] as const;
export type TestResult = (typeof testResultValues)[number];

/**
 * A strategy candidate. Created from a debate outcome that produced an
 * actionable directional position. Blocked and contested debates never become
 * candidates — there is nothing to validate in "we could not agree".
 */
export const dbStrategies = new Store('coreStrategies', {
  schema: {
    /** `strategy:${debateKey}` — one candidate per debate, forever. */
    strategyKey: schema.string(),
    /** Human-readable, stable across the lifecycle. */
    name: schema.string(),

    subjectType: schema.enum(['token', 'venue', 'chain', 'jurisdiction']),
    subjectId: schema.string(),
    /** Business line this candidate belongs to. `core` until modules exist. */
    moduleScope: schema.string(),

    /** Provenance back through the pipeline. Every candidate is traceable. */
    originDebateKey: schema.string(),
    originThesisRunKey: schema.string(),
    originConvictionSource: schema.string(),

    stance: schema.enum(stanceValues),
    /** Conviction as carried by ONE named thesis. Never a blend. */
    conviction: schema.number(),

    state: schema.enum(strategyStateValues),
    stateReason: schema.string(),
    stateChangedAt: schema.date(),
    /** Set only when a human promotes past PAPER. */
    promotedBy: schema.string().optional(),

    /** Latest validation run, for fast reads. History lives in the run store. */
    lastValidationRunKey: schema.string().optional(),
    testsPassed: schema.number(),
    testsFailed: schema.number(),
    testsInconclusive: schema.number(),

    engineVersion: schema.string(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
    updatedAt: schema.date(),
  },
  indexes: [
    { key: { strategyKey: 1 }, unique: true },
    { key: { state: 1, updatedAt: -1 } },
    { key: { subjectId: 1, createdAt: -1 } },
    { key: { originDebateKey: 1 } },
    { key: { createdAt: -1 } },
  ],
});

/** One batch of tests run against one strategy. Append-only. */
export const dbValidationRuns = new Store('coreValidationRuns', {
  schema: {
    /** `${strategyKey}:${runKey}` */
    validationKey: schema.string(),
    strategyKey: schema.string(),
    runKey: schema.string(),
    jobRunId: schema.string(),

    /** Evidence window the tests were computed over. Bounds the claim. */
    evidenceWindowStart: schema.date(),
    evidenceWindowEnd: schema.date(),
    /** Observation keys the harness actually read. Full provenance. */
    citedObservationKeys: schema.array(schema.string()),

    testsRun: schema.number(),
    passed: schema.number(),
    failed: schema.number(),
    inconclusive: schema.number(),

    /** Verdict of the whole batch: any FAIL => FAILED, any INCONCLUSIVE => HELD. */
    verdict: schema.enum(['PASSED', 'FAILED', 'HELD']),
    /** Named rule that produced the verdict. Never a score. */
    verdictRule: schema.string(),
    verdictRationale: schema.string(),

    /** The single test that failed the batch, if any. */
    decisiveTestType: schema.string().optional(),

    engineVersion: schema.string(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { validationKey: 1 }, unique: true },
    { key: { strategyKey: 1, createdAt: -1 } },
    { key: { runKey: 1 } },
    { key: { verdict: 1, createdAt: -1 } },
  ],
});

/** An individual test result. Independently dispositive, never aggregated. */
export const dbValidationTests = new Store('coreValidationTests', {
  schema: {
    /** `${validationKey}:${type}` */
    testKey: schema.string(),
    validationKey: schema.string(),
    strategyKey: schema.string(),

    type: schema.enum(testTypeValues),
    result: schema.enum(testResultValues),
    /** Named threshold rule that decided it. */
    rule: schema.string(),
    /** Plain-language finding a human can audit without reading code. */
    finding: schema.string(),

    /** Test-specific measurements, always with the threshold alongside. */
    metrics: schema.array(
      schema.object({
        label: schema.string(),
        value: schema.number(),
        unit: schema.string(),
        threshold: schema.number().optional(),
        comparator: schema.string().optional(),
      })
    ),

    /** What this test could NOT establish. Always populated honestly. */
    limitations: schema.array(schema.string()),
    citedObservationKeys: schema.array(schema.string()),

    createdAt: schema.date(),
  },
  indexes: [
    { key: { testKey: 1 }, unique: true },
    { key: { validationKey: 1 } },
    { key: { strategyKey: 1, type: 1, createdAt: -1 } },
    { key: { result: 1 } },
  ],
});

/**
 * Append-only lifecycle ledger. Every state change, engine or human, with the
 * reason. A strategy's history can never be rewritten by its current state.
 */
export const dbStrategyTransitions = new Store('coreStrategyTransitions', {
  schema: {
    strategyKey: schema.string(),
    fromState: schema.enum(strategyStateValues).optional(),
    toState: schema.enum(strategyStateValues),
    /** `engine` or a userId. Human promotions are never attributed to the engine. */
    actor: schema.string(),
    actorType: schema.enum(['engine', 'human']),
    reason: schema.string(),
    /** Validation run that justified the transition, when there was one. */
    validationKey: schema.string().optional(),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { strategyKey: 1, createdAt: -1 } },
    { key: { toState: 1, createdAt: -1 } },
    { key: { createdAt: -1 } },
  ],
});
