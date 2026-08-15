import {
  dbChains,
  dbVenues,
  dbJurisdictions,
  dbTokens,
  dbRegulatoryFacts,
  tierForCategory,
  type TokenCategory,
} from './db';

/**
 * Reference-data seed for the shared registry.
 *
 * EVERY row written here is tagged `dataOrigin: 'seed'` and carries a source of
 * 'QUORUM seed'. The UI must render seeded rows with a SEED marker and must
 * never present them as live/ingested data. Replacing a seeded row with a real
 * ingested observation is an upsert that flips `dataOrigin` to 'ingested'.
 */

const SEED_SOURCE = 'QUORUM seed (reference data, not live)';

function now() {
  return new Date();
}

type ChainSeed = {
  chainId: string;
  name: string;
  consensus: string;
  finalityTimeSec: number;
  bridgeRiskRating: number;
};

const chains: ChainSeed[] = [
  { chainId: 'ethereum', name: 'Ethereum', consensus: 'PoS (Gasper)', finalityTimeSec: 780, bridgeRiskRating: 2 },
  { chainId: 'solana', name: 'Solana', consensus: 'PoH + PoS', finalityTimeSec: 13, bridgeRiskRating: 3 },
  { chainId: 'base', name: 'Base', consensus: 'OP Stack rollup', finalityTimeSec: 900, bridgeRiskRating: 3 },
  { chainId: 'bitcoin', name: 'Bitcoin', consensus: 'PoW (Nakamoto)', finalityTimeSec: 3600, bridgeRiskRating: 1 },
  { chainId: 'arbitrum', name: 'Arbitrum One', consensus: 'Nitro rollup', finalityTimeSec: 1020, bridgeRiskRating: 3 },
];

type JurisdictionSeed = {
  jurisdictionId: string;
  name: string;
  regimeType: 'MiCA' | 'FSCA-CASP' | 'SEC-Nigeria' | 'SEC-CFTC-US' | 'unclassified';
  requiresPreApproval: boolean;
  exchangeControlFlag: boolean;
  effectiveFrom: string;
  notes: string;
};

const jurisdictions: JurisdictionSeed[] = [
  {
    jurisdictionId: 'ZA',
    name: 'South Africa',
    regimeType: 'FSCA-CASP',
    requiresPreApproval: false,
    exchangeControlFlag: true,
    effectiveFrom: '2023-10-19',
    notes:
      'Crypto assets are FSCA-licensed financial products (CASP regime). Exchange-control treatment currently spans both money and capital pending finalisation — capital-origin jurisdiction must be recorded separately from liquidity-venue jurisdiction on every position.',
  },
  {
    jurisdictionId: 'NG',
    name: 'Nigeria',
    regimeType: 'SEC-Nigeria',
    requiresPreApproval: true,
    exchangeControlFlag: true,
    effectiveFrom: '2025-03-29',
    notes:
      'ISA 2025 brings digital assets under SEC Nigeria. Per-token pre-approval is required before any listing or offering — meme coins included. Encoded as a jurisdiction rule, not a token special case.',
  },
  {
    jurisdictionId: 'EU',
    name: 'European Union',
    regimeType: 'MiCA',
    requiresPreApproval: false,
    exchangeControlFlag: false,
    effectiveFrom: '2024-12-30',
    notes:
      'MiCA fully applicable. CASP authorisation plus white-paper notification required for offers to the public; asset-referenced and e-money tokens carry additional gates.',
  },
  {
    jurisdictionId: 'US',
    name: 'United States',
    regimeType: 'SEC-CFTC-US',
    requiresPreApproval: false,
    exchangeControlFlag: false,
    effectiveFrom: '2024-01-01',
    notes:
      'Split SEC/CFTC jurisdiction with unresolved classification boundaries. Treat classification as contested — status must stay versioned, never hard-coded.',
  },
  {
    jurisdictionId: 'AE',
    name: 'United Arab Emirates',
    regimeType: 'unclassified',
    requiresPreApproval: true,
    exchangeControlFlag: false,
    effectiveFrom: '2023-02-07',
    notes: 'VARA (Dubai) requires per-activity licensing; token listing approval is venue-level.',
  },
];

type VenueSeed = {
  venueId: string;
  name: string;
  type: 'CEX' | 'DEX' | 'launchpad' | 'aggregator' | 'OTC-desk' | 'lending-protocol';
  jurisdictionId: string;
  custodyModel: string;
  kycRequired: boolean;
  apiCoverage: string[];
};

