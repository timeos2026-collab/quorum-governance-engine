import { Store, schema } from 'modelence/server';

/**
 * QUORUM CORE REGISTRY
 *
 * Shared reference data for every business-line module (Trading, Private Equity,
 * Private Credit, Investment Banking, AUM). No module may define its own copy of
 * these entities.
 *
 * PROVENANCE RULE (non-negotiable): every regulatory / jurisdictional fact is
 * stored as a *versioned assertion*, never as a permanent hard-coded truth.
 * Versioned facts live in `regulatoryFacts` with effectiveFrom / effectiveTo,
 * source and sourceTimestamp. Registry rows carry a `dataOrigin` tag so seeded
 * reference data can never be rendered as live data.
 */

/** Where a stored value came from. Seeded data must never be shown as live. */
export const dataOriginValues = ['seed', 'ingested', 'manual'] as const;
export type DataOrigin = (typeof dataOriginValues)[number];

/** Provenance strength of a claim. Used across the whole engine. */
export const verifiabilityValues = [
  'verified',
  'model_inference',
  'assumption',
  'unverified',
  'social_claim',
] as const;
export type Verifiability = (typeof verifiabilityValues)[number];

export const venueTypeValues = [
  'CEX',
  'DEX',
  'launchpad',
  'aggregator',
  'OTC-desk',
  'lending-protocol',
] as const;

export const tokenCategoryValues = [
  'major',
  'large-cap-meme',
  'micro-cap-meme',
  'fresh-launch',
  'pre-launch',
] as const;
export type TokenCategory = (typeof tokenCategoryValues)[number];

export const regulatoryStatusValues = [
  'digital_commodity',
  'unclassified',
  'under_review',
] as const;
export type RegulatoryStatus = (typeof regulatoryStatusValues)[number];

export const regimeTypeValues = [
  'MiCA',
  'FSCA-CASP',
  'SEC-Nigeria',
  'SEC-CFTC-US',
  'unclassified',
] as const;

/** Tier is derived from category — position/loan/allocation caps key off it. */
export function tierForCategory(category: TokenCategory): 1 | 2 | 3 {
  switch (category) {
    case 'major':
      return 1;
    case 'large-cap-meme':
      return 2;
    default:
      return 3;
  }
}

export const dbChains = new Store('registryChains', {
  schema: {
    chainId: schema.string(),
    name: schema.string(),
    consensus: schema.string(),
    /** Time to economic finality, in seconds. */
    finalityTimeSec: schema.number(),
    /** 1 (lowest risk) .. 5 (highest risk) for bridging value in/out. */
    bridgeRiskRating: schema.number(),
    dataOrigin: schema.enum(dataOriginValues),
    source: schema.string(),
    sourceTimestamp: schema.date(),
    createdAt: schema.date(),
    updatedAt: schema.date(),
  },
  indexes: [{ key: { chainId: 1 }, unique: true }],
});

export const dbVenues = new Store('registryVenues', {
  schema: {
    venueId: schema.string(),
    name: schema.string(),
    type: schema.enum(venueTypeValues),
    /** jurisdictionId of the venue's operating/licensing jurisdiction. */
    jurisdictionId: schema.string(),
    custodyModel: schema.string(),
    kycRequired: schema.boolean(),
    /** Which data feeds this venue exposes to the evidence layer. */
    apiCoverage: schema.array(schema.string()),
    dataOrigin: schema.enum(dataOriginValues),
    source: schema.string(),
    sourceTimestamp: schema.date(),
    createdAt: schema.date(),
    updatedAt: schema.date(),
  },
  indexes: [
    { key: { venueId: 1 }, unique: true },
    { key: { jurisdictionId: 1 } },
  ],
});

