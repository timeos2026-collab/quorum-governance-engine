import { z } from 'zod';
import { time } from 'modelence';
import { Module, type UserInfo } from 'modelence/server';

import { dbAgents, dbTheses, stanceValues } from './db';
import { CORE_AGENTS, AGENT_GENERATOR_VERSION } from './roster';
import { runThesisCycle, thesisRunKey } from './run';
import { dbObservations } from '../evidence/db';

/**
 * core.agents — the swarm stage of the pipeline.
 *
 * OBSERVATION → **AGENT THESIS** → DEBATE → … Agents read the shared evidence
 * layer and emit cited, falsifiable, confidence-capped theses. Nothing here
 * decides anything: a thesis is an input to debate, and consensus among agents
 * confers no authority to act.
 */

const CYCLE_MS = time.minutes(30);

export default new Module('agents', {
  stores: [dbAgents, dbTheses],

  queries: {
    async overview() {
      const [total, active] = await Promise.all([
        dbTheses.countDocuments({}),
        dbTheses.countDocuments({ status: 'ACTIVE' }),
      ]);

      const byStance = await Promise.all(
        stanceValues.map(async (stance) => ({
          stance,
          count: await dbTheses.countDocuments({ stance }),
        }))
      );

      const [capped, singleObs] = await Promise.all([
        dbTheses.countDocuments({ $expr: { $eq: ['$confidence', '$confidenceCap'] } }),
        dbTheses.countDocuments({ citedObservationCount: { $lt: 2 } }),
      ]);

      const [latest] = await dbTheses.fetch({}, { sort: { createdAt: -1 }, limit: 1 });

      return {
        counts: { total, active, agents: CORE_AGENTS.length },
        byStance,
        integrity: { confidenceCapped: capped, singleObservation: singleObs },
        generatorVersion: AGENT_GENERATOR_VERSION,
        latestRunKey: latest?.runKey ?? null,
        latestAt: latest?.createdAt ?? null,
      };
    },

    async roster() {
      const rows = await dbAgents.fetch({}, { sort: { discipline: 1 } });
      return Promise.all(
        rows.map(async (a) => ({
          agentId: a.agentId,
          name: a.name,
          discipline: a.discipline,
          mandate: a.mandate,
          sourceScope: a.sourceScope,
          metricScope: a.metricScope,
          maxConfidence: a.maxConfidence,
          agentVersion: a.agentVersion,
          enabled: a.enabled,
          moduleScope: a.moduleScope ?? null,
          thesisCount: await dbTheses.countDocuments({ agentId: a.agentId }),
        }))
      );
    },

    async theses(args: unknown) {
      const { subjectId, agentId, stance, runKey, limit } = z
        .object({
          subjectId: z.string().optional(),
          agentId: z.string().optional(),
          stance: z.enum(stanceValues).optional(),
          runKey: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        })
        .parse(args ?? {});

      const filter: Record<string, unknown> = {};
      if (subjectId) filter.subjectId = subjectId;
      if (agentId) filter.agentId = agentId;
      if (stance) filter.stance = stance;
      if (runKey) filter.runKey = runKey;

      const rows = await dbTheses.fetch(filter, {
        sort: { createdAt: -1, subjectId: 1, agentId: 1 },
        limit: limit ?? 80,
      });

      return rows.map((t) => ({
        id: t._id.toString(),
        thesisKey: t.thesisKey,
        agentId: t.agentId,
        agentVersion: t.agentVersion,
        discipline: t.discipline,
        subjectType: t.subjectType,
        subjectId: t.subjectId,
        stance: t.stance,
        confidence: t.confidence,
        confidenceCap: t.confidenceCap,
        confidenceCapReason: t.confidenceCapReason,
        rationale: t.rationale,
        falsifiableCondition: t.falsifiableCondition,
        weakestLink: t.weakestLink,
        citedObservationKeys: t.citedObservationKeys,
        citedObservationCount: t.citedObservationCount,
        evidenceGaps: t.evidenceGaps,
        weakestVerifiability: t.weakestVerifiability,
        evidenceOrigins: t.evidenceOrigins,
        evidenceWindowStart: t.evidenceWindowStart,
        evidenceWindowEnd: t.evidenceWindowEnd,
        status: t.status,
        runKey: t.runKey,
        createdAt: t.createdAt,
        dataOrigin: t.dataOrigin,
      }));
    },

    /**
     * Resolves a thesis's citations back to the exact observations it saw.
     * This is the provenance walk: thesis → evidence → producing job run.
     */
    async thesisEvidence(args: unknown) {
      const { thesisKey } = z.object({ thesisKey: z.string() }).parse(args);
      const thesis = await dbTheses.requireOne({ thesisKey });

      const observations = await dbObservations.fetch(
        { observationKey: { $in: thesis.citedObservationKeys } },
        { limit: 50 }
      );

      return {
        thesisKey: thesis.thesisKey,
        agentId: thesis.agentId,
        subjectId: thesis.subjectId,
        stance: thesis.stance,
        confidence: thesis.confidence,
        rationale: thesis.rationale,
        evidenceGaps: thesis.evidenceGaps,
        citations: observations.map((o) => ({
          observationKey: o.observationKey,
          sourceType: o.sourceType,
          source: o.source,
          metric: o.metric,
          value: o.value ?? null,
          unit: o.unit ?? null,
          statement: o.statement,
          verifiability: o.verifiability,
          observedAt: o.observedAt,
          retrievalTimestamp: o.retrievalTimestamp,
          dataOrigin: o.dataOrigin,
          jobRunId: o.jobRunId,
        })),
        /** Citations recorded but no longer resolvable — must always be zero. */
        unresolvedCitations: thesis.citedObservationKeys.filter(
          (k) => !observations.some((o) => o.observationKey === k)
        ),
      };
    },
  },

  mutations: {
    async runCycle(_args: unknown, { user }: { user: UserInfo | null }) {
      const now = new Date();
      const result = await runThesisCycle({
        runKey: thesisRunKey(now, CYCLE_MS),
        trigger: 'manual',
        triggeredBy: user?.id ?? 'anonymous',
        asOf: now,
      });
      return { ranAt: now, ...result };
    },

    /** Replays a recorded thesis run. A correct replay writes nothing. */
    async replayCycle(args: unknown, { user }: { user: UserInfo | null }) {
      const { runKey } = z.object({ runKey: z.string() }).parse(args);
      const result = await runThesisCycle({
        runKey,
        trigger: 'manual',
        triggeredBy: user?.id ?? 'anonymous',
      });
      return {
        ...result,
        deterministic: result.status === 'skipped',
        note:
          result.status === 'skipped'
            ? 'Run key already recorded — no theses were rewritten.'
            : 'Run key was not previously recorded, so a new run was created.',
      };
    },

    async setAgentEnabled(args: unknown) {
      const { agentId, enabled } = z
        .object({ agentId: z.string(), enabled: z.boolean() })
        .parse(args);
      await dbAgents.updateOne({ agentId }, { $set: { enabled, updatedAt: new Date() } });
      return { agentId, enabled };
    },
  },

  cronJobs: {
    thesisCycle: {
      description: 'Run the core agent swarm over the current evidence window',
      interval: CYCLE_MS,
      handler: async () => {
        const now = new Date();
        await runThesisCycle({
          runKey: thesisRunKey(now, CYCLE_MS),
          trigger: 'cron',
          asOf: now,
        });
      },
    },
  },
});
