import { dbJobRuns } from '../evidence/db';
import { dbTheses } from '../agents/db';
import {
  dbDebates,
  dbDebateParticipants,
  dbChallenges,
  dbDebateRounds,
  dbDebateOutcomes,
} from './db';
import {
  DEBATE_ENGINE_VERSION,
  adjudicate,
  generateChallenges,
  resolve,
  type ParticipantView,
} from './engine';

/**
 * DEBATE RUN ORCHESTRATOR
 *
 * One debate per subject per thesis run, on the shared append-only job ledger.
 * A debate consumes exactly one thesis run — it never mixes theses formed over
 * different evidence windows, which would let a stale thesis argue against a
 * fresh one without that being visible.
 */

const JOB_ID = 'debate.reconcile';

export function debateRunKey(thesisRunKey: string) {
  return `debate:${thesisRunKey}`;
}

export type DebateRunResult = {
  jobRunId: string;
  status: 'succeeded' | 'failed' | 'skipped';
  written: number;
  skipped: number;
  errors: string[];
};

/** Most recent completed thesis run, or null if the swarm has never run. */
export async function latestThesisRunKey(): Promise<string | null> {
  const [latest] = await dbTheses.fetch({}, { sort: { createdAt: -1 }, limit: 1 });
  return latest?.runKey ?? null;
}

