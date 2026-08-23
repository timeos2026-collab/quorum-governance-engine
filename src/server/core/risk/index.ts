import { z } from 'zod';
import { time, AuthError } from 'modelence';
import { Module, type UserInfo } from 'modelence/server';

import {
  dbRiskAssessments,
  dbRiskFindings,
  dbRiskOverrides,
  dbRiskPolicies,
  riskVerdictValues,
  riskDomainValues,
} from './db';
import { RISK_ENGINE_VERSION, RISK_RULES, policyKeyOf } from './rules';
import { latestValidationRunKey, runGateCycle, syncPolicies } from './run';

/**
 * core.risk — the single chokepoint.
 *
 * OBSERVATION → THESIS → DEBATE → VALIDATION → **RISK GATE** → HUMAN → ACTION
 *
 * No business-line module implements its own risk logic. Trading, private
 * equity, private credit, investment banking and AUM all route through this
 * module or they do not act.
 */
export default new Module('risk', {
  stores: [dbRiskPolicies, dbRiskAssessments, dbRiskFindings, dbRiskOverrides],

  queries: {
    async overview() {
      const [assessments, findings, overrides, policies] = await Promise.all([
        dbRiskAssessments.countDocuments({}),
        dbRiskFindings.countDocuments({}),
        dbRiskOverrides.countDocuments({}),
        dbRiskPolicies.countDocuments({}),
      ]);

      const byVerdict = await Promise.all(
        riskVerdictValues.map(async (verdict) => ({
          verdict,
          count: await dbRiskAssessments.countDocuments({ verdict }),
        }))
      );

      const byDomain = await Promise.all(
        riskDomainValues.map(async (domain) => {
          const [blocked, human, restricted, approved] = await Promise.all([
            dbRiskFindings.countDocuments({ domain, verdict: 'BLOCKED' }),
            dbRiskFindings.countDocuments({ domain, verdict: 'REQUIRES_HUMAN_APPROVAL' }),
            dbRiskFindings.countDocuments({ domain, verdict: 'APPROVED_WITH_RESTRICTIONS' }),
            dbRiskFindings.countDocuments({ domain, verdict: 'APPROVED' }),
          ]);
          return { domain, blocked, human, restricted, approved };
        })
      );

      return {
        counts: { assessments, findings, overrides, policies },
        byVerdict,
        byDomain,
        engineVersion: RISK_ENGINE_VERSION,
        latestValidationRun: await latestValidationRunKey(),
      };
    },

    /** The ruleset in force, as an operator-readable policy list. */
    async policies() {
      const rows = await dbRiskPolicies.fetch({}, { sort: { domain: 1, ruleId: 1 }, limit: 100 });
      return rows.map((p) => ({
        policyKey: p.policyKey,
        ruleId: p.ruleId,
        version: p.version,
        domain: p.domain,
        title: p.title,
        statement: p.statement,
        rationale: p.rationale,
        maxVerdict: p.maxVerdict,
        overridable: p.overridable,
        effectiveFrom: p.effectiveFrom,
      }));
    },

    async assessments(args: unknown) {
      const { verdict, limit } = z
        .object({
          verdict: z.enum(riskVerdictValues).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .parse(args ?? {});

      const filter: Record<string, unknown> = {};
      if (verdict) filter.verdict = verdict;

      const rows = await dbRiskAssessments.fetch(filter, {
        sort: { createdAt: -1, assessmentKey: 1 },
        limit: limit ?? 40,
      });

      return rows.map((a) => ({
        assessmentKey: a.assessmentKey,
        strategyKey: a.strategyKey,
        subjectId: a.subjectId,
        moduleScope: a.moduleScope,
        proposedAction: a.proposedAction,
        proposedSizeUsd: a.proposedSizeUsd,
        verdict: a.verdict,
        decisiveRuleId: a.decisiveRuleId ?? null,
        rationale: a.rationale,
        restrictions: a.restrictions,
        permittedSizeUsd: a.permittedSizeUsd,
        permittedExecutionMode: a.permittedExecutionMode,
        findingCount: a.findingCount,
        blockingFindingCount: a.blockingFindingCount,
        citedObservationCount: a.citedObservationKeys.length,
        engineVersion: a.engineVersion,
        dataOrigin: a.dataOrigin,
        createdAt: a.createdAt,
      }));
    },

    /** Every rule's finding for one assessment, plus any human overrides. */
    async findings(args: unknown) {
      const { assessmentKey } = z.object({ assessmentKey: z.string() }).parse(args);

      const [findings, overrides] = await Promise.all([
        dbRiskFindings.fetch({ assessmentKey }, { limit: 50 }),
        dbRiskOverrides.fetch({ assessmentKey }, { sort: { createdAt: -1 }, limit: 20 }),
      ]);

      return {
        findings: findings.map((f) => ({
          findingKey: f.findingKey,
          ruleId: f.ruleId,
          policyKey: f.policyKey,
          domain: f.domain,
          verdict: f.verdict,
          finding: f.finding,
          evidence: f.evidence,
          citedObservationKeys: f.citedObservationKeys,
          overridable: f.overridable,
        })),
        overrides: overrides.map((o) => ({
          actor: o.actor,
          decision: o.decision,
          overriddenVerdict: o.overriddenVerdict,
          resultingVerdict: o.resultingVerdict,
          reason: o.reason,
          acknowledgedFindings: o.acknowledgedFindings,
          createdAt: o.createdAt,
        })),
      };
    },
  },

  mutations: {
    async runCycle(_args: unknown, { user }: { user: UserInfo | null }) {
      const validationRunKey = await latestValidationRunKey();
      if (!validationRunKey) {
        return {
          status: 'skipped' as const,
          assessed: 0,
          errors: [],
          jobRunId: '',
          note: 'No validated strategy exists yet. The gate has nothing to assess — and it will not assess anything that has not passed validation.',
        };
      }

      const result = await runGateCycle({
        validationRunKey,
        trigger: 'manual',
        triggeredBy: user?.id ?? 'anonymous',
      });

      return {
        ...result,
        validationRunKey,
        note:
          result.status === 'skipped'
            ? 'This validation run has already been gated — the existing assessments stand.'
            : `Gated validation run ${validationRunKey}.`,
      };
    },

    /**
     * Human decision on a REQUIRES_HUMAN_APPROVAL assessment.
     *
     * A BLOCKED assessment cannot be released here. Not because of a missing
     * feature, but because a hard block should require changing the rule or the
     * underlying fact — both versioned and attributable — rather than being
     * dismissed from a screen at 2am.
     */
    async overrideAssessment(args: unknown, { user }: { user: UserInfo | null }) {
      if (!user) throw new AuthError('Risk overrides require an authenticated human.');

      const { assessmentKey, decision, reason } = z
        .object({
          assessmentKey: z.string(),
          decision: z.enum(['APPROVE', 'REJECT']),
          reason: z.string().min(20),
        })
        .parse(args);

      const assessment = await dbRiskAssessments.requireOne({ assessmentKey });

      if (assessment.verdict === 'BLOCKED') {
        throw new Error(
          'A BLOCKED assessment cannot be overridden. Clear the block by changing the rule or the underlying fact — both are versioned and attributable — not by waving it through.'
        );
      }
      if (assessment.verdict !== 'REQUIRES_HUMAN_APPROVAL' && decision === 'APPROVE') {
        throw new Error(
          `Assessment is ${assessment.verdict}; there is no pending human decision to approve.`
        );
      }

      const blockingFindings = await dbRiskFindings.fetch(
        {
          assessmentKey,
          verdict: { $in: ['BLOCKED', 'REQUIRES_HUMAN_APPROVAL'] },
        },
        { limit: 50 }
      );

      const resultingVerdict =
        decision === 'APPROVE' ? 'APPROVED_WITH_RESTRICTIONS' : 'BLOCKED';

      // The override is a NEW permanent record. The original assessment is
      // never edited — what the gate said stands in the record forever.
      await dbRiskOverrides.insertOne({
        assessmentKey,
        strategyKey: assessment.strategyKey,
        actor: user.id,
        decision,
        overriddenVerdict: assessment.verdict,
        resultingVerdict,
        reason,
        acknowledgedFindings: blockingFindings.map((f) => `${f.ruleId}: ${f.finding}`),
        createdAt: new Date(),
      });

      return {
        assessmentKey,
        decision,
        overriddenVerdict: assessment.verdict,
        resultingVerdict,
        acknowledged: blockingFindings.length,
        note: 'The original assessment is unchanged. This override is a permanent additional record attributed to you.',
      };
    },

    /** Re-mirrors the in-code ruleset into the policy store. */
    async syncPolicies() {
      const count = await syncPolicies();
      return { policies: count, ruleset: RISK_RULES.map(policyKeyOf) };
    },
  },

  cronJobs: {
    gateCycle: {
      description: 'Assess every validated strategy against the risk ruleset',
      interval: time.minutes(30),
      handler: async () => {
        const validationRunKey = await latestValidationRunKey();
        if (!validationRunKey) return;
        await runGateCycle({ validationRunKey, trigger: 'cron' });
      },
    },
  },
});
