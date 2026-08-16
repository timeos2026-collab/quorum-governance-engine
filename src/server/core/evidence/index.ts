import { z } from 'zod';
import { time } from 'modelence';
import { Module, type UserInfo } from 'modelence/server';

import { dbObservations, dbJobRuns, observationSourceTypes, type ObservationSourceType } from './db';
import { bucketRunKey, runIngestion } from './ingest';
import { GENERATOR_VERSION } from './generators';

/**
 * core.evidence — the shared observation layer.
 *
 * Every downstream stage (agents, debate, validation, risk gate, audit) reads
 * evidence from here and nowhere else. No module gets its own private feed.
 * All rows currently carry `dataOrigin: 'simulated'`: see generators.ts.
 */

/** Cron cadence per source type. Doubles as the idempotency bucket width. */
const CADENCE: Record<ObservationSourceType, number> = {
  on_chain: time.minutes(15),
  market_microstructure: time.minutes(5),
  narrative_social: time.minutes(30),
  regulatory: time.hours(6),
  security: time.hours(1),
};

function cronFor(sourceType: ObservationSourceType) {
  return {
    description: `Simulated ${sourceType} evidence ingestion (deterministic, replayable)`,
    interval: CADENCE[sourceType],
    handler: async () => {
      const now = new Date();
      await runIngestion({
        sourceType,
        runKey: bucketRunKey(sourceType, now, CADENCE[sourceType]),
        trigger: 'cron',
      });
    },
  };
}

export default new Module('evidence', {
  stores: [dbObservations, dbJobRuns],

  queries: {
    async overview() {
      const [total, jobRuns] = await Promise.all([
        dbObservations.countDocuments({}),
        dbJobRuns.countDocuments({}),
      ]);

      const bySource = await Promise.all(
        observationSourceTypes.map(async (sourceType) => ({
          sourceType,
          count: await dbObservations.countDocuments({ sourceType }),
          cadenceMs: CADENCE[sourceType],
        }))
      );

      const [simulated, ingested] = await Promise.all([
        dbObservations.countDocuments({ dataOrigin: 'simulated' }),
        dbObservations.countDocuments({ dataOrigin: 'ingested' }),
      ]);

      const byVerifiability = await Promise.all(
        (['verified', 'inferred', 'social_claim'] as const).map(async (v) => ({
          verifiability: v,
          count: await dbObservations.countDocuments({ verifiability: v }),
        }))
      );

      const [latest] = await dbObservations.fetch({}, { sort: { observedAt: -1 }, limit: 1 });

      return {
        counts: { total, jobRuns },
        bySource,
        byVerifiability,
        provenance: { simulated, ingested },
        generatorVersion: GENERATOR_VERSION,
        latestObservedAt: latest?.observedAt ?? null,
      };
    },

    async feed(args: unknown) {
      const { sourceType, entityId, verifiability, limit } = z
        .object({
          sourceType: z.enum(observationSourceTypes).optional(),
          entityId: z.string().optional(),
          verifiability: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .parse(args ?? {});

      const filter: Record<string, unknown> = {};
      if (sourceType) filter.sourceType = sourceType;
      if (entityId) filter.relevantEntityId = entityId;
      if (verifiability) filter.verifiability = verifiability;

      const rows = await dbObservations.fetch(filter, {
        sort: { observedAt: -1 },
        limit: limit ?? 60,
      });

      return rows.map((o) => ({
        id: o._id.toString(),
        observationKey: o.observationKey,
        sourceType: o.sourceType,
        source: o.source,
        observedAt: o.observedAt,
        retrievalTimestamp: o.retrievalTimestamp,
        verifiability: o.verifiability,
        relevantEntityType: o.relevantEntityType,
        relevantEntityId: o.relevantEntityId,
        relevantJurisdictionId: o.relevantJurisdictionId ?? null,
        metric: o.metric,
        value: o.value ?? null,
        unit: o.unit ?? null,
        statement: o.statement,
        jobRunId: o.jobRunId,
        generatorVersion: o.generatorVersion,
        dataOrigin: o.dataOrigin,
      }));
    },

    async jobRuns(args: unknown) {
      const { limit } = z
        .object({ limit: z.number().int().min(1).max(100).optional() })
        .parse(args ?? {});

      const rows = await dbJobRuns.fetch({}, { sort: { startedAt: -1 }, limit: limit ?? 20 });

      return rows.map((r) => ({
        id: r._id.toString(),
        jobId: r.jobId,
        runKey: r.runKey,
        trigger: r.trigger,
        triggeredBy: r.triggeredBy ?? null,
        startedAt: r.startedAt,
        endedAt: r.endedAt ?? null,
        durationMs: r.endedAt ? r.endedAt.getTime() - r.startedAt.getTime() : null,
        status: r.status,
        observationsWritten: r.observationsWritten,
        observationsSkipped: r.observationsSkipped,
        errors: r.errors,
        outputSummary: r.outputSummary,
        sourceCoverage: r.sourceCoverage,
        generatorVersion: r.generatorVersion,
        dataOrigin: r.dataOrigin,
      }));
    },
  },

  mutations: {
    /**
     * Runs one ingestion cycle across all five source types on demand.
     * Uses the current cadence bucket as the run key, so pressing this twice
     * inside one bucket is a recorded no-op rather than duplicated evidence.
     */
    async runCycle(_args: unknown, { user }: { user: UserInfo | null }) {
      const now = new Date();
      const results = [];

      for (const sourceType of observationSourceTypes) {
        const result = await runIngestion({
          sourceType,
          runKey: bucketRunKey(sourceType, now, CADENCE[sourceType]),
          trigger: 'manual',
          triggeredBy: user?.id ?? 'anonymous',
        });
        results.push({ sourceType, ...result });
      }

      return {
        ranAt: now,
        results,
        written: results.reduce((a, r) => a + r.written, 0),
        skipped: results.reduce((a, r) => a + r.skipped, 0),
      };
    },

    /**
     * Replays a recorded run key. Proves determinism: a correct replay writes
     * zero new observations and leaves the original job run untouched.
     */
    async replayRun(args: unknown, { user }: { user: UserInfo | null }) {
      const { sourceType, runKey } = z
        .object({
          sourceType: z.enum(observationSourceTypes),
          runKey: z.string(),
        })
        .parse(args);

      const result = await runIngestion({
        sourceType,
        runKey,
        trigger: 'manual',
        triggeredBy: user?.id ?? 'anonymous',
      });

      return {
        ...result,
        deterministic: result.status === 'skipped',
        note:
          result.status === 'skipped'
            ? 'Run key already recorded — history was not forked or overwritten.'
            : 'Run key was not previously recorded, so a new run was created.',
      };
    },
  },

  cronJobs: {
    ingestOnChain: cronFor('on_chain'),
    ingestMicrostructure: cronFor('market_microstructure'),
    ingestNarrative: cronFor('narrative_social'),
    ingestRegulatory: cronFor('regulatory'),
    ingestSecurity: cronFor('security'),
  },
});