const venues: VenueSeed[] = [
  { venueId: 'binance', name: 'Binance', type: 'CEX', jurisdictionId: 'AE', custodyModel: 'omnibus-custodial', kycRequired: true, apiCoverage: ['orderbook', 'trades', 'funding', 'open_interest'] },
  { venueId: 'valr', name: 'VALR', type: 'CEX', jurisdictionId: 'ZA', custodyModel: 'omnibus-custodial', kycRequired: true, apiCoverage: ['orderbook', 'trades'] },
  { venueId: 'uniswap-v3', name: 'Uniswap v3', type: 'DEX', jurisdictionId: 'US', custodyModel: 'self-custody', kycRequired: false, apiCoverage: ['pool_depth', 'swaps', 'lp_events'] },
  { venueId: 'raydium', name: 'Raydium', type: 'DEX', jurisdictionId: 'unclassified', custodyModel: 'self-custody', kycRequired: false, apiCoverage: ['pool_depth', 'swaps', 'lp_events'] },
  { venueId: 'pumpfun', name: 'Pump.fun', type: 'launchpad', jurisdictionId: 'unclassified', custodyModel: 'self-custody', kycRequired: false, apiCoverage: ['launch_events', 'bonding_curve', 'dev_wallet'] },
  { venueId: 'aave-v3', name: 'Aave v3', type: 'lending-protocol', jurisdictionId: 'unclassified', custodyModel: 'smart-contract', kycRequired: false, apiCoverage: ['collateral', 'utilisation', 'liquidations', 'oracle'] },
];

type TokenSeed = {
  tokenId: string;
  symbol: string;
  name: string;
  chainId: string;
  category: TokenCategory;
  supplyModel: string;
  liquidityLockStatus: 'locked' | 'unlocked' | 'partial' | 'unknown';
  contractAuditStatus: 'audited' | 'unaudited' | 'in_progress' | 'unknown';
  honeypotCheckResult: 'clean' | 'suspicious' | 'honeypot' | 'not_run';
  regulatoryStatus: 'digital_commodity' | 'unclassified' | 'under_review';
  devWalletPct?: number;
  top10HolderPct?: number;
  contractAddress?: string;
  launchVenueId?: string;
  capitalOriginJurisdictionId?: string;
  liquidityVenueJurisdictionId?: string;
};

const tokens: TokenSeed[] = [
  {
    tokenId: 'btc', symbol: 'BTC', name: 'Bitcoin', chainId: 'bitcoin', category: 'major',
    supplyModel: 'fixed-21m-halving', liquidityLockStatus: 'unknown', contractAuditStatus: 'unknown',
    honeypotCheckResult: 'not_run', regulatoryStatus: 'digital_commodity', top10HolderPct: 4.2,
    capitalOriginJurisdictionId: 'ZA', liquidityVenueJurisdictionId: 'AE',
  },
  {
    tokenId: 'eth', symbol: 'ETH', name: 'Ether', chainId: 'ethereum', category: 'major',
    supplyModel: 'issuance-burn (EIP-1559)', liquidityLockStatus: 'unknown', contractAuditStatus: 'unknown',
    honeypotCheckResult: 'not_run', regulatoryStatus: 'under_review', top10HolderPct: 6.8,
    capitalOriginJurisdictionId: 'ZA', liquidityVenueJurisdictionId: 'AE',
  },
  {
    tokenId: 'sol', symbol: 'SOL', name: 'Solana', chainId: 'solana', category: 'major',
    supplyModel: 'inflationary-decaying', liquidityLockStatus: 'unknown', contractAuditStatus: 'unknown',
    honeypotCheckResult: 'not_run', regulatoryStatus: 'under_review', top10HolderPct: 11.4,
    capitalOriginJurisdictionId: 'ZA', liquidityVenueJurisdictionId: 'AE',
  },
  {
    tokenId: 'doge', symbol: 'DOGE', name: 'Dogecoin', chainId: 'bitcoin', category: 'large-cap-meme',
    supplyModel: 'inflationary-fixed-block', liquidityLockStatus: 'unknown', contractAuditStatus: 'unknown',
    honeypotCheckResult: 'not_run', regulatoryStatus: 'unclassified', top10HolderPct: 42.6,
    capitalOriginJurisdictionId: 'ZA', liquidityVenueJurisdictionId: 'AE',
  },
  {
    tokenId: 'wif', symbol: 'WIF', name: 'dogwifhat', chainId: 'solana', category: 'large-cap-meme',
    contractAddress: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    supplyModel: 'fixed-no-mint', liquidityLockStatus: 'locked', contractAuditStatus: 'unaudited',
    honeypotCheckResult: 'clean', regulatoryStatus: 'unclassified', devWalletPct: 0, top10HolderPct: 29.1,
    launchVenueId: 'raydium', capitalOriginJurisdictionId: 'ZA', liquidityVenueJurisdictionId: 'unclassified',
  },
  {
    tokenId: 'seed-microcap-01', symbol: 'MCAP1', name: 'Seed Micro-cap Sample 1', chainId: 'solana',
    category: 'micro-cap-meme', contractAddress: '0xSEEDPLACEHOLDER000000000000000000000001',
    supplyModel: 'fixed-no-mint', liquidityLockStatus: 'partial', contractAuditStatus: 'unaudited',
    honeypotCheckResult: 'suspicious', regulatoryStatus: 'unclassified', devWalletPct: 8.4, top10HolderPct: 61.2,
    launchVenueId: 'pumpfun', capitalOriginJurisdictionId: 'ZA', liquidityVenueJurisdictionId: 'unclassified',
  },
  {
    tokenId: 'seed-fresh-01', symbol: 'FRSH1', name: 'Seed Fresh-launch Sample 1', chainId: 'base',
    category: 'fresh-launch', contractAddress: '0xSEEDPLACEHOLDER000000000000000000000002',
    supplyModel: 'bonding-curve', liquidityLockStatus: 'unlocked', contractAuditStatus: 'unaudited',
    honeypotCheckResult: 'not_run', regulatoryStatus: 'unclassified', devWalletPct: 14.9, top10HolderPct: 73.5,
    launchVenueId: 'pumpfun', capitalOriginJurisdictionId: 'ZA', liquidityVenueJurisdictionId: 'unclassified',
  },
  {
    tokenId: 'seed-prelaunch-01', symbol: 'PRE1', name: 'Seed Pre-launch Deal Sample 1', chainId: 'ethereum',
    category: 'pre-launch', supplyModel: 'vested-tge (cliff + linear)', liquidityLockStatus: 'unknown',
    contractAuditStatus: 'in_progress', honeypotCheckResult: 'not_run', regulatoryStatus: 'under_review',
    devWalletPct: 18, top10HolderPct: 68, capitalOriginJurisdictionId: 'ZA', liquidityVenueJurisdictionId: 'EU',
  },
];

