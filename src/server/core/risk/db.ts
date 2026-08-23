import { Store, schema } from 'modelence/server';
import { dataOriginValues } from '../registry/db';

/**
 * QUORUM RISK GATE
 *
 * The single chokepoint. Every proposed action from every business line passes
 * through here, and no module may implement its own risk logic — trading,
 * private equity, private credit, investment banking and AUM all call this
 * stage or they do not act.
 *
 * THE CORE RULES:
 *  1. A validation PASS is a prerequisite, never a permission. Reaching the gate
 *     with a passed strategy earns you an assessment, not an approval.
 *  2. Findings are not scored and summed. Each finding carries its own verdict,
 *     and the assessment takes the MOST RESTRICTIVE one. A dozen clean findings
 *     do not outvote one BLOCK.
 *  3. BLOCK is not overridable. A human may override REQUIRES_HUMAN_APPROVAL —
 *     that is what the verdict is for — but no human may wave through a hard
 *     block from inside the app. Removing a block means changing the rule or
 *     the underlying fact, both of which are versioned and attributable.
 *  4. Every override is preserved permanently, with the actor, the reason, and
 *     the full assessment it overrode.
 */

export const riskVerdictValues = [
  'APPROVED',
  'APPROVED_WITH_RESTRICTIONS',
  'REQUIRES_HUMAN_APPROVAL',
  'BLOCKED',
] as const;
export type RiskVerdict = (typeof riskVerdictValues)[number];

/** Ordered least → most restrictive. The gate always takes the maximum. */
export const VERDICT_SEVERITY: Record<RiskVerdict, number> = {
  APPROVED: 0,
  APPROVED_WITH_RESTRICTIONS: 1,
  REQUIRES_HUMAN_APPROVAL: 2,
  BLOCKED: 3,
};

export function mostRestrictive(verdicts: RiskVerdict[]): RiskVerdict {
  return verdicts.reduce<RiskVerdict>(
    (worst, v) => (VERDICT_SEVERITY[v] > VERDICT_SEVERITY[worst] ? v : worst),
    'APPROVED'
  );
}

export const riskDomainValues = [
  'JURISDICTION',
  'CAPITAL_CONTROL',
  'TIER_EXPOSURE',
  'LIQUIDITY',
  'COUNTERPARTY',
  'SECURITY',
  'VALIDATION_INTEGRITY',
  'EXECUTION_MODE',
] as const;
export type RiskDomain = (typeof riskDomainValues)[number];

/**
 * A risk policy: one named, versioned rule. Rules live in code (`rules.ts`) and
 * are mirrored here so an operator can see, and an auditor can replay, exactly
 * which ruleset was in force when a decision was made. Policies are never
 * edited in place — a changed rule is a new version row.
 */
