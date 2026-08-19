import type { ChallengeType, DebateOutcomeType } from './db';
import type { Stance } from '../agents/db';

/**
 * DEBATE ENGINE — challenge generation and adjudication.
 *
 * Both stages are deterministic and rule-named. Every ruling records WHICH rule
 * fired, so an operator can dispute the rule rather than argue with a score.
 *
 * Nothing here averages, blends, or counts votes.
 */

export const DEBATE_ENGINE_VERSION = 'debate-engine@1.0.0';

export type ParticipantView = {
  thesisKey: string;
  agentId: string;
  discipline: string;
  stance: Stance;
  confidence: number;
  citedObservationKeys: string[];
  citedObservationCount: number;
  evidenceGaps: string[];
  weakestVerifiability: string;
  weakestLink: string;
  rationale: string;
  falsifiableCondition: string;
};

export type DraftChallenge = {
  challengerAgentId: string;
  challengerThesisKey?: string;
  targetAgentId: string;
  targetThesisKey: string;
  type: ChallengeType;
  argument: string;
  citedObservationKeys: string[];
};

const DIRECTIONAL: Stance[] = ['BULLISH', 'BEARISH'];
const WEAK_PROVENANCE = ['social_claim', 'unverified', 'assumption'];

/**
 * Generates the challenges each participant raises against the others.
 * Agents challenge from their own mandate only — the liquidity analyst attacks
 * exit feasibility, not narrative quality.
 */
export function generateChallenges(participants: ParticipantView[]): DraftChallenge[] {
  const out: DraftChallenge[] = [];
  const byAgent = new Map(participants.map((p) => [p.agentId, p]));

  const liquidity = byAgent.get('liquidity-analyst');
  const volume = byAgent.get('volume-integrity');
  const redTeam = byAgent.get('red-team');
  const regulatory = byAgent.get('regulatory-analyst');
  const security = byAgent.get('security-analyst');

  for (const target of participants) {
    // ABSTAIN says nothing, so there is nothing to attack.
    if (target.stance === 'ABSTAIN') continue;

    // 1. Exit feasibility — a directional case must answer whether it can get out.
    if (
      liquidity &&
      liquidity.agentId !== target.agentId &&
      DIRECTIONAL.includes(target.stance) &&
      (liquidity.stance === 'BEARISH' || liquidity.stance === 'BLOCK_RECOMMENDED')
    ) {
      out.push({
        challengerAgentId: liquidity.agentId,
        challengerThesisKey: liquidity.thesisKey,
        targetAgentId: target.agentId,
        targetThesisKey: target.thesisKey,
        type: 'EXIT_FEASIBILITY_CHALLENGE',
        argument: `${target.agentId} argues a ${target.stance} case without establishing that the position can be exited. ${liquidity.rationale}`,
        citedObservationKeys: liquidity.citedObservationKeys,
      });
    }

    // 2. Volume integrity — momentum built on non-economic volume is not momentum.
    if (
      volume &&
      volume.agentId !== target.agentId &&
      target.stance === 'BULLISH' &&
      (volume.stance === 'BEARISH' || volume.stance === 'BLOCK_RECOMMENDED')
    ) {
      out.push({
        challengerAgentId: volume.agentId,
        challengerThesisKey: volume.thesisKey,
        targetAgentId: target.agentId,
        targetThesisKey: target.thesisKey,
        type: 'VOLUME_INTEGRITY_CHALLENGE',
        argument: `${target.agentId}'s bullish case rests on activity that is materially non-economic. ${volume.rationale}`,
        citedObservationKeys: volume.citedObservationKeys,
      });
    }

    // 3. Provenance — a directional call resting on claims rather than facts.
    if (
      redTeam &&
      redTeam.agentId !== target.agentId &&
      DIRECTIONAL.includes(target.stance) &&
      WEAK_PROVENANCE.includes(target.weakestVerifiability)
    ) {
      out.push({
        challengerAgentId: redTeam.agentId,
        challengerThesisKey: redTeam.thesisKey,
        targetAgentId: target.agentId,
        targetThesisKey: target.thesisKey,
        type: 'PROVENANCE_CHALLENGE',
        argument: `${target.agentId} takes a ${target.stance} position whose weakest cited evidence is "${target.weakestVerifiability}". A claim is not a fact, and a directional position cannot rest on one.`,
        citedObservationKeys: [],
      });
    }

    // 4. Gaps — silence on declared metrics is not neutrality.
    if (redTeam && redTeam.agentId !== target.agentId && target.evidenceGaps.length > 0) {
      out.push({
        challengerAgentId: redTeam.agentId,
        challengerThesisKey: redTeam.thesisKey,
        targetAgentId: target.agentId,
        targetThesisKey: target.thesisKey,
        type: 'GAP_EXPLOITATION',
        argument: `${target.agentId} formed a ${target.stance} view while ${target.evidenceGaps.length} of its own declared inputs were missing (${target.evidenceGaps.join(', ')}). The stance reflects what was not measured as much as what was.`,
        citedObservationKeys: [],
      });
    }

    // 5. Weakest link — the defender's own stated vulnerability, used against it.
    if (redTeam && redTeam.agentId !== target.agentId && DIRECTIONAL.includes(target.stance)) {
      out.push({
        challengerAgentId: redTeam.agentId,
        challengerThesisKey: redTeam.thesisKey,
        targetAgentId: target.agentId,
        targetThesisKey: target.thesisKey,
        type: 'WEAKEST_LINK_ATTACK',
        argument: `${target.agentId} declared its own weakest link: "${target.weakestLink}". If that assumption fails, the ${target.stance} case fails with it, and nothing in the cited evidence rules it out.`,
        citedObservationKeys: target.citedObservationKeys,
      });
    }

    // 6. Hard blockers contradict any directional case outright.
    for (const blocker of [regulatory, security].filter(Boolean) as ParticipantView[]) {
      if (
        blocker.agentId !== target.agentId &&
        blocker.stance === 'BLOCK_RECOMMENDED' &&
        DIRECTIONAL.includes(target.stance)
      ) {
        out.push({
          challengerAgentId: blocker.agentId,
          challengerThesisKey: blocker.thesisKey,
          targetAgentId: target.agentId,
          targetThesisKey: target.thesisKey,
          type: 'EVIDENCE_CONTRADICTION',
          argument: `${blocker.agentId} finds a hard blocker that makes ${target.agentId}'s ${target.stance} case unactionable regardless of its merits. ${blocker.rationale}`,
          citedObservationKeys: blocker.citedObservationKeys,
        });
      }
    }
  }

  return out;
}