export async function seedRegistry() {
  const ts = now();

  for (const c of chains) {
    await dbChains.upsertOne(
      { chainId: c.chainId },
      {
        $set: { ...c, dataOrigin: 'seed' as const, source: SEED_SOURCE, sourceTimestamp: ts, updatedAt: ts },
        $setOnInsert: { createdAt: ts },
      }
    );
  }

  for (const j of jurisdictions) {
    const effectiveFrom = new Date(j.effectiveFrom);
    await dbJurisdictions.upsertOne(
      { jurisdictionId: j.jurisdictionId },
      {
        $set: {
          jurisdictionId: j.jurisdictionId,
          name: j.name,
          regimeType: j.regimeType,
          requiresPreApproval: j.requiresPreApproval,
          exchangeControlFlag: j.exchangeControlFlag,
          notes: j.notes,
          effectiveFrom,
          source: SEED_SOURCE,
          sourceTimestamp: ts,
          dataOrigin: 'seed' as const,
          updatedAt: ts,
        },
        $setOnInsert: { createdAt: ts },
      }
    );

    // Jurisdiction-level rules are recorded as versioned assertions too.
    const existingRule = await dbRegulatoryFacts.findOne({
      entityType: 'jurisdiction',
      entityId: j.jurisdictionId,
      claim: 'requires_pre_approval',
      effectiveTo: { $exists: false },
    });
    if (!existingRule) {
      await dbRegulatoryFacts.insertOne({
        entityType: 'jurisdiction',
        entityId: j.jurisdictionId,
        jurisdictionId: j.jurisdictionId,
        claim: 'requires_pre_approval',
        claimValue: String(j.requiresPreApproval),
        verifiability: 'unverified',
        source: SEED_SOURCE,
        sourceType: 'seed_reference',
        sourceTimestamp: ts,
        retrievalTimestamp: ts,
        effectiveFrom,
        dataOrigin: 'seed',
        createdAt: ts,
      });
    }
  }

  for (const v of venues) {
    await dbVenues.upsertOne(
      { venueId: v.venueId },
      {
        $set: { ...v, dataOrigin: 'seed' as const, source: SEED_SOURCE, sourceTimestamp: ts, updatedAt: ts },
        $setOnInsert: { createdAt: ts },
      }
    );
  }

  for (const t of tokens) {
    await dbTokens.upsertOne(
      { tokenId: t.tokenId },
      {
        $set: {
          ...t,
          tier: tierForCategory(t.category),
          dataOrigin: 'seed' as const,
          source: SEED_SOURCE,
          sourceTimestamp: ts,
          updatedAt: ts,
        },
        $setOnInsert: { createdAt: ts },
      }
    );

    const existingFact = await dbRegulatoryFacts.findOne({
      entityType: 'token',
      entityId: t.tokenId,
      claim: 'regulatory_status',
      jurisdictionId: t.liquidityVenueJurisdictionId ?? 'unclassified',
      effectiveTo: { $exists: false },
    });
    if (!existingFact) {
      await dbRegulatoryFacts.insertOne({
        entityType: 'token',
        entityId: t.tokenId,
        jurisdictionId: t.liquidityVenueJurisdictionId ?? 'unclassified',
        claim: 'regulatory_status',
        claimValue: t.regulatoryStatus,
        verifiability: 'unverified',
        source: SEED_SOURCE,
        sourceType: 'seed_reference',
        sourceTimestamp: ts,
        retrievalTimestamp: ts,
        effectiveFrom: ts,
        dataOrigin: 'seed',
        createdAt: ts,
      });
    }
  }
}
