import { Store, schema } from 'modelence/server';
import { dataOriginValues, verifiabilityValues } from '../registry/db';

/**
 * QUORUM AGENT SWARM
 *
 * Agents do NOT hold facts. They read `coreObservations` and emit a *thesis*:
 * a stance, a confidence, a rationale, and the exact observation keys the stance
 * rests on. Rules baked into the schema:
 *
 *  - A thesis MUST cite observation keys. A thesis with no citations can only be
 *    an ABSTAIN — an agent is never allowed to assert beyond its evidence.
 *  - `confidenceCap` / `confidenceCapReason` are stored alongside confidence, so
 *    the reason a thesis is weak survives into debate and audit. A thesis leaning
 *    on a social claim can never present itself as highly confident.
 *  - `evidenceOrigins` records the dataOrigin of the cited evidence. A thesis can
 *    never be more live than the evidence beneath it.
 *  - `falsifiableCondition` is mandatory: an unfalsifiable thesis is not a thesis.
 *  - Theses are immutable. Reconciliation (Slice 4) supersedes, never edits.
 */

export const stanceValues = [
  'BULLISH',
  'BEARISH',
  'NEUTRAL',
  'ABSTAIN',
  'BLOCK_RECOMMENDED',
] as const;
export type Stance = (typeof stanceValues)[number];

export const agentDisciplineValues = [
  'on_chain_flow',
  'liquidity_microstructure',
  'volume_integrity',
  'narrative',
  'regulatory',
  'security',
  'token_structure',
  'adversarial',
] as const;
export type AgentDiscipline = (typeof agentDisciplineValues)[number];

/** Roster row — enable/disable and display metadata for a code-defined agent. */
export const dbAgents = new Store('coreAgents', {
  schema: {
    agentId: schema.string(),
    name: schema.string(),
    discipline: schema.enum(agentDisciplineValues),
    /** One sentence: what this agent is allowed to have an opinion about. */
    mandate: schema.string(),
    /** Observation source types this agent may read. Enforced at run time. */
    sourceScope: schema.array(schema.string()),
    /** Metrics it reasons over — declared so gaps are detectable. */
    metricScope: schema.array(schema.string()),
    /** Hard ceiling on this agent's confidence, regardless of evidence. */
    maxConfidence: schema.number(),
    agentVersion: schema.string(),
    enabled: schema.boolean(),
    /** null for core engine agents; set for module-specific agents (Slices 8-12). */
    moduleScope: schema.string().optional(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
    updatedAt: schema.date(),
  },
  indexes: [
    { key: { agentId: 1 }, unique: true },
    { key: { discipline: 1 } },
  ],
});

export const dbTheses = new Store('coreTheses', {
  schema: {
    /** `${jobId}:${runKey}:${agentId}:${subjectId}` — replay-safe. */
    thesisKey: schema.string(),

    agentId: schema.string(),
    agentVersion: schema.string(),
    discipline: schema.enum(agentDisciplineValues),

    subjectType: schema.enum(['token', 'venue', 'chain', 'jurisdiction']),
    subjectId: schema.string(),

    stance: schema.enum(stanceValues),
    confidence: schema.number(),
    confidenceCap: schema.number(),
    confidenceCapReason: schema.string(),

    rationale: schema.string(),
    /** What would prove this thesis wrong. Never empty. */
    falsifiableCondition: schema.string(),
    /** The single weakest assumption this thesis depends on. */
    weakestLink: schema.string(),

    /** Exact evidence this stance rests on. Empty ⇒ stance must be ABSTAIN. */
    citedObservationKeys: schema.array(schema.string()),
    citedObservationCount: schema.number(),
    /** Declared metrics the agent expected but did not find. */
    evidenceGaps: schema.array(schema.string()),

    /** Weakest verifiability among cited evidence — caps downstream trust. */
    weakestVerifiability: schema.enum(verifiabilityValues),
    /** Distinct dataOrigins of cited evidence. */
    evidenceOrigins: schema.array(schema.string()),

    /** Evidence window this thesis was formed over. */
    evidenceWindowStart: schema.date(),
    evidenceWindowEnd: schema.date(),

    /**
     * ACTIVE until reconciliation supersedes it. Never edited in place other
     * than this status transition + supersededByThesisKey.
     */
    status: schema.enum(['ACTIVE', 'SUPERSEDED']),
    supersededByThesisKey: schema.string().optional(),

    jobRunId: schema.string(),
    runKey: schema.string(),
    generatorVersion: schema.string(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { thesisKey: 1 }, unique: true },
    { key: { subjectType: 1, subjectId: 1, createdAt: -1 } },
    { key: { agentId: 1, createdAt: -1 } },
    { key: { runKey: 1 } },
    { key: { createdAt: -1 } },
    { key: { stance: 1, createdAt: -1 } },
  ],
});