export type Ruling = {
  ruling: 'UPHELD' | 'DISMISSED';
  rule: string;
  rationale: string;
};

/**
 * Adjudicates one challenge. Named rules only — no scoring, no tie-breaking on
 * confidence. Where a rule does not clearly fire, the challenge is dismissed:
 * the burden is on the challenger.
 */
export function adjudicate(
  challenge: DraftChallenge,
  target: ParticipantView,
  challenger: ParticipantView | undefined
): Ruling {
  switch (challenge.type) {
    case 'EVIDENCE_CONTRADICTION':
      // A hard blocker beats a directional case on actionability, not on merit.
      return {
        ruling: 'UPHELD',
        rule: 'HARD_BLOCKER_PRECEDENCE',
        rationale:
          'A blocking finding removes the ability to act. The directional thesis may still be correct about direction; it cannot be acted on, so it cannot carry the debate.',
      };

    case 'EXIT_FEASIBILITY_CHALLENGE':
      if (!challenger) return dismiss('CHALLENGER_ABSENT');
      // Only a thesis that actually cited depth can defend on depth.
      if (target.citedObservationKeys.some((k) => k.includes('pool_depth_2pct_usd'))) {
        return {
          ruling: 'DISMISSED',
          rule: 'DEFENDER_PRICED_LIQUIDITY',
          rationale:
            'The defending thesis cited executable depth directly, so it has already accounted for exit feasibility.',
        };
      }
      return {
        ruling: 'UPHELD',
        rule: 'DIRECTIONAL_WITHOUT_EXIT_PATH',
        rationale:
          'A directional thesis that never cited executable depth has not established it can exit. Unexitable conviction is not a position.',
      };

    case 'VOLUME_INTEGRITY_CHALLENGE':
      return {
        ruling: 'UPHELD',
        rule: 'NON_ECONOMIC_VOLUME_INVALIDATES_MOMENTUM',
        rationale:
          'The activity the bullish case reads as demand is materially self-matched. The signal measures wash flow, so it cannot support the stance.',
      };

    case 'PROVENANCE_CHALLENGE':
      if (!WEAK_PROVENANCE.includes(target.weakestVerifiability)) {
        return dismiss('PROVENANCE_ADEQUATE');
      }
      return {
        ruling: 'UPHELD',
        rule: 'CLAIM_CANNOT_CARRY_DIRECTION',
        rationale: `The thesis's weakest cited evidence is "${target.weakestVerifiability}". Unverified assertions may colour a view but cannot carry a directional position.`,
      };

    case 'GAP_EXPLOITATION':
      // One missing input is a caveat. Half the declared inputs missing is a defect.
      if (target.evidenceGaps.length >= 2) {
        return {
          ruling: 'UPHELD',
          rule: 'MATERIAL_EVIDENCE_GAPS',
          rationale: `${target.evidenceGaps.length} declared inputs were unavailable. The stance is substantially an artefact of missing measurement.`,
        };
      }
      return {
        ruling: 'DISMISSED',
        rule: 'IMMATERIAL_GAP',
        rationale:
          'A single missing input is a stated caveat, not grounds to defeat the thesis. It is recorded on the thesis itself.',
      };

    case 'WEAKEST_LINK_ATTACK':
      // Self-declared vulnerability is honesty, not a defect — unless the thesis
      // is also thinly evidenced, in which case there is nothing holding it up.
      if (target.citedObservationCount < 2) {
        return {
          ruling: 'UPHELD',
          rule: 'THIN_EVIDENCE_UNDER_SELF_DECLARED_RISK',
          rationale:
            'The thesis rests on a single observation and has named an assumption that would break it. Nothing in its evidence rules that assumption out.',
        };
      }
      return {
        ruling: 'DISMISSED',
        rule: 'DECLARED_RISK_IS_NOT_DEFEAT',
        rationale:
          'Declaring a weakest link is the required standard, not a flaw. The challenge presents no evidence that the assumption has failed.',
      };
  }
}

