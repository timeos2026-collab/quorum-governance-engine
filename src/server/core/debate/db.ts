import { Store, schema } from 'modelence/server';
import { dataOriginValues } from '../registry/db';
import { stanceValues } from '../agents/db';

/**
 * QUORUM DEBATE ENGINE
 *
 * Theses do not become decisions by agreeing with each other. They are put in
 * opposition, challenged on their stated weakest links, and adjudicated by
 * explicit rules.
 *
 * THE CORE RULE: confidence is never averaged, and votes are never counted.
 * Averaging is how a governance engine launders one decisive objection into a
 * comfortable number. Instead:
 *  - A thesis SURVIVES or is DEFEATED by named, individually recorded challenges.
 *  - The outcome is carried by the surviving theses only.
 *  - `convictionSource` names the single thesis carrying the outcome — never a
 *    blend of several.
 *  - Dissent is preserved permanently on the outcome, including when it lost.
 *  - A debate outcome is an INPUT TO VALIDATION. It authorises nothing.
 */

export const challengeTypeValues = [
  /** Two theses cite evidence that cannot both be acted on. */
  'EVIDENCE_CONTRADICTION',
  /** Attacks the weakest link the defender itself declared. */
  'WEAKEST_LINK_ATTACK',
  /** The thesis leans on claims, not verified facts. */
  'PROVENANCE_CHALLENGE',
  /** The thesis is silent on metrics it declared it would read. */
  'GAP_EXPLOITATION',
  /** A directional case that ignores whether the position can be exited. */
  'EXIT_FEASIBILITY_CHALLENGE',
  /** A momentum/interest case built on volume known to be non-economic. */
  'VOLUME_INTEGRITY_CHALLENGE',
] as const;
export type ChallengeType = (typeof challengeTypeValues)[number];

export const challengeRulingValues = ['UPHELD', 'DISMISSED'] as const;

export const debateOutcomeValues = [
  'BLOCKED_BY_DEBATE',
  'DIRECTIONAL_CONSENSUS',
  'CONTESTED',
  'NO_ACTIONABLE_POSITION',
  'INSUFFICIENT_EVIDENCE',
] as const;
export type DebateOutcomeType = (typeof debateOutcomeValues)[number];

export const dbDebates = new Store('coreDebates', {
  schema: {
    /** `${jobId}:${runKey}:${subjectId}` */
    debateKey: schema.string(),
    subjectType: schema.enum(['token', 'venue', 'chain', 'jurisdiction']),
    subjectId: schema.string(),
    /** Thesis run this debate consumed. Debate never mixes runs. */
    thesisRunKey: schema.string(),
    runKey: schema.string(),
    jobRunId: schema.string(),
    participantCount: schema.number(),
    challengeCount: schema.number(),
    roundCount: schema.number(),
    openedAt: schema.date(),
    closedAt: schema.date().optional(),
    status: schema.enum(['OPEN', 'CLOSED']),
    engineVersion: schema.string(),
    dataOrigin: schema.enum(dataOriginValues),
  },
  indexes: [
    { key: { debateKey: 1 }, unique: true },
    { key: { subjectId: 1, openedAt: -1 } },
    { key: { runKey: 1 } },
    { key: { openedAt: -1 } },
  ],
});

export const dbDebateParticipants = new Store('coreDebateParticipants', {
  schema: {
    debateKey: schema.string(),
    thesisKey: schema.string(),
    agentId: schema.string(),
    discipline: schema.string(),
    stance: schema.enum(stanceValues),
    /** Confidence AS STATED by the agent. Never merged with any other value. */
    statedConfidence: schema.number(),
    citedObservationCount: schema.number(),
    weakestVerifiability: schema.string(),
    /** Set once adjudication completes. */
    survived: schema.boolean(),
    upheldChallengesAgainst: schema.number(),
    defeatedBy: schema.array(schema.string()),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { debateKey: 1, thesisKey: 1 }, unique: true },
    { key: { agentId: 1 } },
    { key: { debateKey: 1, survived: 1 } },
  ],
});

export const dbChallenges = new Store('coreThesisChallenges', {
  schema: {
    /** `${debateKey}:${challengerAgentId}:${targetThesisKey}:${type}` */
    challengeKey: schema.string(),
    debateKey: schema.string(),
    round: schema.number(),

    challengerAgentId: schema.string(),
    challengerThesisKey: schema.string().optional(),
    targetAgentId: schema.string(),
    targetThesisKey: schema.string(),

    type: schema.enum(challengeTypeValues),
    /** The argument, stated so a human can judge it independently. */
    argument: schema.string(),
    /** Observation keys the challenge itself rests on. */
    citedObservationKeys: schema.array(schema.string()),

    ruling: schema.enum(challengeRulingValues),
    /** Which adjudication rule fired, by name. Never a score. */
    rulingRule: schema.string(),
    rulingRationale: schema.string(),

    createdAt: schema.date(),
  },
  indexes: [
    { key: { challengeKey: 1 }, unique: true },
    { key: { debateKey: 1, round: 1 } },
    { key: { targetThesisKey: 1 } },
    { key: { ruling: 1 } },
  ],
});

export const dbDebateRounds = new Store('coreDebateRounds', {
  schema: {
    debateKey: schema.string(),
    round: schema.number(),
    phase: schema.enum(['OPENING', 'CHALLENGE', 'ADJUDICATION', 'RECONCILIATION']),
    summary: schema.string(),
    challengesRaised: schema.number(),
    challengesUpheld: schema.number(),
    thesesDefeated: schema.number(),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { debateKey: 1, round: 1 }, unique: true },
    { key: { debateKey: 1 } },
  ],
});

export const dbDebateOutcomes = new Store('coreDebateOutcomes', {
  schema: {
    debateKey: schema.string(),
    subjectId: schema.string(),
    outcome: schema.enum(debateOutcomeValues),

    /** Surviving stance, if the debate produced one. */
    resolvedStance: schema.enum(stanceValues).optional(),
    /**
     * Confidence of THE single strongest surviving thesis. This is a pointer to
     * one agent's stated confidence, not a blend. `convictionSource` names it.
     */
    conviction: schema.number(),
    convictionSource: schema.string(),
    /** Lowest surviving confidence, kept so the spread stays visible. */
    convictionFloor: schema.number(),

    survivingThesisKeys: schema.array(schema.string()),
    defeatedThesisKeys: schema.array(schema.string()),

    /** Preserved permanently, including when it lost the debate. */
    dissent: schema.array(
      schema.object({
        agentId: schema.string(),
        stance: schema.string(),
        confidence: schema.number(),
        argument: schema.string(),
        survived: schema.boolean(),
      })
    ),
    /** Questions the debate could not settle on the available evidence. */
    unresolvedQuestions: schema.array(schema.string()),

    reasoning: schema.string(),
    /**
     * Always true. A debate outcome is never an authority to act — it must pass
     * validation and then the risk gate. Stored explicitly so the constraint is
     * visible in the record itself, not just in code.
     */
    requiresValidation: schema.boolean(),

    engineVersion: schema.string(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { debateKey: 1 }, unique: true },
    { key: { subjectId: 1, createdAt: -1 } },
    { key: { outcome: 1, createdAt: -1 } },
  ],
});