export async function runDebateCycle({
  thesisRunKey,
  trigger,
  triggeredBy,
}: {
  thesisRunKey: string;
  trigger: 'cron' | 'manual';
  triggeredBy?: string;
}): Promise<DebateRunResult> {
  const runKey = debateRunKey(thesisRunKey);

  const existing = await dbJobRuns.findOne({ jobId: JOB_ID, runKey });
  if (existing) {
    return {
      jobRunId: existing._id.toString(),
      status: 'skipped',
      written: 0,
      skipped: existing.observationsWritten,
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
    inputSnapshot: JSON.stringify({ thesisRunKey, engineVersion: DEBATE_ENGINE_VERSION }),
    outputSummary: '',
    observationsWritten: 0,
    observationsSkipped: 0,
    errors: [],
    generatorVersion: DEBATE_ENGINE_VERSION,
    sourceCoverage: [],
    dataOrigin: 'simulated',
  });
  const jobRunId = insertedId.toString();

  const errors: string[] = [];
  let written = 0;
  let skipped = 0;
  const coverage = new Set<string>();

  try {
    const theses = await dbTheses.fetch({ runKey: thesisRunKey }, { limit: 2000 });

    // Group by subject — one debate per subject.
    const bySubject = new Map<string, typeof theses>();
    for (const t of theses) {
      const list = bySubject.get(t.subjectId) ?? [];
      list.push(t);
      bySubject.set(t.subjectId, list);
    }

    for (const [subjectId, subjectTheses] of bySubject) {
      const debateKey = `${JOB_ID}:${runKey}:${subjectId}`;

      if (await dbDebates.findOne({ debateKey })) {
        skipped++;
        continue;
      }

      const participants: ParticipantView[] = subjectTheses.map((t) => ({
        thesisKey: t.thesisKey,
        agentId: t.agentId,
        discipline: t.discipline,
        stance: t.stance,
        confidence: t.confidence,
        citedObservationKeys: t.citedObservationKeys,
        citedObservationCount: t.citedObservationCount,
        evidenceGaps: t.evidenceGaps,
        weakestVerifiability: t.weakestVerifiability,
        weakestLink: t.weakestLink,
        rationale: t.rationale,
        falsifiableCondition: t.falsifiableCondition,
      }));

      try {
        const drafts = generateChallenges(participants);
        const byKey = new Map(participants.map((p) => [p.thesisKey, p]));
        const upheldByThesisKey = new Map<string, string[]>();
        let upheldCount = 0;

        await dbDebates.insertOne({
          debateKey,
          subjectType: 'token',
          subjectId,
          thesisRunKey,
          runKey,
          jobRunId,
          participantCount: participants.length,
          challengeCount: drafts.length,
          roundCount: 3,
          openedAt: startedAt,
          status: 'OPEN',
          engineVersion: DEBATE_ENGINE_VERSION,
          dataOrigin: 'simulated',
        });

        // Round 1 — opening positions on the record.
        await dbDebateRounds.insertOne({
          debateKey,
          round: 1,
          phase: 'OPENING',
          summary: `${participants.length} agents tabled positions on ${subjectId}: ${participants
            .map((p) => `${p.agentId} ${p.stance}@${p.confidence}`)
            .join(', ')}.`,
          challengesRaised: 0,
          challengesUpheld: 0,
          thesesDefeated: 0,
          createdAt: startedAt,
        });

        // Round 2 — challenges raised and adjudicated by named rule.
        for (const d of drafts) {
          const target = byKey.get(d.targetThesisKey);
          if (!target) continue;
          const challenger = d.challengerThesisKey ? byKey.get(d.challengerThesisKey) : undefined;
          const ruling = adjudicate(d, target, challenger);

          if (ruling.ruling === 'UPHELD') {
            upheldCount++;
            const list = upheldByThesisKey.get(d.targetThesisKey) ?? [];
            list.push(`${d.challengerAgentId}:${d.type}`);
            upheldByThesisKey.set(d.targetThesisKey, list);
          }

          coverage.add(d.type);

          await dbChallenges.insertOne({
            challengeKey: `${debateKey}:${d.challengerAgentId}:${d.targetThesisKey}:${d.type}`,
            debateKey,
            round: 2,
            challengerAgentId: d.challengerAgentId,
            challengerThesisKey: d.challengerThesisKey,
            targetAgentId: d.targetAgentId,
            targetThesisKey: d.targetThesisKey,
            type: d.type,
            argument: d.argument,
            citedObservationKeys: d.citedObservationKeys,
            ruling: ruling.ruling,
            rulingRule: ruling.rule,
            rulingRationale: ruling.rationale,
            createdAt: startedAt,
          });
        }

        await dbDebateRounds.insertOne({
          debateKey,
          round: 2,
          phase: 'CHALLENGE',
          summary: `${drafts.length} challenge(s) raised, ${upheldCount} upheld under named adjudication rules.`,
          challengesRaised: drafts.length,
          challengesUpheld: upheldCount,
          thesesDefeated: upheldByThesisKey.size,
          createdAt: startedAt,
        });

        // Participants recorded with their survival status.
        for (const p of participants) {
          const defeatedBy = upheldByThesisKey.get(p.thesisKey) ?? [];
          await dbDebateParticipants.insertOne({
            debateKey,
            thesisKey: p.thesisKey,
            agentId: p.agentId,
            discipline: p.discipline,
            stance: p.stance,
            statedConfidence: p.confidence,
            citedObservationCount: p.citedObservationCount,
            weakestVerifiability: p.weakestVerifiability,
            survived: defeatedBy.length === 0,
            upheldChallengesAgainst: defeatedBy.length,
            defeatedBy,
            createdAt: startedAt,
          });
        }

        // Round 3 — reconciliation.
        const resolution = resolve({ participants, upheldByThesisKey });

        await dbDebateRounds.insertOne({
          debateKey,
          round: 3,
          phase: 'RECONCILIATION',
          summary: resolution.reasoning,
          challengesRaised: 0,
          challengesUpheld: 0,
          thesesDefeated: upheldByThesisKey.size,
          createdAt: startedAt,
        });

        await dbDebateOutcomes.insertOne({
          debateKey,
          subjectId,
          outcome: resolution.outcome,
          resolvedStance: resolution.resolvedStance,
          conviction: resolution.conviction,
          convictionSource: resolution.convictionSource,
          convictionFloor: resolution.convictionFloor,
          survivingThesisKeys: resolution.survivingThesisKeys,
          defeatedThesisKeys: resolution.defeatedThesisKeys,
          // Every position is preserved, including the losing ones.
          dissent: participants.map((p) => ({
            agentId: p.agentId,
            stance: p.stance,
            confidence: p.confidence,
            argument: p.rationale,
            survived: (upheldByThesisKey.get(p.thesisKey) ?? []).length === 0,
          })),
          unresolvedQuestions: resolution.unresolvedQuestions,
          reasoning: resolution.reasoning,
          requiresValidation: true,
          engineVersion: DEBATE_ENGINE_VERSION,
          dataOrigin: 'simulated',
          createdAt: startedAt,
        });

        await dbDebates.updateOne(
          { debateKey },
          { $set: { status: 'CLOSED', closedAt: new Date() } }
        );

        written++;
      } catch (e) {
        const message = (e as Error).message ?? String(e);
        if (message.includes('E11000') || message.toLowerCase().includes('duplicate')) {
          skipped++;
        } else {
          errors.push(`${subjectId}: ${message}`);
        }
      }
    }

    const endedAt = new Date();
    await dbJobRuns.updateOne(
      { _id: insertedId },
      {
        $set: {
          endedAt,
          status: errors.length > 0 ? 'failed' : 'succeeded',
          observationsWritten: written,
          observationsSkipped: skipped,
          errors,
          sourceCoverage: [...coverage],
          outputSummary: `${written} debate(s) resolved, ${skipped} already present, ${errors.length} errors over thesis run ${thesisRunKey} in ${endedAt.getTime() - startedAt.getTime()}ms.`,
        },
      }
    );

    return {
      jobRunId,
      status: errors.length > 0 ? 'failed' : 'succeeded',
      written,
      skipped,
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
          observationsWritten: written,
          observationsSkipped: skipped,
          errors: [...errors, message],
          sourceCoverage: [...coverage],
          outputSummary: `Debate run aborted: ${message}`,
        },
      }
    );
    return { jobRunId, status: 'failed', written, skipped, errors: [...errors, message] };
  }
}
