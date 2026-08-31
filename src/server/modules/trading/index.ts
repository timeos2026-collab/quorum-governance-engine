import { z } from 'zod';
import { AuthError } from 'modelence';
import { Module, type UserInfo } from 'modelence/server';

import { dbTokens, tierForCategory, tokenCategoryValues } from '../../core/registry/db';
import { dbStrategies } from '../../core/validation/db';
import { dbRiskAssessments } from '../../core/risk/db';
import { dbExecutionFills, dbExecutionOrders } from '../../core/execution/db';
import { DEFAULT_DESK_ID, SEED_MANDATE, dbTradingMandates } from './db';

/**
 * module.trading — the first business line on the shared engine.
 *
 * Every query below is a READ of a core stage. There is no risk evaluation, no
 * lifecycle promotion, no order creation and no audit store in this file, and
 * there should never be one. If the desk needs a new rule, the rule belongs in
 * `core/risk/rules.ts` where every other business line inherits it too.
 */

type MandateView = {
  mandateKey: string;
  version: number;
  allowedCategories: string[];
  maxTier: number;
  maxGrossExposureUsd: number;
  excludedCapitalOrigins: string[];
  rationale: string;
  effectiveFrom: Date;
  setBy: string;
};

/** Current mandate, seeding the opening one on first read. */
async function currentMandate(): Promise<MandateView> {
  const existing = await dbTradingMandates.findOne({
    deskId: DEFAULT_DESK_ID,
    effectiveTo: { $exists: false },
  });
  if (existing) return existing as unknown as MandateView;

  const now = new Date();
  await dbTradingMandates.insertOne({
    mandateKey: `${DEFAULT_DESK_ID}@v1`,
    deskId: DEFAULT_DESK_ID,
    version: 1,
    allowedCategories: [...SEED_MANDATE.allowedCategories],
    maxTier: SEED_MANDATE.maxTier,
    maxGrossExposureUsd: SEED_MANDATE.maxGrossExposureUsd,
    excludedCapitalOrigins: [...SEED_MANDATE.excludedCapitalOrigins],
    rationale: SEED_MANDATE.rationale,
    effectiveFrom: now,
    setBy: 'seed',
    dataOrigin: 'seed',
    createdAt: now,
  });

  return (await dbTradingMandates.requireOne({
    mandateKey: `${DEFAULT_DESK_ID}@v1`,
  })) as unknown as MandateView;
}

type MandateCheck = { inMandate: boolean; reason: string };

/** Pure narrowing test. Can only ever remove things from the desk's view. */
function checkMandate(
  m: MandateView,
  token: { category: string; tier?: number; capitalOriginJurisdictionId?: string; symbol: string }
): MandateCheck {
  const tier = token.tier ?? tierForCategory(token.category as never);

  if (!m.allowedCategories.includes(token.category)) {
    return {
      inMandate: false,
      reason: `${token.symbol} is category ${token.category}; this desk's mandate covers ${m.allowedCategories.join(', ')}.`,
    };
  }
  if (tier > m.maxTier) {
    return {
      inMandate: false,
      reason: `${token.symbol} is Tier ${tier}; this desk's mandate stops at Tier ${m.maxTier}.`,
    };
  }
  if (
    token.capitalOriginJurisdictionId &&
    m.excludedCapitalOrigins.includes(token.capitalOriginJurisdictionId)
  ) {
    return {
      inMandate: false,
      reason: `Capital origin ${token.capitalOriginJurisdictionId} is excluded by this desk's mandate.`,
    };
  }
  return { inMandate: true, reason: `Within mandate v${m.version}.` };
}

