import { z } from 'zod';
import { time, AuthError } from 'modelence';
import { Module, type UserInfo } from 'modelence/server';

import {
  dbStrategies,
  dbStrategyTransitions,
  dbValidationRuns,
  dbValidationTests,
  strategyStateValues,
  testTypeValues,
} from './db';
import { VALIDATION_ENGINE_VERSION } from './harness';
import { latestDebateRunKey, runValidationCycle } from './run';

/**
 * core.validation — the stage that decides whether a debated position has ever
 * been shown to work.
 *
 * OBSERVATION → THESIS → DEBATE → **VALIDATION** → RISK GATE → …
 *
 * Nothing here grants permission to trade. The furthest the engine can move a
 * strategy on its own is PAPER. SHADOW and PRODUCTION are human-only and are
 * enforced in the transition guard, not by convention.
 */
export default new Module('validation', {
  stores: [dbStrategies, dbValidationRuns, dbValidationTests, dbStrategyTransitions],

  queries: {
    async overview() {
      const [strategies, runs, tests] = await Promise.all([
        dbStrategies.countDocuments({}),
        dbValidationRuns.countDocuments({}),
        dbValidationTests.countDocuments({}),
      ]);

      const byState = await Promise.all(
        strategyStateValues.map(async (state) => ({
          state,
          count: await dbStrategies.countDocuments({ state }),
        }))
      );

      const byTest = await Promise.all(
        testTypeValues.map(async (type) => {
          const [pass, fail, inconclusive] = await Promise.all([
            dbValidationTests.countDocuments({ type, result: 'PASS' }),
            dbValidationTests.countDocuments({ type, result: 'FAIL' }),
            dbValidationTests.countDocuments({ type, result: 'INCONCLUSIVE' }),
          ]);
          return { type, pass, fail, inconclusive };
        })
      );

      const [inProduction, inShadow, inPaper] = await Promise.all([
        dbStrategies.countDocuments({ state: 'PRODUCTION' }),
        dbStrategies.countDocuments({ state: 'SHADOW' }),
        dbStrategies.countDocuments({ state: 'PAPER' }),
      ]);

      const latestDebateRun = await latestDebateRunKey();

      return {
        counts: { strategies, runs, tests },
        byState,
        byTest,
        execution: { inPaper, inShadow, inProduction },
        engineVersion: VALIDATION_ENGINE_VERSION,
        latestDebateRun,
      };
    },

    async strategies(args: unknown) {
      const { state, limit } = z
        .object({
          state: z.enum(strategyStateValues).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .parse(args ?? {});

      const filter: Record<string, unknown> = {};
      if (state) filter.state = state;

      const rows = await dbStrategies.fetch(filter, {
        sort: { updatedAt: -1, strategyKey: 1 },
        limit: limit ?? 50,
      });

      return rows.map((s) => ({
        strategyKey: s.strategyKey,
        name: s.name,
        subjectId: s.subjectId,
        moduleScope: s.moduleScope,
        stance: s.stance,
        conviction: s.conviction,
        convictionSource: s.originConvictionSource,
        state: s.state,
        stateReason: s.stateReason,
        stateChangedAt: s.stateChangedAt,
        promotedBy: s.promotedBy ?? null,
        testsPassed: s.testsPassed,
        testsFailed: s.testsFailed,
        testsInconclusive: s.testsInconclusive,
        originDebateKey: s.originDebateKey,
        dataOrigin: s.dataOrigin,
        createdAt: s.createdAt,
      }));
    },

    /** Full validation dossier for one strategy: every test, every transition. */
    async dossier(args: unknown) {
      const { strategyKey } = z.object({ strategyKey: z.string() }).parse(args);

      const strategy = await dbStrategies.requireOne({ strategyKey });
      const [runs, tests, transitions] = await Promise.all([
        dbValidationRuns.fetch({ strategyKey }, { sort: { createdAt: -1 }, limit: 20 }),
        dbValidationTests.fetch({ strategyKey }, { sort: { createdAt: -1 }, limit: 120 }),
        dbStrategyTransitions.fetch({ strategyKey }, { sort: { createdAt: 1 }, limit: 100 }),
      ]);

      return {
        strategy: {
          strategyKey: strategy.strategyKey,
          name: strategy.name,
          subjectId: strategy.subjectId,
          stance: strategy.stance,
          conviction: strategy.conviction,
          convictionSource: strategy.originConvictionSource,
          state: strategy.state,
          stateReason: strategy.stateReason,
          originDebateKey: strategy.originDebateKey,
          originThesisRunKey: strategy.originThesisRunKey,
          dataOrigin: strategy.dataOrigin,
        },
        runs: runs.map((r) => ({
          validationKey: r.validationKey,
          runKey: r.runKey,
          verdict: r.verdict,
          verdictRule: r.verdictRule,
          verdictRationale: r.verdictRationale,
          decisiveTestType: r.decisiveTestType ?? null,
          testsRun: r.testsRun,
          passed: r.passed,
          failed: r.failed,
          inconclusive: r.inconclusive,
          evidenceWindowStart: r.evidenceWindowStart,
          evidenceWindowEnd: r.evidenceWindowEnd,
          citedObservationCount: r.citedObservationKeys.length,
          createdAt: r.createdAt,
        })),
        tests: tests.map((t) => ({
          testKey: t.testKey,
          validationKey: t.validationKey,
          type: t.type,
          result: t.result,
          rule: t.rule,
          finding: t.finding,
          metrics: t.metrics,
          limitations: t.limitations,
          citedObservationKeys: t.citedObservationKeys,
        })),
        transitions: transitions.map((t) => ({
          fromState: t.fromState ?? null,
          toState: t.toState,
          actor: t.actor,
          actorType: t.actorType,
          reason: t.reason,
          createdAt: t.createdAt,
        })),
      };
    },
  },

  mutations: {
    /** Validates the latest debate run. */
    async runCycle(_args: unknown, { user }: { user: UserInfo | null }) {
      const debateRunKey = await latestDebateRunKey();
      if (!debateRunKey) {
        return {
          status: 'skipped' as const,
          candidatesCreated: 0,
          validated: 0,
          passed: 0,
          failed: 0,
          held: 0,
          errors: [],
          jobRunId: '',
          note: 'No debate run exists yet. Validation has nothing to test until a debate produces a position.',
        };
      }

      const result = await runValidationCycle({
        debateRunKey,
        trigger: 'manual',
        triggeredBy: user?.id ?? 'anonymous',
      });

      return {
        ...result,
        debateRunKey,
        note:
          result.status === 'skipped'
            ? 'This debate run has already been validated — the existing record stands.'
            : `Validated debate run ${debateRunKey}.`,
      };
    },

    /**
     * Human promotion past PAPER. The engine cannot perform this transition;
     * that is the whole point of the stage. Attribution is permanent.
     */
    async promoteStrategy(args: unknown, { user }: { user: UserInfo | null }) {
      if (!user) throw new AuthError('Promotion past paper requires an authenticated human.');

      const { strategyKey, toState, reason } = z
        .object({
          strategyKey: z.string(),
          toState: z.enum(['SHADOW', 'PRODUCTION', 'RETIRED']),
          reason: z.string().min(10),
        })
        .parse(args);

      const strategy = await dbStrategies.requireOne({ strategyKey });

      const legal: Record<string, string[]> = {
        PAPER: ['SHADOW', 'RETIRED'],
        SHADOW: ['PRODUCTION', 'RETIRED'],
        PRODUCTION: ['RETIRED'],
      };
      const allowed = legal[strategy.state] ?? ['RETIRED'];
      if (!allowed.includes(toState)) {
        throw new Error(
          `${strategyKey} is ${strategy.state}; it may only move to ${allowed.join(' or ')}. Stages are not skippable.`
        );
      }

      const at = new Date();
      await dbStrategyTransitions.insertOne({
        strategyKey,
        fromState: strategy.state,
        toState,
        actor: user.id,
        actorType: 'human',
        reason,
        createdAt: at,
      });
      await dbStrategies.updateOne(
        { strategyKey },
        {
          $set: {
            state: toState,
            stateReason: reason,
            stateChangedAt: at,
            promotedBy: user.id,
            updatedAt: at,
          },
        }
      );

      return { strategyKey, fromState: strategy.state, toState, actor: user.id };
    },
  },

  cronJobs: {
    validationCycle: {
      description: 'Promote actionable debate outcomes into candidates and validate them',
      interval: time.minutes(30),
      handler: async () => {
        const debateRunKey = await latestDebateRunKey();
        if (!debateRunKey) return;
        await runValidationCycle({ debateRunKey, trigger: 'cron' });
      },
    },
  },
});