export const dbJurisdictions = new Store('registryJurisdictions', {
  schema: {
    jurisdictionId: schema.string(),
    name: schema.string(),
    regimeType: schema.enum(regimeTypeValues),
    /** e.g. Nigeria: every token, meme coins included, needs SEC sign-off first. */
    requiresPreApproval: schema.boolean(),
    /** e.g. South Africa: crypto treated as both money and capital. */
    exchangeControlFlag: schema.boolean(),
    notes: schema.string().optional(),
    source: schema.string(),
    sourceTimestamp: schema.date(),
    effectiveFrom: schema.date(),
    effectiveTo: schema.date().optional(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
    updatedAt: schema.date(),
  },
  indexes: [
    { key: { jurisdictionId: 1, effectiveFrom: -1 } },
    { key: { effectiveTo: 1 } },
  ],
});

export const dbTokens = new Store('registryTokens', {
  schema: {
    tokenId: schema.string(),
    symbol: schema.string(),
    name: schema.string(),
    chainId: schema.string(),
    contractAddress: schema.string().optional(),
    launchDate: schema.date().optional(),
    launchVenueId: schema.string().optional(),
    category: schema.enum(tokenCategoryValues),
    /** Derived from category; stored for query/gating convenience. */
    tier: schema.number(),

    supplyModel: schema.string(),
    liquidityLockStatus: schema.enum(['locked', 'unlocked', 'partial', 'unknown']),
    lpLockExpiry: schema.date().optional(),

    devWalletPct: schema.number().optional(),
    top10HolderPct: schema.number().optional(),

    contractAuditStatus: schema.enum(['audited', 'unaudited', 'in_progress', 'unknown']),
    honeypotCheckResult: schema.enum(['clean', 'suspicious', 'honeypot', 'not_run']),

    /**
     * Current *cached* regulatory status. The authoritative, replayable record
     * is the versioned assertion in `registryRegulatoryFacts`. Never treat this
     * field as a permanent fact — it is a denormalised read of the latest fact.
     */
    regulatoryStatus: schema.enum(regulatoryStatusValues),

    /**
     * Capital-origin jurisdiction is deliberately separate from the
     * liquidity-venue jurisdiction — SA exchange control makes these diverge.
     */
    capitalOriginJurisdictionId: schema.string().optional(),
    liquidityVenueJurisdictionId: schema.string().optional(),

    dataOrigin: schema.enum(dataOriginValues),
    source: schema.string(),
    sourceTimestamp: schema.date(),
    createdAt: schema.date(),
    updatedAt: schema.date(),
  },
  indexes: [
    { key: { tokenId: 1 }, unique: true },
    { key: { chainId: 1 } },
    { key: { category: 1 } },
    { key: { symbol: 1 } },
  ],
});

/**
 * Versioned regulatory / jurisdictional assertions.
 * One row = "as of <effectiveFrom>, <source> asserted <status> for <entity> in
 * <jurisdiction>". Superseded rows get effectiveTo set — they are never deleted,
 * so any past decision can be replayed against the facts known at the time.
 */
export const dbRegulatoryFacts = new Store('registryRegulatoryFacts', {
  schema: {
    entityType: schema.enum(['token', 'venue', 'jurisdiction']),
    /** tokenId / venueId / jurisdictionId */
    entityId: schema.string(),
    jurisdictionId: schema.string(),
    /** regulatoryStatus value, or a jurisdiction-level rule key. */
    claim: schema.string(),
    claimValue: schema.string(),
    verifiability: schema.enum(verifiabilityValues),
    source: schema.string(),
    sourceType: schema.string(),
    sourceUrl: schema.string().optional(),
    sourceTimestamp: schema.date(),
    retrievalTimestamp: schema.date(),
    effectiveFrom: schema.date(),
    effectiveTo: schema.date().optional(),
    supersededByFactId: schema.string().optional(),
    dataOrigin: schema.enum(dataOriginValues),
    createdAt: schema.date(),
  },
  indexes: [
    { key: { entityType: 1, entityId: 1, effectiveFrom: -1 } },
    { key: { jurisdictionId: 1, effectiveFrom: -1 } },
    { key: { effectiveTo: 1 } },
  ],
});
