import { z } from 'zod';
import { time, AuthError } from 'modelence';
import { Module, type UserInfo } from 'modelence/server';

import { dbExecutionFills, dbExecutionOrders, orderStatusValues } from './db';
import {
  EXECUTION_GENERATOR_VERSION,
  EMBARGO_HOURS,
  assertSubmittable,
  latestRiskRunKey,
  runPaperCycle,
} from './run';

/**
 * core.execution — paper and shadow execution.
 *
 * OBSERVATION → THESIS → DEBATE → VALIDATION → RISK GATE → **EXECUTION** → AUDIT
 *
 * There is no promotion mutation here. Moving a strategy up the lifecycle is
 * `validation.promoteStrategy` and nothing else, so a lifecycle change can
 * never be a side effect of an execution action.
 */
export default new Module('execution', {
  stores: [dbExecutionOrders, dbExecutionFills],

  queries: {
    async overview() {
      const [orders, fills] = await Promise.all([
        dbExecutionOrders.countDocuments({}),
        dbExecutionFills.countDocuments({}),
      ]);

      const byStatus = await Promise.all(
        orderStatusValues.map(async (status) => ({
          status,
          count: await dbExecutionOrders.countDocuments({ status }),
        }))
      );

      const byMode = await Promise.all(
        (['PAPER', 'SHADOW', 'PRODUCTION'] as const).map(async (mode) => ({
          mode,
          count: await dbExecutionOrders.countDocuments({ permittedMode: mode }),
        }))
      );

      const [ingestedFills, embargoed, heldForDepth] = await Promise.all([
        dbExecutionFills.countDocuments({ dataOrigin: 'ingested' }),
        dbExecutionOrders.countDocuments({ earliestLiveAt: { $gt: new Date() } }),
        dbExecutionOrders.countDocuments({ requiresHumanForDepth: true }),
      ]);

      return {
        counts: { orders, fills },
        byStatus,
        byMode,
        provenance: {
          /** While zero, nothing on this page has ever touched a real venue. */
          ingestedFills,
          generatorVersion: EXECUTION_GENERATOR_VERSION,
        },
        paperWindow: {
          embargoHours: EMBARGO_HOURS,
          underEmbargo: embargoed,
          heldForDepth,
        },
        latestRiskRun: await latestRiskRunKey(),
      };
    },

    async orders(args: unknown) {
      const { status, limit } = z
        .object({
          status: z.enum(orderStatusValues).optional(),
          limit: z.number().int().min(1).max(100).optional(),
        })
        .parse(args ?? {});

      const filter: Record<string, unknown> = {};
      if (status) filter.status = status;

      const rows = await dbExecutionOrders.fetch(filter, {
        sort: { createdAt: -1, orderKey: 1 },
        limit: limit ?? 50,
      });

      const fills = await dbExecutionFills.fetch(
        { orderKey: { $in: rows.map((r) => r.orderKey) } },
        { limit: 100 }
      );
      const fillByOrder = new Map(fills.map((f) => [f.orderKey, f]));

      return rows.map((o) => {
        const fill = fillByOrder.get(o.orderKey);
        return {
          orderKey: o.orderKey,
          strategyKey: o.strategyKey,
          assessmentKey: o.assessmentKey,
          symbol: o.symbol,
          side: o.side,
          moduleScope: o.moduleScope,
          requestedSizeUsd: o.requestedSizeUsd,
          permittedSizeUsd: o.permittedSizeUsd,
          sizeCapReason: o.sizeCapReason,
          sizeCaps: o.sizeCaps,
          permittedMode: o.permittedMode,
          modeReason: o.modeReason,
          restrictions: o.restrictions,
          sourceVerdict: o.sourceVerdict,
          decisiveRuleId: o.decisiveRuleId ?? null,
          status: o.status,
          statusReason: o.statusReason,
          earliestLiveAt: o.earliestLiveAt,
          embargoHours: o.embargoHours,
          embargoReason: o.embargoReason,
          requiresHumanForDepth: o.requiresHumanForDepth,
          dataOrigin: o.dataOrigin,
          generatorVersion: o.generatorVersion,
          jobRunId: o.jobRunId,
          createdAt: o.createdAt,
          fill: fill
            ? {
                filledSizeUsd: fill.filledSizeUsd,
                fillPrice: fill.fillPrice,
                slippageBps: fill.slippageBps,
                partial: fill.partial,
                dataOrigin: fill.dataOrigin,
                filledAt: fill.filledAt,
              }
            : null,
        };
      });
    },

    async fills(args: unknown) {
      const { limit } = z
        .object({ limit: z.number().int().min(1).max(100).optional() })
        .parse(args ?? {});

      const rows = await dbExecutionFills.fetch({}, { sort: { filledAt: -1 }, limit: limit ?? 50 });
      return rows.map((f) => ({
        fillKey: f.fillKey,
        orderKey: f.orderKey,
        symbol: f.symbol,
        filledSizeUsd: f.filledSizeUsd,
        fillPrice: f.fillPrice,
        slippageBps: f.slippageBps,
        mode: f.mode,
        partial: f.partial,
        dataOrigin: f.dataOrigin,
        generatorVersion: f.generatorVersion,
        jobRunId: f.jobRunId,
        filledAt: f.filledAt,
      }));
    },
  },

  mutations: {
    async runCycle(_args: unknown, { user }: { user: UserInfo | null }) {
      const riskRunKey = await latestRiskRunKey();
      if (!riskRunKey) {
        return {
          status: 'skipped' as const,
          ordersCreated: 0,
          fillsCreated: 0,
          note: 'No risk assessment exists yet. Execution has nothing to act on — and it will not act on anything the gate has not assessed.',
        };
      }

      const result = await runPaperCycle({
        riskRunKey,
        trigger: 'manual',
        triggeredBy: user?.id ?? 'anonymous',
      });

      return {
        ...result,
        riskRunKey,
        note:
          result.status === 'skipped'
            ? 'This gate run has already been executed — replay produced zero new rows, which is the intended behaviour.'
            : `Executed gate run ${riskRunKey}.`,
      };
    },

    /**
     * Submit an approved order. Exists chiefly so the 48h embargo is enforced
     * at a real boundary rather than merely rendered as a date.
     */
    async submitOrder(args: unknown, { user }: { user: UserInfo | null }) {
      if (!user) throw new AuthError('Submitting an order requires an authenticated human.');

      const { orderKey } = z.object({ orderKey: z.string() }).parse(args);
      const order = await dbExecutionOrders.requireOne({ orderKey });

      assertSubmittable(order);

      const now = new Date();
      await dbExecutionOrders.updateOne(
        { orderKey },
        {
          $set: {
            status: 'SUBMITTED',
            statusReason: `Submitted by ${user.id} after the ${order.embargoHours}h embargo elapsed.`,
            submittedAt: now,
            submittedBy: user.id,
            updatedAt: now,
          },
        }
      );

      return { orderKey, status: 'SUBMITTED', submittedBy: user.id };
    },
  },

  cronJobs: {
    // Faster than the 30m risk and validation cycles: Tier 3 conditions have a
    // short half-life, and an order sized on a stale depth reading is worse
    // than no order.
    paperCycle: {
      description: 'Turn approved gate assessments into paper orders and synthetic fills',
      interval: time.minutes(15),
      handler: async () => {
        const riskRunKey = await latestRiskRunKey();
        if (!riskRunKey) return;
        await runPaperCycle({ riskRunKey, trigger: 'cron' });
      },
    },
  },
});