function dismiss(rule: string): Ruling {
  return {
    ruling: 'DISMISSED',
    rule,
    rationale: 'The challenge did not meet its burden.',
  };
}

export type ResolutionInput = {
  participants: ParticipantView[];
  upheldByThesisKey: Map<string, string[]>;
};

export type Resolution = {
  outcome: DebateOutcomeType;
  resolvedStance?: Stance;
  conviction: number;
  convictionSource: string;
  convictionFloor: number;
  survivingThesisKeys: string[];
  defeatedThesisKeys: string[];
  unresolvedQuestions: string[];
  reasoning: string;
};

/**
 * Reconciliation.
 *
 * Survivors carry the outcome. Confidence is NEVER averaged: the reported
 * conviction is one named thesis's own stated confidence, and the floor is
 * reported alongside it so a wide spread stays visible rather than smoothing
 * into a middling number.
 */
export function resolve({ participants, upheldByThesisKey }: ResolutionInput): Resolution {
  const survivors = participants.filter((p) => (upheldByThesisKey.get(p.thesisKey) ?? []).length === 0);
  const defeated = participants.filter((p) => (upheldByThesisKey.get(p.thesisKey) ?? []).length > 0);

  const survivingThesisKeys = survivors.map((s) => s.thesisKey);
  const defeatedThesisKeys = defeated.map((s) => s.thesisKey);

  const unresolvedQuestions: string[] = [];
  for (const p of participants) {
    for (const gap of p.evidenceGaps) {
      const q = `Unmeasured: ${gap} (declared by ${p.agentId})`;
      if (!unresolvedQuestions.includes(q)) unresolvedQuestions.push(q);
    }
  }

  const blockers = survivors.filter((s) => s.stance === 'BLOCK_RECOMMENDED');
  const abstained = participants.filter((p) => p.stance === 'ABSTAIN');

  // 1. A surviving block ends the debate. It is not weighed against optimism.
  if (blockers.length > 0) {
    const lead = blockers.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    return {
      outcome: 'BLOCKED_BY_DEBATE',
      resolvedStance: 'BLOCK_RECOMMENDED',
      conviction: lead.confidence,
      convictionSource: `${lead.agentId} (${lead.thesisKey})`,
      convictionFloor: Math.min(...blockers.map((b) => b.confidence)),
      survivingThesisKeys,
      defeatedThesisKeys,
      unresolvedQuestions,
      reasoning: `${blockers.length} blocking finding(s) survived challenge: ${blockers.map((b) => b.agentId).join(', ')}. A surviving block is not weighed against the directional cases — it removes the ability to act on them. Carried by ${lead.agentId} at its own stated confidence of ${lead.confidence}; no confidences were combined.`,
    };
  }

  // 2. Everyone abstained or was defeated — nothing survived to argue anything.
  const directional = survivors.filter((s) => s.stance === 'BULLISH' || s.stance === 'BEARISH');
  if (survivors.length === 0 || abstained.length === participants.length) {
    return {
      outcome: 'INSUFFICIENT_EVIDENCE',
      conviction: 0,
      convictionSource: 'none',
      convictionFloor: 0,
      survivingThesisKeys,
      defeatedThesisKeys,
      unresolvedQuestions,
      reasoning:
        survivors.length === 0
          ? `Every thesis was defeated on challenge. No position survived, so there is nothing to validate.`
          : `All participating agents abstained for want of evidence. Absence of an argument is not a neutral view.`,
    };
  }

  if (directional.length === 0) {
    return {
      outcome: 'NO_ACTIONABLE_POSITION',
      resolvedStance: 'NEUTRAL',
      conviction: 0,
      convictionSource: 'none',
      convictionFloor: 0,
      survivingThesisKeys,
      defeatedThesisKeys,
      unresolvedQuestions,
      reasoning: `${survivors.length} thesis/theses survived but none argues for a direction. Neutral is a finding, not a position to size.`,
    };
  }

  const bulls = directional.filter((d) => d.stance === 'BULLISH');
  const bears = directional.filter((d) => d.stance === 'BEARISH');

  // 3. Genuine unresolved disagreement is reported as such, never split.
  if (bulls.length > 0 && bears.length > 0) {
    const lead = directional.reduce((a, b) => (b.confidence > a.confidence ? b : a));
    unresolvedQuestions.push(
      `Direction unresolved: ${bulls.map((b) => b.agentId).join(', ')} argue bullish against ${bears.map((b) => b.agentId).join(', ')} bearish, and no challenge defeated either side.`
    );
    return {
      outcome: 'CONTESTED',
      conviction: lead.confidence,
      convictionSource: `${lead.agentId} (${lead.thesisKey})`,
      convictionFloor: Math.min(...directional.map((d) => d.confidence)),
      survivingThesisKeys,
      defeatedThesisKeys,
      unresolvedQuestions,
      reasoning: `Surviving theses disagree on direction and neither side was defeated on the evidence. The disagreement is reported rather than resolved — splitting the difference would manufacture a position no agent actually holds. Both cases are preserved in dissent.`,
    };
  }

  const side = bulls.length > 0 ? bulls : bears;
  const lead = side.reduce((a, b) => (b.confidence > a.confidence ? b : a));
  const floor = Math.min(...side.map((s) => s.confidence));

  return {
    outcome: 'DIRECTIONAL_CONSENSUS',
    resolvedStance: side[0].stance,
    conviction: lead.confidence,
    convictionSource: `${lead.agentId} (${lead.thesisKey})`,
    convictionFloor: floor,
    survivingThesisKeys,
    defeatedThesisKeys,
    unresolvedQuestions,
    reasoning: `${side.length} surviving thesis/theses argue ${side[0].stance} and none was defeated. Conviction is reported as ${lead.agentId}'s own stated ${lead.confidence}${floor !== lead.confidence ? `, with the weakest survivor at ${floor} — the spread is reported, not averaged` : ''}. Agreement here is not authority: this outcome must still pass validation and the risk gate.`,
  };
}
