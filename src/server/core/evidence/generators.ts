import { dbTokens, dbVenues, type TokenCategory } from '../registry/db';
import type { ObservationSourceType } from './db';

/**
 * SYNTHETIC EVIDENCE GENERATORS
 *
 * There is no live market/on-chain/regulatory feed attached to QUORUM yet.
 * These generators stand in for one. Everything they emit is written with
 * `dataOrigin: 'simulated'` and a `source` prefixed `synthetic:` so it can
 * never be mistaken for a real reading, in the UI or by a downstream agent.
 *
 * They are DETERMINISTIC: output is a pure function of (runKey, entity,
 * metric). Replaying a run key reproduces byte-identical observations, which is
 * what lets a past decision be re-derived from the evidence it actually saw.
 * Swapping in a real feed means replacing this file only — the observation
 * shape, the job ledger and every downstream consumer stay unchanged.
 */

export const GENERATOR_VERSION = 'synthetic-evidence@1.0.0';

/** FNV-1a — small, stable string hash. */
function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic float in [0, 1) derived from a seed string. */
function rand(seed: string): number {
  let t = hashString(seed) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function randBetween(seed: string, min: number, max: number, decimals = 2): number {
  const v = min + rand(seed) * (max - min);
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function pick<T>(seed: string, options: readonly T[]): T {
  return options[Math.floor(rand(seed) * options.length) % options.length];
}

export type DraftObservation = {
  sourceType: ObservationSourceType;
  source: string;
  observedAt: Date;
  verifiability: 'verified' | 'inferred' | 'social_claim';
  relevantEntityType: 'token' | 'venue' | 'chain' | 'jurisdiction';
  relevantEntityId: string;
  relevantJurisdictionId?: string;
  metric: string;
  value?: number;
  unit?: string;
  statement: string;
};

/**
 * Tier drives how noisy and how adverse the synthetic readings are. Tier 3
 * fresh-launch tokens must look genuinely dangerous — a synthetic feed that
 * flatters micro-caps would train the whole engine to under-gate them.
 */
function tierProfile(category: TokenCategory) {
  switch (category) {
    case 'major':
      return { volatility: 0.15, adversity: 0.05, depthUsd: [4_000_000, 40_000_000] as const };
    case 'large-cap-meme':
      return { volatility: 0.45, adversity: 0.25, depthUsd: [250_000, 3_000_000] as const };
    case 'micro-cap-meme':
      return { volatility: 1.1, adversity: 0.6, depthUsd: [8_000, 180_000] as const };
    case 'fresh-launch':
      return { volatility: 1.8, adversity: 0.8, depthUsd: [1_500, 60_000] as const };
    case 'pre-launch':
      return { volatility: 0.0, adversity: 0.5, depthUsd: [0, 0] as const };
  }
}

type TokenRow = {
  tokenId: string;
  symbol: string;
  category: TokenCategory;
  chainId: string;
  liquidityVenueJurisdictionId?: string;
  devWalletPct?: number;
  top10HolderPct?: number;
};

async function loadTokens(): Promise<TokenRow[]> {
  const rows = await dbTokens.fetch({}, { limit: 200 });
  return rows.map((t) => ({
    tokenId: t.tokenId,
    symbol: t.symbol,
    category: t.category as TokenCategory,
    chainId: t.chainId,
    liquidityVenueJurisdictionId: t.liquidityVenueJurisdictionId,
    devWalletPct: t.devWalletPct,
    top10HolderPct: t.top10HolderPct,
  }));
}

// ---------------------------------------------------------------- on-chain

async function onChain(runKey: string, observedAt: Date): Promise<DraftObservation[]> {
  const tokens = await loadTokens();
  const out: DraftObservation[] = [];

  for (const t of tokens) {
    if (t.category === 'pre-launch') continue;
    const p = tierProfile(t.category);
    const s = (m: string) => `${runKey}|onchain|${t.tokenId}|${m}`;

    const netFlow = randBetween(s('net_flow'), -1, 1, 4) * p.depthUsd[1] * 0.08;
    out.push({
      sourceType: 'on_chain',
      source: 'synthetic:wallet_flows',
      observedAt,
      verifiability: 'verified',
      relevantEntityType: 'token',
      relevantEntityId: t.tokenId,
      relevantJurisdictionId: t.liquidityVenueJurisdictionId,
      metric: 'net_wallet_flow_24h_usd',
      value: Math.round(netFlow),
      unit: 'USD',
      statement: `Net 24h wallet flow for ${t.symbol} is ${netFlow >= 0 ? '+' : ''}${Math.round(netFlow).toLocaleString()} USD across tracked addresses.`,
    });

    const devMoved = randBetween(s('dev_move'), 0, p.adversity * 12, 2);
    out.push({
      sourceType: 'on_chain',
      source: 'synthetic:dev_wallet_activity',
      observedAt,
      verifiability: 'verified',
      relevantEntityType: 'token',
      relevantEntityId: t.tokenId,
      relevantJurisdictionId: t.liquidityVenueJurisdictionId,
      metric: 'dev_wallet_outflow_pct_24h',
      value: devMoved,
      unit: '%',
      statement:
        devMoved > 2
          ? `Dev-controlled wallets moved ${devMoved}% of supply in the last 24h — material distribution event.`
          : `Dev-controlled wallets moved ${devMoved}% of supply in the last 24h.`,
    });

    const lpDelta = randBetween(s('lp_delta'), -p.adversity * 40, 25, 2);
    out.push({
      sourceType: 'on_chain',
      source: 'synthetic:lp_movements',
      observedAt,
      verifiability: 'verified',
      relevantEntityType: 'token',
      relevantEntityId: t.tokenId,
      relevantJurisdictionId: t.liquidityVenueJurisdictionId,
      metric: 'lp_balance_change_pct_24h',
      value: lpDelta,
      unit: '%',
      statement: `Pooled liquidity for ${t.symbol} changed ${lpDelta >= 0 ? '+' : ''}${lpDelta}% over 24h.`,
    });
  }

  return out;
}

// ------------------------------------------------- market microstructure

async function microstructure(runKey: string, observedAt: Date): Promise<DraftObservation[]> {
  const tokens = await loadTokens();
  const out: DraftObservation[] = [];

  for (const t of tokens) {
    if (t.category === 'pre-launch') continue;
    const p = tierProfile(t.category);
    const s = (m: string) => `${runKey}|micro|${t.tokenId}|${m}`;

    const depth = Math.round(randBetween(s('depth'), p.depthUsd[0], p.depthUsd[1], 0));
    out.push({
      sourceType: 'market_microstructure',
      source: 'synthetic:dex_pool_depth',
      observedAt,
      verifiability: 'verified',
      relevantEntityType: 'token',
      relevantEntityId: t.tokenId,
      relevantJurisdictionId: t.liquidityVenueJurisdictionId,
      metric: 'pool_depth_2pct_usd',
      value: depth,
      unit: 'USD',
      statement: `Executable depth within 2% of mid for ${t.symbol} is ${depth.toLocaleString()} USD. Use this, not headline liquidity, for slippage modelling.`,
    });

    // Wash-trading score gates every volume-derived signal downstream.
    const wash = randBetween(s('wash'), p.adversity * 15, 12 + p.adversity * 80, 1);
    out.push({
      sourceType: 'market_microstructure',
      source: 'synthetic:wash_trade_scoring',
      observedAt,
      verifiability: 'inferred',
      relevantEntityType: 'token',
      relevantEntityId: t.tokenId,
      relevantJurisdictionId: t.liquidityVenueJurisdictionId,
      metric: 'wash_trading_score_pct',
      value: wash,
      unit: '%',
      statement: `Estimated ${wash}% of reported volume for ${t.symbol} is non-economic (self-matched or circular). Volume must be discounted by this before any momentum signal.`,
    });

    const funding = randBetween(s('funding'), -0.06 * (1 + p.volatility), 0.06 * (1 + p.volatility), 4);
    out.push({
      sourceType: 'market_microstructure',
      source: 'synthetic:perp_funding',
      observedAt,
      verifiability: 'verified',
      relevantEntityType: 'token',
      relevantEntityId: t.tokenId,
      relevantJurisdictionId: t.liquidityVenueJurisdictionId,
      metric: 'funding_rate_8h_pct',
      value: funding,
      unit: '%',
      statement: `8h perpetual funding for ${t.symbol} at ${funding}%.`,
    });
  }

  return out;
}

// ------------------------------------------------------- narrative/social

async function narrative(runKey: string, observedAt: Date): Promise<DraftObservation[]> {
  const tokens = await loadTokens();
  const out: DraftObservation[] = [];

  for (const t of tokens) {
    const p = tierProfile(t.category);
    const s = (m: string) => `${runKey}|social|${t.tokenId}|${m}`;

    const velocity = randBetween(s('velocity'), -40, 60 + p.volatility * 200, 1);
    out.push({
      sourceType: 'narrative_social',
      source: 'synthetic:mention_velocity',
      observedAt,
      verifiability: 'inferred',
      relevantEntityType: 'token',
      relevantEntityId: t.tokenId,
      metric: 'mention_velocity_change_pct_6h',
      value: velocity,
      unit: '%',
      statement: `Mention velocity for ${t.symbol} moved ${velocity >= 0 ? '+' : ''}${velocity}% over 6h versus its trailing baseline.`,
    });

    if (rand(s('kol_gate')) < 0.35 + p.adversity * 0.3) {
      const followers = Math.round(randBetween(s('kol_size'), 25_000, 2_400_000, 0));
      out.push({
        sourceType: 'narrative_social',
        source: 'synthetic:kol_post_detection',
        observedAt,
        // A KOL asserting something is a claim, not a verified fact. Tagging it
        // as such stops the narrative agent from treating hype as evidence.
        verifiability: 'social_claim',
        relevantEntityType: 'token',
        relevantEntityId: t.tokenId,
        metric: 'kol_post_reach',
        value: followers,
        unit: 'followers',
        statement: `A ${followers.toLocaleString()}-follower account posted a ${pick(s('kol_tone'), ['bullish', 'bearish', 'neutral'] as const)} claim about ${t.symbol}. Unverified assertion, not a fact.`,
      });
    }
  }

  return out;
}

// ------------------------------------------------------------ regulatory

async function regulatory(runKey: string, observedAt: Date): Promise<DraftObservation[]> {
  const tokens = await loadTokens();
  const out: DraftObservation[] = [];

  for (const t of tokens) {
    const s = (m: string) => `${runKey}|reg|${t.tokenId}|${m}`;
    const jurisdiction = t.liquidityVenueJurisdictionId ?? 'unclassified';

    const ofacHit = rand(s('ofac')) < 0.04;
    out.push({
      sourceType: 'regulatory',
      source: 'synthetic:ofac_screening',
      observedAt,
      verifiability: 'verified',
      relevantEntityType: 'token',
      relevantEntityId: t.tokenId,
      relevantJurisdictionId: jurisdiction,
      metric: 'ofac_screening_hit',
      value: ofacHit ? 1 : 0,
      statement: ofacHit
        ? `Sanctions screening flagged an address in the ${t.symbol} holder set. Requires manual clearance before any action.`
        : `Sanctions screening on ${t.symbol} holder set returned no matches.`,
    });

    // Classification review chatter — explicitly inferred, never auto-applied
    // to the registry. Changing a token's regulatory status is a human act.
    if (rand(s('class_gate')) < 0.18) {
      out.push({
        sourceType: 'regulatory',
        source: 'synthetic:classification_monitor',
        observedAt,
        verifiability: 'inferred',
        relevantEntityType: 'token',
        relevantEntityId: t.tokenId,
        relevantJurisdictionId: jurisdiction,
        metric: 'classification_review_signal',
        value: 1,
        statement: `Signal that ${t.symbol}'s classification in ${jurisdiction} may be under review. Inferred only — does not update the registry's versioned status without human confirmation.`,
      });
    }
  }

  const venues = await dbVenues.fetch({}, { limit: 50 });
  for (const v of venues) {
    const s = `${runKey}|reg|${v.venueId}|delist`;
    if (rand(s) < 0.1) {
      out.push({
        sourceType: 'regulatory',
        source: 'synthetic:delisting_monitor',
        observedAt,
        verifiability: 'inferred',
        relevantEntityType: 'venue',
        relevantEntityId: v.venueId,
        relevantJurisdictionId: v.jurisdictionId,
        metric: 'delisting_event_signal',
        value: 1,
        statement: `Possible delisting activity detected at ${v.name} (${v.jurisdictionId}).`,
      });
    }
  }

  return out;
}

// -------------------------------------------------------------- security

async function security(runKey: string, observedAt: Date): Promise<DraftObservation[]> {
  const tokens = await loadTokens();
  const out: DraftObservation[] = [];

  for (const t of tokens) {
    const p = tierProfile(t.category);
    const s = (m: string) => `${runKey}|sec|${t.tokenId}|${m}`;

    const honeypotRisk = randBetween(s('honeypot'), 0, p.adversity * 100, 1);
    out.push({
      sourceType: 'security',
      source: 'synthetic:honeypot_simulation',
      observedAt,
      verifiability: 'inferred',
      relevantEntityType: 'token',
      relevantEntityId: t.tokenId,
      metric: 'honeypot_risk_score',
      value: honeypotRisk,
      unit: 'score_0_100',
      statement: `Simulated sell-path analysis scores ${t.symbol} at ${honeypotRisk}/100 for honeypot / transfer-restriction risk.`,
    });

    if (rand(s('exploit_gate')) < 0.08 + p.adversity * 0.1) {
      out.push({
        sourceType: 'security',
        source: 'synthetic:exploit_database',
        observedAt,
        verifiability: 'inferred',
        relevantEntityType: 'chain',
        relevantEntityId: t.chainId,
        metric: 'related_exploit_disclosure',
        value: 1,
        statement: `An exploit disclosure touching contracts on ${t.chainId} may affect ${t.symbol}'s dependency set.`,
      });
    }
  }

  return out;
}

export const GENERATORS: Record<
  ObservationSourceType,
  (runKey: string, observedAt: Date) => Promise<DraftObservation[]>
> = {
  on_chain: onChain,
  market_microstructure: microstructure,
  narrative_social: narrative,
  regulatory: regulatory,
  security: security,
};