export const dbRiskPolicies = new Store('coreRiskPolicies', {
  schema: {
    /** `${ruleId}@${version}` */
    policyKey: schema.string(),
    ruleId: schema.string(),
    version: schema.string(),
    domain: schema.enum(riskDomainValues),
    title: schema.string(),
    /** Plain-language statement of the rule a non-engineer can audit. */
    statement: schema.string(),
    /** Why the rule exists — the failure it is preventing. */
    rationale: schema.string(),
    /** Worst verdict this rule is capable of producing. */
    maxVerdict: schema.enum(riskVerdictValues),
    /** Whether a human may override a finding from this rule. */
    overridable: schema.boolean(),
    effectiveFrom: schema.date(),
    effectiveTo: schema.date().optional(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
    updatedAt: schema.date(),
  },
  indexes: [
    { key: { policyKey: 1 }, unique: true },
    { key: { ruleId: 1, effectiveFrom: -1 } },
    { key: { domain: 1 } },
  ],
});

/**
 * One gate decision on one proposed action. Immutable. A re-assessment is a new
 * row, so the record of what the gate said at the time can never be rewritten.
 */
export const dbRiskAssessments = new Store('coreRiskAssessments', {
  schema: {
    /** `${strategyKey}:${runKey}` */
    assessmentKey: schema.string(),
    strategyKey: schema.string(),
    subjectId: schema.string(),
    /** Business line requesting the action. `core` until modules land. */
    moduleScope: schema.string(),
    runKey: schema.string(),
    jobRunId: schema.string(),

    /** What was actually being asked for. */
    proposedAction: schema.string(),
    proposedSizeUsd: schema.number(),
    stance: schema.string(),

    verdict: schema.enum(riskVerdictValues),
    /** The single rule that set the verdict. Named, never a score. */
    decisiveRuleId: schema.string().optional(),
    rationale: schema.string(),

    /** Restrictions attached to an APPROVED_WITH_RESTRICTIONS verdict. */
    restrictions: schema.array(schema.string()),
    /** Size the gate will actually permit, which may be below what was asked. */
    permittedSizeUsd: schema.number(),
    /** Execution mode the gate permits. Never above the strategy's own state. */
    permittedExecutionMode: schema.enum(['NONE', 'PAPER', 'SHADOW', 'PRODUCTION']),

    findingCount: schema.number(),
    blockingFindingCount: schema.number(),

    /** Full ruleset in force, so the decision is replayable rule-for-rule. */
    policyKeys: schema.array(schema.string()),
    /** Evidence the gate itself read. */
    citedObservationKeys: schema.array(schema.string()),

    engineVersion: schema.string(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { assessmentKey: 1 }, unique: true },
    { key: { strategyKey: 1, createdAt: -1 } },
    { key: { verdict: 1, createdAt: -1 } },
    { key: { runKey: 1 } },
    { key: { createdAt: -1 } },
  ],
});

/** One rule's outcome within one assessment. Independently meaningful. */
export const dbRiskFindings = new Store('coreRiskFindings', {
  schema: {
    /** `${assessmentKey}:${ruleId}` */
    findingKey: schema.string(),
    assessmentKey: schema.string(),
    strategyKey: schema.string(),

    ruleId: schema.string(),
    policyKey: schema.string(),
    domain: schema.enum(riskDomainValues),
    verdict: schema.enum(riskVerdictValues),
    /** What the rule found, in terms a human can check against the facts. */
    finding: schema.string(),
    /** Registry/observation values the rule actually read. */
    evidence: schema.array(
      schema.object({
        label: schema.string(),
        value: schema.string(),
        source: schema.string(),
      })
    ),
    citedObservationKeys: schema.array(schema.string()),
    overridable: schema.boolean(),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { findingKey: 1 }, unique: true },
    { key: { assessmentKey: 1 } },
    { key: { ruleId: 1, verdict: 1 } },
    { key: { verdict: 1, createdAt: -1 } },
  ],
});

/**
 * Human decisions on gate outcomes. Append-only and permanent — an override is
 * never deleted, edited or superseded away, because the value of an override
 * record is precisely that it can be looked at later by someone who was not in
 * the room.
 */
export const dbRiskOverrides = new Store('coreRiskOverrides', {
  schema: {
    assessmentKey: schema.string(),
    strategyKey: schema.string(),
    /** userId. Never 'engine' — the engine cannot override itself. */
    actor: schema.string(),
    decision: schema.enum(['APPROVE', 'REJECT']),
    /** The verdict at the moment of the override, frozen. */
    overriddenVerdict: schema.enum(riskVerdictValues),
    /** Resulting verdict. Can only be equal or MORE restrictive on REJECT. */
    resultingVerdict: schema.enum(riskVerdictValues),
    reason: schema.string(),
    /** Snapshot of blocking findings the human saw when deciding. */
    acknowledgedFindings: schema.array(schema.string()),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { assessmentKey: 1, createdAt: -1 } },
    { key: { strategyKey: 1, createdAt: -1 } },
    { key: { actor: 1, createdAt: -1 } },
    { key: { createdAt: -1 } },
  ],
});