export default new Module('trading', {
  stores: [dbTradingMandates],

  queries: {
    async mandate() {
      const m = await currentMandate();
      const history = await dbTradingMandates.fetch(
        { deskId: DEFAULT_DESK_ID },
        { sort: { version: -1 }, limit: 20 }
      );
      return {
        current: {
          mandateKey: m.mandateKey,
          version: m.version,
          allowedCategories: m.allowedCategories,
          maxTier: m.maxTier,
          maxGrossExposureUsd: m.maxGrossExposureUsd,
          excludedCapitalOrigins: m.excludedCapitalOrigins,
          rationale: m.rationale,
          effectiveFrom: m.effectiveFrom,
          setBy: m.setBy,
        },
        history: history.map((h) => ({
          mandateKey: h.mandateKey,
          version: h.version,
          setBy: h.setBy,
          rationale: h.rationale,
          effectiveFrom: h.effectiveFrom,
          effectiveTo: h.effectiveTo ?? null,
        })),
      };
    },

    /**
     * The desk's book: execution orders that fall inside the mandate, with the
     * provenance chain back through the gate. Assembled by reading core stores —
     * the desk holds no position table of its own, so its book cannot drift out
     * of agreement with what execution actually did.
     */
    async book() {
      const m = await currentMandate();

      const orders = await dbExecutionOrders.fetch({}, { sort: { createdAt: -1 }, limit: 100 });
      if (orders.length === 0) {
        return { positions: [], excluded: [], exposure: { grossUsd: 0, ceilingUsd: m.maxGrossExposureUsd, headroomUsd: m.maxGrossExposureUsd }, mandateVersion: m.version };
      }

      const [tokens, fills, assessments] = await Promise.all([
        dbTokens.fetch({ tokenId: { $in: [...new Set(orders.map((o) => o.subjectId))] } }, { limit: 100 }),
        dbExecutionFills.fetch({ orderKey: { $in: orders.map((o) => o.orderKey) } }, { limit: 100 }),
        dbRiskAssessments.fetch(
          { assessmentKey: { $in: orders.map((o) => o.assessmentKey) } },
          { limit: 100 }
        ),
      ]);

      const tokenById = new Map(tokens.map((t) => [t.tokenId, t]));
      const fillByOrder = new Map(fills.map((f) => [f.orderKey, f]));
      const assessmentByKey = new Map(assessments.map((a) => [a.assessmentKey, a]));

      const positions: unknown[] = [];
      const excluded: unknown[] = [];
      let grossUsd = 0;
      let outOfMandateGrossUsd = 0;

      for (const o of orders) {
        const token = tokenById.get(o.subjectId);
        if (!token) continue;

        const check = checkMandate(m, token);
        if (!check.inMandate) {
          /**
           * An out-of-mandate order is one taken under an earlier mandate that
           * a later version no longer covers. Its money is still at risk, so it
           * still counts against gross exposure — narrowing a mandate must not
           * make existing exposure disappear from the number.
           */
          const legacyFill = fillByOrder.get(o.orderKey);
          const legacy = legacyFill ? legacyFill.filledSizeUsd : 0;
          grossUsd += legacy;
          outOfMandateGrossUsd += legacy;
          excluded.push({
            orderKey: o.orderKey,
            symbol: o.symbol,
            category: token.category,
            tier: token.tier,
            filledSizeUsd: legacy,
            reason: check.reason,
          });
          continue;
        }

        const fill = fillByOrder.get(o.orderKey);
        const assessment = assessmentByKey.get(o.assessmentKey);
        const live = fill ? fill.filledSizeUsd : 0;
        grossUsd += live;

        positions.push({
          orderKey: o.orderKey,
          symbol: o.symbol,
          side: o.side,
          category: token.category,
          tier: token.tier,
          status: o.status,
          permittedMode: o.permittedMode,
          requestedSizeUsd: o.requestedSizeUsd,
          permittedSizeUsd: o.permittedSizeUsd,
          filledSizeUsd: live,
          fillPrice: fill?.fillPrice ?? null,
          fillDataOrigin: fill?.dataOrigin ?? null,
          earliestLiveAt: o.earliestLiveAt,
          // Provenance chain, read from the stages that produced it.
          provenance: {
            strategyKey: o.strategyKey,
            assessmentKey: o.assessmentKey,
            gateVerdict: assessment?.verdict ?? null,
            decisiveRuleId: o.decisiveRuleId ?? null,
            sizeCapReason: o.sizeCapReason,
            jobRunId: o.jobRunId,
            generatorVersion: o.generatorVersion,
          },
          dataOrigin: o.dataOrigin,
        });
      }

      return {
        positions,
        excluded,
        exposure: {
          grossUsd,
          outOfMandateGrossUsd,
          ceilingUsd: m.maxGrossExposureUsd,
          headroomUsd: Math.max(0, m.maxGrossExposureUsd - grossUsd),
          /** Over the desk ceiling. Reported, never auto-corrected here. */
          breached: grossUsd > m.maxGrossExposureUsd,
        },
        mandateVersion: m.version,
      };
    },

    /**
     * What the engine is currently working on that falls inside this mandate,
     * and at which stage it is stuck. This is a *view*, not a queue the desk
     * controls — the desk cannot advance anything from here.
     */
    async pipeline() {
      const m = await currentMandate();
      const strategies = await dbStrategies.fetch(
        { state: { $in: ['UNDER_TEST', 'PAPER', 'SHADOW', 'PRODUCTION'] } },
        { sort: { updatedAt: -1 }, limit: 60 }
      );
      if (strategies.length === 0) return { rows: [], mandateVersion: m.version };

      const tokens = await dbTokens.fetch(
        { tokenId: { $in: [...new Set(strategies.map((s) => s.subjectId))] } },
        { limit: 60 }
      );
      const tokenById = new Map(tokens.map((t) => [t.tokenId, t]));

      const rows = [];
      for (const s of strategies) {
        const token = tokenById.get(s.subjectId);
        if (!token) continue;
        if (!checkMandate(m, token).inMandate) continue;

        const [assessment] = await dbRiskAssessments.fetch(
          { strategyKey: s.strategyKey },
          { sort: { createdAt: -1 }, limit: 1 }
        );
        const order = assessment
          ? await dbExecutionOrders.findOne({ assessmentKey: assessment.assessmentKey })
          : null;

        rows.push({
          strategyKey: s.strategyKey,
          symbol: token.symbol,
          tier: token.tier,
          stance: s.stance,
          conviction: s.conviction,
          /** Conviction is one named thesis's number. Never a blend. */
          convictionSource: s.originConvictionSource,
          validationState: s.state,
          gateVerdict: assessment?.verdict ?? null,
          executionStatus: order?.status ?? null,
          stage: order
            ? `EXECUTION · ${order.status}`
            : assessment
              ? `RISK GATE · ${assessment.verdict}`
              : `VALIDATION · ${s.state}`,
          blockedBy: assessment?.decisiveRuleId ?? null,
        });
      }

      return { rows, mandateVersion: m.version };
    },
  },

  mutations: {
    /**
     * Narrow or re-scope the mandate. Writes a NEW version and closes the
     * previous one — a mandate is never edited, because a position taken last
     * month must remain judgeable against the mandate in force last month.
     */
    async setMandate(args: unknown, { user }: { user: UserInfo | null }) {
      if (!user) throw new AuthError('Changing a desk mandate requires an authenticated human.');

      const input = z
        .object({
          allowedCategories: z.array(z.enum(tokenCategoryValues)).min(1),
          maxTier: z.number().int().min(1).max(3),
          maxGrossExposureUsd: z.number().min(0),
          excludedCapitalOrigins: z.array(z.string()).optional(),
          rationale: z.string().min(20),
        })
        .parse(args);

      const previous = await currentMandate();
      const now = new Date();
      const version = previous.version + 1;

      await dbTradingMandates.updateOne(
        { mandateKey: previous.mandateKey },
        { $set: { effectiveTo: now } }
      );

      const mandateKey = `${DEFAULT_DESK_ID}@v${version}`;
      await dbTradingMandates.insertOne({
        mandateKey,
        deskId: DEFAULT_DESK_ID,
        version,
        allowedCategories: input.allowedCategories,
        maxTier: input.maxTier,
        maxGrossExposureUsd: input.maxGrossExposureUsd,
        excludedCapitalOrigins: input.excludedCapitalOrigins ?? [],
        rationale: input.rationale,
        effectiveFrom: now,
        setBy: user.id,
        dataOrigin: 'manual',
        createdAt: now,
      });

      return {
        mandateKey,
        version,
        supersededVersion: previous.version,
        note: 'The previous mandate was closed, not deleted. Positions taken under it remain judgeable against it.',
      };
    },
  },
});
