import { Store, schema } from 'modelence/server';
import { dataOriginValues, verifiabilityValues } from '../registry/db';

/**
 * QUORUM CORE EVIDENCE LAYER
 *
 * Every downstream stage (agent swarm → debate → validation → risk gate) reads
 * from `coreObservations`. Nothing else in the system is allowed to hold raw
 * facts about the outside world.
 *
 * Each observation is an immutable record of "what a named source said, when we
 * retrieved it, and how strongly it is verifiable". Observations are never
 * updated in place — a corrected reading is a new observation. This is what
 * makes every downstream decision replayable against the evidence known at the
 * time it was made.
 */

export const observationSourceTypes = [
  'on_chain',
  'market_microstructure',
  'narrative_social',
  'regulatory',
  'security',
] as const;
export type ObservationSourceType = (typeof observationSourceTypes)[number];

export const observationEntityTypes = ['token', 'venue', 'chain', 'jurisdiction'] as const;

export const dbObservations = new Store('coreObservations', {
  schema: {
    /**
     * Deterministic key: `${jobId}:${runKey}:${entityId}:${metric}`.
     * Guarantees a replayed run cannot duplicate or silently overwrite history.
     */
    observationKey: schema.string(),

    sourceType: schema.enum(observationSourceTypes),
    /** Named feed, e.g. 'synthetic:dex_pool_depth'. Always attributable. */
    source: schema.string(),
    sourceUrl: schema.string().optional(),

    /** When the underlying fact is about. */
    observedAt: schema.date(),
    /** When QUORUM pulled it. */
    retrievalTimestamp: schema.date(),

    verifiability: schema.enum(verifiabilityValues),

    relevantEntityType: schema.enum(observationEntityTypes),
    relevantEntityId: schema.string(),
    /** Nullable: not every observation is jurisdiction-bound. */
    relevantJurisdictionId: schema.string().optional(),

    /** Machine-readable measurement. */
    metric: schema.string(),
    value: schema.number().optional(),
    unit: schema.string().optional(),
    /** Human-readable statement of the same fact, for debate/audit rendering. */
    statement: schema.string(),

    /** Producing job run — links every fact to a replayable job record. */
    jobRunId: schema.string(),
    generatorVersion: schema.string(),

    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { observationKey: 1 }, unique: true },
    { key: { relevantEntityType: 1, relevantEntityId: 1, observedAt: -1 } },
    { key: { sourceType: 1, observedAt: -1 } },
    { key: { jobRunId: 1 } },
    { key: { observedAt: -1 } },
  ],
});

/**
 * Job run ledger. Every ingestion (and later: thesis, validation, risk scan)
 * run writes exactly one row here, before and after execution. Rows are
 * append-only — a re-run creates a new row, it never edits an old one.
 */
export const dbJobRuns = new Store('coreJobRuns', {
  schema: {
    jobId: schema.string(),
    /** Deterministic seed key for this run — same key ⇒ same synthetic output. */
    runKey: schema.string(),
    trigger: schema.enum(['cron', 'manual']),
    /** Operator handle when manually triggered. */
    triggeredBy: schema.string().optional(),

    startedAt: schema.date(),
    endedAt: schema.date().optional(),
    status: schema.enum(['running', 'succeeded', 'failed']),

    /** What the run was given. */
    inputSnapshot: schema.string(),
    /** What the run produced. */
    outputSummary: schema.string(),
    observationsWritten: schema.number(),
    observationsSkipped: schema.number(),
    errors: schema.array(schema.string()),

    generatorVersion: schema.string(),
    /** Which sources this run actually covered. */
    sourceCoverage: schema.array(schema.string()),
    dataOrigin: schema.enum(dataOriginValues),
  },
  indexes: [
    { key: { startedAt: -1 } },
    { key: { jobId: 1, startedAt: -1 } },
    { key: { jobId: 1, runKey: 1 }, unique: true },
  ],
});
