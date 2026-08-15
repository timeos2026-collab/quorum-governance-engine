import { z } from 'zod';
import { Module } from 'modelence/server';

import {
  dbChains,
  dbVenues,
  dbJurisdictions,
  dbTokens,
  dbRegulatoryFacts,
  tokenCategoryValues,
} from './db';

/**
 * core.registry — shared reference data for all QUORUM business lines.
 * Read-only from the client for now; writes happen through ingestion jobs and
 * the seed migration, so that every row keeps an explicit provenance tag.
 */
export default new Module('registry', {
  stores: [dbChains, dbVenues, dbJurisdictions, dbTokens, dbRegulatoryFacts],

  queries: {
    async overview() {
      const [chains, venues, jurisdictions, tokens, facts] = await Promise.all([
        dbChains.countDocuments({}),
        dbVenues.countDocuments({}),
        dbJurisdictions.countDocuments({}),
        dbTokens.countDocuments({}),
        dbRegulatoryFacts.countDocuments({}),
      ]);

      const [seededTokens, ingestedTokens, preApprovalJurisdictions, exchangeControlJurisdictions] =
        await Promise.all([
          dbTokens.countDocuments({ dataOrigin: 'seed' }),
          dbTokens.countDocuments({ dataOrigin: 'ingested' }),
          dbJurisdictions.countDocuments({ requiresPreApproval: true }),
          dbJurisdictions.countDocuments({ exchangeControlFlag: true }),
        ]);

      const tierCounts = await Promise.all(
        [1, 2, 3].map((tier) => dbTokens.countDocuments({ tier }))
      );

      return {
        counts: { chains, venues, jurisdictions, tokens, facts },
        tokensByTier: { tier1: tierCounts[0], tier2: tierCounts[1], tier3: tierCounts[2] },
        provenance: { seededTokens, ingestedTokens },
        jurisdictionFlags: {
          requiresPreApproval: preApprovalJurisdictions,
          exchangeControl: exchangeControlJurisdictions,
        },
      };
    },

    async listChains() {
      const chains = await dbChains.fetch({}, { sort: { name: 1 } });
      return chains.map((c) => ({
        chainId: c.chainId,
        name: c.name,
        consensus: c.consensus,
        finalityTimeSec: c.finalityTimeSec,
        bridgeRiskRating: c.bridgeRiskRating,
        dataOrigin: c.dataOrigin,
        source: c.source,
        sourceTimestamp: c.sourceTimestamp,
      }));
    },

    async listVenues() {
      const venues = await dbVenues.fetch({}, { sort: { name: 1 } });
      return venues.map((v) => ({
        venueId: v.venueId,
        name: v.name,
        type: v.type,
        jurisdictionId: v.jurisdictionId,
        custodyModel: v.custodyModel,
        kycRequired: v.kycRequired,
        apiCoverage: v.apiCoverage,
        dataOrigin: v.dataOrigin,
        source: v.source,
        sourceTimestamp: v.sourceTimestamp,
      }));
    },

    async listJurisdictions() {
      const rows = await dbJurisdictions.fetch({}, { sort: { name: 1 } });
      return rows.map((j) => ({
        jurisdictionId: j.jurisdictionId,
        name: j.name,
        regimeType: j.regimeType,
        requiresPreApproval: j.requiresPreApproval,
        exchangeControlFlag: j.exchangeControlFlag,
        notes: j.notes ?? null,
        effectiveFrom: j.effectiveFrom,
        effectiveTo: j.effectiveTo ?? null,
        source: j.source,
        sourceTimestamp: j.sourceTimestamp,
        dataOrigin: j.dataOrigin,
      }));
    },

    async listTokens(args: unknown) {
      const { category, chainId } = z
        .object({
          category: z.enum(tokenCategoryValues).optional(),
          chainId: z.string().optional(),
        })
        .parse(args ?? {});

      const filter: Record<string, unknown> = {};
      if (category) filter.category = category;
      if (chainId) filter.chainId = chainId;

      const rows = await dbTokens.fetch(filter, { sort: { tier: 1, symbol: 1 }, limit: 200 });
      return rows.map((t) => ({
        tokenId: t.tokenId,
        symbol: t.symbol,
        name: t.name,
        chainId: t.chainId,
        contractAddress: t.contractAddress ?? null,
        category: t.category,
        tier: t.tier,
        supplyModel: t.supplyModel,
        liquidityLockStatus: t.liquidityLockStatus,
        lpLockExpiry: t.lpLockExpiry ?? null,
        devWalletPct: t.devWalletPct ?? null,
        top10HolderPct: t.top10HolderPct ?? null,
        contractAuditStatus: t.contractAuditStatus,
        honeypotCheckResult: t.honeypotCheckResult,
        regulatoryStatus: t.regulatoryStatus,
        capitalOriginJurisdictionId: t.capitalOriginJurisdictionId ?? null,
        liquidityVenueJurisdictionId: t.liquidityVenueJurisdictionId ?? null,
        launchVenueId: t.launchVenueId ?? null,
        dataOrigin: t.dataOrigin,
        source: t.source,
        sourceTimestamp: t.sourceTimestamp,
      }));
    },

    /** Full versioned assertion history for one registry entity. */
    async regulatoryFacts(args: unknown) {
      const { entityType, entityId } = z
        .object({
          entityType: z.enum(['token', 'venue', 'jurisdiction']),
          entityId: z.string(),
        })
        .parse(args);

      const rows = await dbRegulatoryFacts.fetch(
        { entityType, entityId },
        { sort: { effectiveFrom: -1 }, limit: 100 }
      );

      return rows.map((f) => ({
        id: f._id.toString(),
        entityType: f.entityType,
        entityId: f.entityId,
        jurisdictionId: f.jurisdictionId,
        claim: f.claim,
        claimValue: f.claimValue,
        verifiability: f.verifiability,
        source: f.source,
        sourceType: f.sourceType,
        sourceUrl: f.sourceUrl ?? null,
        sourceTimestamp: f.sourceTimestamp,
        retrievalTimestamp: f.retrievalTimestamp,
        effectiveFrom: f.effectiveFrom,
        effectiveTo: f.effectiveTo ?? null,
        isCurrent: !f.effectiveTo,
        dataOrigin: f.dataOrigin,
      }));
    },
  },
});
