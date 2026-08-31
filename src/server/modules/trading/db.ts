import { Store, schema } from 'modelence/server';
import { dataOriginValues, tokenCategoryValues } from '../../core/registry/db';

/**
 * TRADING DESK — the first business line to attach to the shared engine.
 *
 * What this module owns: **mandate**. Which instruments this desk is allowed to
 * look at, and how much gross exposure it may carry in total.
 *
 * What this module explicitly does NOT own, and must never acquire:
 *  - risk rules (it reads `coreRiskFindings`; it never evaluates its own);
 *  - validation (it reads `coreStrategies`; it never promotes);
 *  - execution (it reads `executionOrders`; it never creates one);
 *  - an audit trail (every row it shows already carries provenance from the
 *    stage that produced it).
 *
 * A mandate is a narrowing filter, never a widening one. The desk can decline
 * to look at something the engine approved. It can never look at something the
 * engine blocked — there is no code path here that could express that.
 */

/**
 * Versioned desk mandate. Never edited in place: a change writes a new version
 * and closes the previous one with `effectiveTo`, so a past position can be
 * judged against the mandate that was actually in force at the time.
 */
export const dbTradingMandates = new Store('tradingMandates', {
  schema: {
    /** `${deskId}@v${version}` */
    mandateKey: schema.string(),
    deskId: schema.string(),
    version: schema.number(),

    /** Instrument categories this desk may hold. A subset, never everything. */
    allowedCategories: schema.array(schema.enum(tokenCategoryValues)),
    /** Highest (riskiest) tier the desk may hold. 1 = majors only. */
    maxTier: schema.number(),
    /** Total gross exposure ceiling across the whole book. */
    maxGrossExposureUsd: schema.number(),
    /**
     * Capital-origin jurisdictions this desk refuses regardless of what the
     * gate says. A desk-level narrowing, on top of the gate, never instead.
     */
    excludedCapitalOrigins: schema.array(schema.string()),

    /** Why this mandate is what it is. Read by humans, not by code. */
    rationale: schema.string(),

    effectiveFrom: schema.date(),
    effectiveTo: schema.date().optional(),
    /** userId, or 'seed' for the initial mandate. Always attributable. */
    setBy: schema.string(),

    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { mandateKey: 1 }, unique: true },
    { key: { deskId: 1, version: -1 } },
    { key: { deskId: 1, effectiveTo: 1 } },
  ],
});

export const DEFAULT_DESK_ID = 'trading.primary';

/** The mandate the desk starts with. Deliberately narrow. */
export const SEED_MANDATE = {
  allowedCategories: ['major', 'large-cap-meme'] as const,
  maxTier: 2,
  maxGrossExposureUsd: 750_000,
  excludedCapitalOrigins: [] as string[],
  rationale:
    'Opening mandate: majors and large-cap memes only, Tier 2 and above excluded. The desk starts narrower than the engine permits, because a mandate is a statement of what this desk is prepared to be responsible for — not a restatement of what the risk gate happens to allow today.',
};
