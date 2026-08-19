import { z } from 'zod';
import { time } from 'modelence';
import { Module, type UserInfo } from 'modelence/server';

import {
  dbDebates,
  dbDebateParticipants,
  dbChallenges,
  dbDebateRounds,
  dbDebateOutcomes,
  debateOutcomeValues,
} from './db';
import { DEBATE_ENGINE_VERSION } from './engine';
import { latestThesisRunKey, runDebateCycle } from './run';

/**
 * core.debate — the reconciliation stage.
 *
 * OBSERVATION → AGENT THESIS → **DEBATE** → VALIDATION → RISK GATE → …
 * Outcomes here authorise nothing. Every outcome carries `requiresValidation`,
 * and no consumer may treat a DIRECTIONAL_CONSENSUS as permission to act.
 */
export default new Module('debate', {
  stores: [dbDebates, dbDebateParticipants, dbChallenges, dbDebateRounds, dbDebateOutcomes],

  queries: {
    async overview() {
      const [debates, challenges, outcomes] = await Promise.all([
        dbDebates.countDocuments({}),
        dbChallenges.countDocuments({}),
        dbDebateOutcomes.countDocuments({}),
      ]);

      const byOutcome = await Promise.all(
        debateOutcomeValues.map(async (outcome) => ({
          outcome,
          count: await dbDebateOutcomes.countDocuments({ outcome }),
        }))
      );

      const [upheld, dismissed, defeated] = await Promise.all([
        dbChallenges.countDocuments({ ruling: 'UPHELD' }),
        dbChallenges.countDocuments({ ruling: 'DISMISSED' }),
        dbDebateParticipants.countDocuments({ survived: false }),
      ]);

      const latestThesisRun = await latestThesisRunKey();

      return {
        counts: { debates, challenges, outcomes },
        byOutcome,
        adjudication: { upheld, dismissed, thesesDefeated: defeated },
        engineVersion: DEBATE_ENGINE_VERSION,
        latestThesisRun,
      };
    },

    async outcomes(args: unknown) {
      const { outcome, subjectId, limit } = z
        .object({
          outcome: z.enum(debateOutcomeValues).optional(),
          subjectId: z.string().optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .parse(args ?? {});

      const filter: Record<string, unknown> = {};
      if (outcome) filter.outcome = outcome;
      if (subjectId) filter.subjectId = subjectId;

      const rows = await dbDebateOutcomes.fetch(filter, {
        sort: { createdAt: -1, subjectId: 1 },
        limit: limit ?? 40,
      });

      return rows.map((o) => ({
        id: o._id.toString(),
        debateKey: o.debateKey,
        subjectId: o.subjectId,
        outcome: o.outcome,
        resolvedStance: o.resolvedStance ?? null,
        conviction: o.conviction,
        convictionSource: o.convictionSource,
        convictionFloor: o.convictionFloor,
        survivingCount: o.survivingThesisKeys.length,
        defeatedCount: o.defeatedThesisKeys.length,
        dissent: o.dissent,
        unresolvedQuestions: o.unresolvedQuestions,
        reasoning: o.reasoning,
        requiresValidation: o.requiresValidation,
        engineVersion: o.engineVersion,
        dataOrigin: o.dataOrigin,
        createdAt: o.createdAt,
      }));
    },

    /** Full transcript for one debate: rounds, challenges, rulings, outcome. */
    async transcript(args: unknown) {
      const { debateKey } = z.object({ debateKey: z.string() }).parse(args);

      const [debate, rounds, challenges, participants, outcome] = await Promise.all([
        dbDebates.requireOne({ debateKey }),
        dbDebateRounds.fetch({ debateKey }, { sort: { round: 1 } }),
        dbChallenges.fetch({ debateKey }, { sort: { round: 1 }, limit: 200 }),
        dbDebateParticipants.fetch({ debateKey }, { limit: 50 }),
        dbDebateOutcomes.findOne({ debateKey }),
      ]);

      return {
        debate: {
          debateKey: debate.debateKey,
          subjectId: debate.subjectId,
          thesisRunKey: debate.thesisRunKey,
          participantCount: debate.participantCount,
          challengeCount: debate.challengeCount,
          status: debate.status,
          openedAt: debate.openedAt,
          closedAt: debate.closedAt ?? null,
          engineVersion: debate.engineVersion,
        },
        rounds: rounds.map((r) => ({
          round: r.round,
          phase: r.phase,
          summary: r.summary,
          challengesRaised: r.challengesRaised,
          challengesUpheld: r.challengesUpheld,
          thesesDefeated: r.thesesDefeated,
        })),
        participants: participants.map((p) => ({
          thesisKey: p.thesisKey,
          agentId: p.agentId,
          discipline: p.discipline,
          stance: p.stance,
          statedConfidence: p.statedConfidence,
          citedObservationCount: p.citedObservationCount,
          weakestVerifiability: p.weakestVerifiability,
          survived: p.survived,
          upheldChallengesAgainst: p.upheldChallengesAgainst,
          defeatedBy: p.defeatedBy,
        })),
        challenges: challenges.map((c) => ({
          challengeKey: c.challengeKey,
          round: c.round,
          challengerAgentId: c.challengerAgentId,
          targetAgentId: c.targetAgentId,
          targetThesisKey: c.targetThesisKey,
          type: c.type,
          argument: c.argument,
          citedObservationKeys: c.citedObservationKeys,
          ruling: c.ruling,
          rulingRule: c.rulingRule,
          rulingRationale: c.rulingRationale,
        })),
        outcome: outcome
          ? {
              outcome: outcome.outcome,
              resolvedStance: outcome.resolvedStance ?? null,
              conviction: outcome.conviction,
              convictionSource: outcome.convictionSource,
              convictionFloor: outcome.convictionFloor,
              dissent: outcome.dissent,
              unresolvedQuestions: outcome.unresolvedQuestions,
              reasoning: outcome.reasoning,
              requiresValidation: outcome.requiresValidation,
            }
          : null,
      };
    },
  },

  mutations: {
    /** Runs debate over the most recent thesis run. */
    async runCycle(_args: unknown, { user }: { user: UserInfo | null }) {
      const thesisRunKey = await latestThesisRunKey();
      if (!thesisRunKey) {
        return {
          status: 'skipped' as const,
          written: 0,
          skipped: 0,
          errors: [],
          jobRunId: '',
          note: 'No thesis run exists yet. Run the agent swarm first — debate never runs on an empty record.',
        };
      }

      const result = await runDebateCycle({
        thesisRunKey,
        trigger: 'manual',
        triggeredBy: user?.id ?? 'anonymous',
      });

      return {
        ...result,
        thesisRunKey,
        note:
          result.status === 'skipped'
            ? 'This thesis run has already been debated — the existing transcript stands.'
            : `Debated thesis run ${thesisRunKey}.`,
      };
    },
  },

  cronJobs: {
    debateCycle: {
      description: 'Reconcile the latest agent thesis run through structured debate',
      interval: time.minutes(30),
      handler: async () => {
        const thesisRunKey = await latestThesisRunKey();
        if (!thesisRunKey) return;
        await runDebateCycle({ thesisRunKey, trigger: 'cron' });
      },
    },
  },
});
