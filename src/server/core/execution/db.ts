import { Store, schema } from 'modelence/server';
import { dataOriginValues } from '../registry/db';

/**
 * QUORUM PAPER / SHADOW EXECUTION
 *
 * The stage that finally *does* something — and the one most likely to lie to
 * you if it is built carelessly. The rules it exists to enforce:
 *
 *  1. **No price here is real.** Fills are produced by a deterministic
 *     generator seeded from the order key. There is no market connection, and
 *     `dataOrigin` is `simulated` on every fill row. A live feed would be a new
 *     `dataOrigin: 'ingested'` writer, never an edit to these rows.
 *  2. **Execution owns no risk logic.** It *reads* the risk gate's findings and
 *     obeys them. Where it recomputes a ceiling it recomputes it from the same
 *     findings, and names the rule that produced it in `sizeCapReason`.
 *  3. **Approval is not permission to act yet.** Tier 3 and pre-launch exposure
 *     serve a mandatory 48-hour paper embargo measured in wall-clock time, not
 *     in cycle counts, so the embargo cannot be spun down by running the cron
 *     more often.
 *  4. **One writer.** `runPaperCycle()` is the only path that creates orders and
 *     fills. Uniqueness is enforced in the database, not in application logic,
 *     so a concurrent replay collides rather than duplicates.
 */

export const executionModeValues = ['PAPER', 'SHADOW', 'PRODUCTION'] as const;
export type ExecutionMode = (typeof executionModeValues)[number];

/** Ordered least → most consequential. Ceilings are taken as a minimum. */
export const MODE_RANK: Record<ExecutionMode, number> = {
  PAPER: 0,
  SHADOW: 1,
  PRODUCTION: 2,
};

export function leastPermissiveMode(modes: ExecutionMode[]): ExecutionMode {
  return modes.reduce<ExecutionMode>(
    (low, m) => (MODE_RANK[m] < MODE_RANK[low] ? m : low),
    'PRODUCTION'
  );
}

export const orderStatusValues = [
  'PROPOSED',
  /** Held: something the gate flagged is unresolved. Never fills from here. */
  'RISK_CHECK',
  'APPROVED',
  'SUBMITTED',
  'PARTIALLY_FILLED',
  'FILLED',
  'ACTIVE',
  'CANCELLED',
  'EXPIRED',
  'MATURED',
] as const;
export type OrderStatus = (typeof orderStatusValues)[number];

/** The three validation tests that read real observations rather than a derived record. */
export const OBSERVED_EVIDENCE_TESTS = [
  'SLIPPAGE_ON_REAL_DEPTH',
  'WASH_ADJUSTED_VOLUME',
  'ADVERSARIAL_RED_TEAM',
] as const;

/** The three that derive a synthetic track record. Never sufficient for PRODUCTION. */
export const DERIVED_TRACK_RECORD_TESTS = [
  'SURVIVORSHIP_CORRECTED_BACKTEST',
  'WALK_FORWARD',
  'REGIME_DECOMPOSITION',
] as const;

/**
 * One order per gate assessment, forever. The key is derived from the
 * assessment rather than from a timestamp, so a replayed cycle collides on the
 * unique index instead of opening a second position against one decision.
 */
export const dbExecutionOrders = new Store('executionOrders', {
  schema: {
    /** `execution:${assessmentKey}` */
    orderKey: schema.string(),
    strategyKey: schema.string(),
    assessmentKey: schema.string(),
    subjectId: schema.string(),
    symbol: schema.string(),
    moduleScope: schema.string(),
    side: schema.string(),

    /** What the gate was asked for, kept so the reduction stays visible. */
    requestedSizeUsd: schema.number(),
    /** What execution will actually act on. Always ≤ requested. */
    permittedSizeUsd: schema.number(),
    /** Named rule(s) that produced the binding cap. Never a bare number. */
    sizeCapReason: schema.string(),
    /** Every cap considered, with its rule, so the min() is auditable. */
    sizeCaps: schema.array(
      schema.object({
        ruleId: schema.string(),
        capUsd: schema.number(),
        binding: schema.boolean(),
        note: schema.string(),
      })
    ),

    permittedMode: schema.enum(executionModeValues),
    /** Why the mode is what it is, including any PRODUCTION refusal. */
    modeReason: schema.string(),
    /** Restrictions carried forward from the gate, plus any added here. */
    restrictions: schema.array(schema.string()),

    /** Gate verdict this order was created from. Only the two approving ones. */
    sourceVerdict: schema.string(),
    decisiveRuleId: schema.string().optional(),

    status: schema.enum(orderStatusValues),
    statusReason: schema.string(),

    /**
     * Wall-clock moment before which nothing may be submitted. For Tier 3 and
     * pre-launch this is creation + 48h. Enforced on submit, not merely
     * displayed.
     */
    earliestLiveAt: schema.date(),
    embargoHours: schema.number(),
    embargoReason: schema.string(),

    /** Depth was unobserved: the order is held rather than sized on a guess. */
    requiresHumanForDepth: schema.boolean(),

    submittedAt: schema.date().optional(),
    submittedBy: schema.string().optional(),

    runKey: schema.string(),
    jobRunId: schema.string(),
    generatorVersion: schema.string(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
    updatedAt: schema.date(),
  },
  indexes: [
    { key: { orderKey: 1 }, unique: true },
    { key: { strategyKey: 1, createdAt: -1 } },
    { key: { status: 1, createdAt: -1 } },
    { key: { assessmentKey: 1 } },
    { key: { createdAt: -1 } },
  ],
});

/**
 * A synthetic fill. One per order, ever — `fillKey` is derived from the order
 * alone, so no run can top up a position it already filled.
 *
 * `fillPrice` is a deterministic function of the order key and symbol. It is
 * not a market price and must never be rendered as one.
 */
export const dbExecutionFills = new Store('executionFills', {
  schema: {
    /** `fill:${orderKey}` */
    fillKey: schema.string(),
    orderKey: schema.string(),
    strategyKey: schema.string(),
    symbol: schema.string(),

    filledSizeUsd: schema.number(),
    /** SYNTHETIC. Deterministic from (orderKey, symbol). No market fetch. */
    fillPrice: schema.number(),
    /** Modelled slippage against the same synthetic reference. */
    slippageBps: schema.number(),
    mode: schema.enum(executionModeValues),
    /** True when filledSizeUsd < the order's permitted size. */
    partial: schema.boolean(),

    filledAt: schema.date(),
    runKey: schema.string(),
    jobRunId: schema.string(),
    generatorVersion: schema.string(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { fillKey: 1 }, unique: true },
    { key: { orderKey: 1 } },
    { key: { strategyKey: 1, filledAt: -1 } },
    { key: { filledAt: -1 } },
  ],
});
