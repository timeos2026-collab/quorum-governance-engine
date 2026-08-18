import type { Stance, AgentDiscipline } from './db';
import type { TokenCategory, RegulatoryStatus, Verifiability } from '../registry/db';

/**
 * THE CORE AGENT SWARM
 *
 * Eight specialists, each with a narrow mandate and a declared evidence scope.
 * Reasoning here is RULE-BASED and deterministic — not an LLM call and not
 * random. Given the same observations, an agent produces the same thesis, which
 * is what makes a past decision re-derivable.
 *
 * Hard rules enforced for every agent by `deriveThesis`:
 *  - No cited evidence ⇒ the stance is forced to ABSTAIN with the gaps listed.
 *  - Confidence is clamped to the agent's ceiling AND to a cap implied by the
 *    weakest verifiability among its citations.
 *  - Every thesis carries a falsifiable condition and its weakest link.
 *
 * Module-specific agents (Private Equity / Private Credit / IB) are NOT defined
 * here yet — they arrive with their modules and will extend this roster rather
 * than fork it.
 */

/**
 * Bump this whenever reasoning or the cap rules change. Existing theses keep the
 * version they were formed under, so an audit can tell which ruleset produced a
 * given stance rather than silently assuming today's rules always applied.
 * 1.1.0 — blocks exempted from the thin-citation confidence penalty.
 */
export const AGENT_GENERATOR_VERSION = 'rule-agents@1.1.0';

export type ObservationRef = {
  observationKey: string;
  metric: string;
  value: number | null;
  unit: string | null;
  statement: string;
  verifiability: Verifiability;
  dataOrigin: string;
  observedAt: Date;
  sourceType: string;
};

export type SubjectContext = {
  tokenId: string;
  symbol: string;
  category: TokenCategory;
  tier: number;
  chainId: string;
  liquidityLockStatus: string;
  lpLockExpiry: Date | null;
  devWalletPct: number | null;
  top10HolderPct: number | null;
  contractAuditStatus: string;
  honeypotCheckResult: string;
  regulatoryStatus: RegulatoryStatus;
  capitalOriginJurisdictionId: string | null;
  liquidityVenueJurisdictionId: string | null;
  /** Latest observation per metric for this token. */
  byMetric: Record<string, ObservationRef>;
  /** Latest observation per metric for this token's chain. */
  chainByMetric: Record<string, ObservationRef>;
  /** Jurisdiction rules resolved from the registry. */
  jurisdiction: {
    jurisdictionId: string;
    requiresPreApproval: boolean;
    exchangeControlFlag: boolean;
  } | null;
};

/** What an agent returns. Confidence here is a *pre-cap* proposal. */
export type ReasonedThesis = {
  stance: Stance;
  confidence: number;
  rationale: string;
  falsifiableCondition: string;
  weakestLink: string;
  cited: ObservationRef[];
  evidenceGaps: string[];
};

export type AgentDefinition = {
  agentId: string;
  name: string;
  discipline: AgentDiscipline;
  mandate: string;
  sourceScope: string[];
  metricScope: string[];
  /** Ceiling on this agent's confidence no matter how strong the evidence. */
  maxConfidence: number;
  agentVersion: string;
  reason: (ctx: SubjectContext) => ReasonedThesis;
};

function pct(n: number) {
  return `${n}%`;
}

function usd(n: number) {
  return `$${Math.round(n).toLocaleString()}`;
}

/** Collects the declared metrics that are missing for this subject. */
function gaps(ctx: SubjectContext, metrics: string[], chainMetrics: string[] = []) {
  const out = metrics.filter((m) => !ctx.byMetric[m]);
  for (const m of chainMetrics) if (!ctx.chainByMetric[m]) out.push(`${m} (chain)`);
  return out;
}

// ─────────────────────────────────────────────────────── 1. on-chain flow

const flowAnalyst: AgentDefinition = {
  agentId: 'flow-analyst',
  name: 'Flow Analyst',
  discipline: 'on_chain_flow',
  mandate:
    'Reads settled on-chain movement only — wallet flows, dev-wallet distribution, pooled liquidity change. Has no opinion on price or narrative.',
  sourceScope: ['on_chain'],
  metricScope: ['net_wallet_flow_24h_usd', 'dev_wallet_outflow_pct_24h', 'lp_balance_change_pct_24h'],
  maxConfidence: 85,
  agentVersion: '1.0.0',
  reason: (ctx) => {
    const flow = ctx.byMetric['net_wallet_flow_24h_usd'];
    const dev = ctx.byMetric['dev_wallet_outflow_pct_24h'];
    const lp = ctx.byMetric['lp_balance_change_pct_24h'];
    const cited = [flow, dev, lp].filter(Boolean);

    const flowV = flow?.value ?? 0;
    const devV = dev?.value ?? 0;
    const lpV = lp?.value ?? 0;

    const notes: string[] = [];
    let score = 0;

    if (flow) {
      notes.push(`net 24h wallet flow ${flowV >= 0 ? '+' : ''}${usd(flowV)}`);
      score += flowV > 0 ? 1 : -1;
    }
    if (dev) {
      notes.push(`dev wallets moved ${pct(devV)} of supply`);
      if (devV > 3) score -= 2;
      else if (devV > 1) score -= 1;
    }
    if (lp) {
      notes.push(`pooled liquidity ${lpV >= 0 ? '+' : ''}${pct(lpV)}`);
      if (lpV < -15) score -= 2;
      else if (lpV > 5) score += 1;
    }

    // Liquidity leaving while dev wallets distribute is an exit signature, not a dip.
    const exitSignature = devV > 2 && lpV < -10;

    const stance: Stance = exitSignature
      ? 'BLOCK_RECOMMENDED'
      : score >= 2
        ? 'BULLISH'
        : score <= -2
          ? 'BEARISH'
          : 'NEUTRAL';

    return {
      stance,
      confidence: exitSignature ? 78 : 40 + Math.min(Math.abs(score), 3) * 12,
      rationale: exitSignature
        ? `Exit signature on ${ctx.symbol}: dev wallets distributed ${pct(devV)} of supply while pooled liquidity fell ${pct(lpV)}. Settled on-chain movement, not sentiment. Recommending block pending human review.`
        : `On-chain picture for ${ctx.symbol}: ${notes.join('; ')}.`,
      falsifiableCondition: exitSignature
        ? 'LP balance recovers above its prior level and dev-wallet outflow returns to under 1% over the next two observation cycles.'
        : `Direction reverses if net wallet flow flips sign or LP balance moves more than 15% against the current reading.`,
      weakestLink:
        'Wallet clustering is heuristic — flows attributed to "dev wallets" may belong to unrelated addresses.',
      cited,
      evidenceGaps: gaps(ctx, flowAnalyst.metricScope),
    };
  },
};

// ──────────────────────────────────────────── 2. liquidity / microstructure

const liquidityAnalyst: AgentDefinition = {
  agentId: 'liquidity-analyst',
  name: 'Liquidity Analyst',
  discipline: 'liquidity_microstructure',
  mandate:
    'Judges whether a position can actually be entered and exited at size. Reasons over executable depth within 2% of mid, never headline liquidity.',
  sourceScope: ['market_microstructure'],
  metricScope: ['pool_depth_2pct_usd', 'funding_rate_8h_pct'],
  maxConfidence: 90,
  agentVersion: '1.0.0',
  reason: (ctx) => {
    const depth = ctx.byMetric['pool_depth_2pct_usd'];
    const funding = ctx.byMetric['funding_rate_8h_pct'];
    const cited = [depth, funding].filter(Boolean);

    if (!depth) {
      return {
        stance: 'ABSTAIN',
        confidence: 0,
        rationale: `No executable depth reading for ${ctx.symbol}. Exit feasibility is unknown, so no position view can be formed.`,
        falsifiableCondition: 'A pool depth observation becomes available for this token.',
        weakestLink: 'Absence of evidence, not evidence of absence.',
        cited,
        evidenceGaps: gaps(ctx, liquidityAnalyst.metricScope),
      };
    }

    const d = depth.value ?? 0;
    const f = funding?.value ?? 0;

    // Depth thresholds scale with tier: a Tier 1 asset with $50k depth is broken,
    // a Tier 3 fresh launch with $50k depth is simply small.
    const minViable = ctx.tier === 1 ? 2_000_000 : ctx.tier === 2 ? 150_000 : 20_000;
    const thin = d < minViable;
    const veryThin = d < minViable * 0.3;

    const stance: Stance = veryThin ? 'BLOCK_RECOMMENDED' : thin ? 'BEARISH' : 'NEUTRAL';

    return {
      stance,
      confidence: veryThin ? 88 : thin ? 70 : 55,
      rationale: veryThin
        ? `Executable depth for ${ctx.symbol} is ${usd(d)} within 2% of mid — below 30% of the ${usd(minViable)} Tier ${ctx.tier} viability floor. Any meaningful size cannot exit without moving the market against itself.`
        : thin
          ? `Depth of ${usd(d)} is under the ${usd(minViable)} Tier ${ctx.tier} floor. Position size must be capped to a fraction of depth, not of AUM.${funding ? ` 8h funding at ${pct(f)}.` : ''}`
          : `Depth of ${usd(d)} clears the Tier ${ctx.tier} floor of ${usd(minViable)}.${funding ? ` 8h funding at ${pct(f)}${Math.abs(f) > 0.04 ? ' — crowded positioning' : ''}.` : ''}`,
      falsifiableCondition: `Depth crossing the ${usd(minViable)} threshold in either direction inverts this assessment.`,
      weakestLink:
        'Depth is a point-in-time snapshot. It can be withdrawn faster than the next observation cycle.',
      cited,
      evidenceGaps: gaps(ctx, liquidityAnalyst.metricScope),
    };
  },
};

// ───────────────────────────────────────────────────── 3. volume integrity

const volumeIntegrity: AgentDefinition = {
  agentId: 'volume-integrity',
  name: 'Volume Integrity Analyst',
  discipline: 'volume_integrity',
  mandate:
    'Establishes how much reported volume is real. Its output gates every volume- or momentum-derived claim made by any other agent.',
  sourceScope: ['market_microstructure'],
  metricScope: ['wash_trading_score_pct'],
  maxConfidence: 80,
  agentVersion: '1.0.0',
  reason: (ctx) => {
    const wash = ctx.byMetric['wash_trading_score_pct'];
    if (!wash) {
      return {
        stance: 'ABSTAIN',
        confidence: 0,
        rationale: `No wash-trading estimate for ${ctx.symbol}. Until one exists, reported volume must be treated as unusable rather than as real.`,
        falsifiableCondition: 'A wash-trading score observation becomes available.',
        weakestLink: 'No evidence available.',
        cited: [],
        evidenceGaps: gaps(ctx, volumeIntegrity.metricScope),
      };
    }

    const w = wash.value ?? 0;
    const stance: Stance = w > 60 ? 'BLOCK_RECOMMENDED' : w > 30 ? 'BEARISH' : 'NEUTRAL';

    return {
      stance,
      confidence: w > 60 ? 76 : w > 30 ? 62 : 50,
      rationale:
        w > 60
          ? `An estimated ${pct(w)} of ${ctx.symbol}'s reported volume is non-economic. Any momentum or interest signal on this token is measuring wash flow, not demand. Volume-derived theses must be discarded, not discounted.`
          : `An estimated ${pct(w)} of ${ctx.symbol}'s reported volume is non-economic. Effective tradeable volume is ${pct(Math.max(0, 100 - w))} of headline; downstream momentum claims must be scaled by this.`,
      falsifiableCondition:
        'Wash score falling below 30% across two consecutive cycles would restore volume-derived signals.',
      weakestLink:
        'Wash detection is inferential — sophisticated circular flow through fresh addresses reads as organic.',
      cited: [wash],
      evidenceGaps: [],
    };
  },
};

// ────────────────────────────────────────────────────────── 4. narrative

const narrativeAnalyst: AgentDefinition = {
  agentId: 'narrative-analyst',
  name: 'Narrative Analyst',
  discipline: 'narrative',
  mandate:
    'Measures attention, explicitly as attention and never as fundamentals. Structurally capped in confidence because its inputs are claims, not facts.',
  sourceScope: ['narrative_social'],
  metricScope: ['mention_velocity_change_pct_6h', 'kol_post_reach'],
  // Hard ceiling: narrative may inform, never carry, a decision.
  maxConfidence: 45,
  agentVersion: '1.0.0',
  reason: (ctx) => {
    const vel = ctx.byMetric['mention_velocity_change_pct_6h'];
    const kol = ctx.byMetric['kol_post_reach'];
    const cited = [vel, kol].filter(Boolean);

    if (!vel && !kol) {
      return {
        stance: 'ABSTAIN',
        confidence: 0,
        rationale: `No attention data for ${ctx.symbol}.`,
        falsifiableCondition: 'A narrative observation becomes available.',
        weakestLink: 'No evidence available.',
        cited,
        evidenceGaps: gaps(ctx, narrativeAnalyst.metricScope),
      };
    }

    const v = vel?.value ?? 0;
    const depth = ctx.byMetric['pool_depth_2pct_usd']?.value ?? null;

    // Attention spiking into thin depth is the exit-liquidity pattern.
    const hypeIntoThinBook = v > 80 && depth !== null && depth < 60_000;

    const stance: Stance = hypeIntoThinBook ? 'BEARISH' : v > 40 ? 'BULLISH' : v < -20 ? 'BEARISH' : 'NEUTRAL';

    return {
      stance,
      confidence: hypeIntoThinBook ? 44 : Math.min(44, 20 + Math.min(Math.abs(v) / 4, 20)),
      rationale: hypeIntoThinBook
        ? `Mention velocity for ${ctx.symbol} is ${v >= 0 ? '+' : ''}${pct(v)} into an order book of only ${usd(depth!)}. Attention arriving faster than liquidity is the exit-liquidity pattern, not a demand signal.`
        : `Attention on ${ctx.symbol} moved ${v >= 0 ? '+' : ''}${pct(v)} over 6h versus baseline.${kol ? ` A ${(kol.value ?? 0).toLocaleString()}-follower account posted about it — an unverified claim, weighted as such.` : ''}`,
      falsifiableCondition:
        'Attention reverting to baseline within two cycles with no accompanying flow or depth change.',
      weakestLink:
        'Mention counts are trivially manufacturable. This agent cannot distinguish organic interest from a paid campaign.',
      cited,
      evidenceGaps: gaps(ctx, narrativeAnalyst.metricScope),
    };
  },
};

// ───────────────────────────────────────────────────────── 5. regulatory

const regulatoryAnalyst: AgentDefinition = {
  agentId: 'regulatory-analyst',
  name: 'Regulatory Analyst',
  discipline: 'regulatory',
  mandate:
    'Applies jurisdiction rules and screening results. Never updates the registry itself — a classification change is a human act.',
  sourceScope: ['regulatory'],
  metricScope: ['ofac_screening_hit', 'classification_review_signal'],
  maxConfidence: 95,
  agentVersion: '1.0.0',
  reason: (ctx) => {
    const ofac = ctx.byMetric['ofac_screening_hit'];
    const review = ctx.byMetric['classification_review_signal'];
    const cited = [ofac, review].filter(Boolean);

    const sanctioned = (ofac?.value ?? 0) === 1;
    const j = ctx.jurisdiction;
    const blockers: string[] = [];

    if (sanctioned) blockers.push('a sanctions screening hit in the holder set');
    if (j?.requiresPreApproval && ctx.regulatoryStatus !== 'digital_commodity') {
      blockers.push(
        `${j.jurisdictionId} requires per-token pre-approval and this token's status is "${ctx.regulatoryStatus}"`
      );
    }
    // Unclassified status + unlocked liquidity on a Tier 3 asset is a block, not a warning.
    if (
      ctx.tier === 3 &&
      ctx.regulatoryStatus === 'unclassified' &&
      ctx.liquidityLockStatus !== 'locked'
    ) {
      blockers.push(
        'Tier 3 asset with unclassified regulatory status and liquidity that is not locked'
      );
    }

    const capitalMismatch =
      !!ctx.capitalOriginJurisdictionId &&
      !!ctx.liquidityVenueJurisdictionId &&
      ctx.capitalOriginJurisdictionId !== ctx.liquidityVenueJurisdictionId;

    if (blockers.length > 0) {
      return {
        stance: 'BLOCK_RECOMMENDED',
        confidence: sanctioned ? 95 : 85,
        rationale: `${ctx.symbol} is blocked on regulatory grounds: ${blockers.join('; ')}.${capitalMismatch ? ` Capital originates in ${ctx.capitalOriginJurisdictionId} while liquidity sits in ${ctx.liquidityVenueJurisdictionId} — exchange-control treatment applies independently of the trade thesis.` : ''}`,
        falsifiableCondition:
          'A human-confirmed registry fact granting pre-approval or reclassifying the token, with a source and effective date, clears this block.',
        weakestLink:
          'Jurisdiction rules are only as current as the last versioned registry fact; a lapsed effective date would silently weaken this.',
        cited,
        evidenceGaps: gaps(ctx, regulatoryAnalyst.metricScope),
      };
    }

    return {
      stance: review ? 'BEARISH' : 'NEUTRAL',
      confidence: review ? 55 : 60,
      rationale: review
        ? `Signal that ${ctx.symbol}'s classification in ${j?.jurisdictionId ?? 'its venue jurisdiction'} may be under review. Inferred only — this does not change the registry's versioned status without human confirmation, but it raises tail risk on any new exposure.`
        : `No regulatory blockers for ${ctx.symbol} in ${j?.jurisdictionId ?? 'its venue jurisdiction'}. Status "${ctx.regulatoryStatus}", screening clean.${capitalMismatch ? ` Note: capital origin (${ctx.capitalOriginJurisdictionId}) differs from liquidity venue (${ctx.liquidityVenueJurisdictionId}) — exchange-control reporting still applies.` : ''}`,
      falsifiableCondition:
        'A sanctions hit, a delisting event, or a new versioned classification fact would reverse this.',
      weakestLink: 'Absence of a review signal is not evidence of regulatory safety.',
      cited,
      evidenceGaps: gaps(ctx, regulatoryAnalyst.metricScope),
    };
  },
};

// ─────────────────────────────────────────────────────────── 6. security

const securityAnalyst: AgentDefinition = {
  agentId: 'security-analyst',
  name: 'Security Analyst',
  discipline: 'security',
  mandate:
    'Assesses whether the asset can be sold at all and whether its dependency set is compromised. Concerned with mechanism, not price.',
  sourceScope: ['security'],
  metricScope: ['honeypot_risk_score', 'related_exploit_disclosure'],
  maxConfidence: 92,
  agentVersion: '1.0.0',
  reason: (ctx) => {
    const hp = ctx.byMetric['honeypot_risk_score'];
    const exploit = ctx.chainByMetric['related_exploit_disclosure'];
    const cited = [hp, exploit].filter(Boolean);

    if (!hp && !exploit) {
      return {
        stance: 'ABSTAIN',
        confidence: 0,
        rationale: `No security readings for ${ctx.symbol}. Sell-path integrity is unverified.`,
        falsifiableCondition: 'A honeypot simulation result becomes available.',
        weakestLink: 'No evidence available.',
        cited,
        evidenceGaps: gaps(ctx, securityAnalyst.metricScope, ['related_exploit_disclosure']),
      };
    }

    const score = hp?.value ?? 0;
    const severe = score > 55 || ctx.honeypotCheckResult === 'honeypot';

    return {
      stance: severe ? 'BLOCK_RECOMMENDED' : score > 30 ? 'BEARISH' : 'NEUTRAL',
      confidence: severe ? 90 : score > 30 ? 65 : 58,
      rationale: severe
        ? `Simulated sell-path analysis scores ${ctx.symbol} at ${score}/100 for transfer-restriction risk${ctx.honeypotCheckResult === 'honeypot' ? ' and the registry already flags it as a honeypot' : ''}. An asset that may not be sellable cannot be sized, no matter the upside case.`
        : `Sell-path risk for ${ctx.symbol} scores ${score}/100. Contract audit status: ${ctx.contractAuditStatus}.${exploit ? ` An exploit disclosure touching ${ctx.chainId} may affect its dependency set.` : ''}`,
      falsifiableCondition:
        'A successful full-size round-trip sell simulation, or a completed audit clearing the transfer path.',
      weakestLink:
        'Honeypot simulation tests current contract state; an upgradeable contract can add restrictions after this reading.',
      cited,
      evidenceGaps: gaps(ctx, securityAnalyst.metricScope, ['related_exploit_disclosure']),
    };
  },
};

// ────────────────────────────────────────────────── 7. token structure

const structureAnalyst: AgentDefinition = {
  agentId: 'structure-analyst',
  name: 'Token Structure Analyst',
  discipline: 'token_structure',
  mandate:
    'Reads the asset\'s own construction — supply concentration, LP lock, audit state — independently of market conditions.',
  sourceScope: ['on_chain'],
  metricScope: ['lp_balance_change_pct_24h'],
  maxConfidence: 82,
  agentVersion: '1.0.0',
  reason: (ctx) => {
    const lp = ctx.byMetric['lp_balance_change_pct_24h'];
    const cited = [lp].filter(Boolean);

    const faults: string[] = [];
    if (ctx.liquidityLockStatus === 'unlocked') faults.push('liquidity is unlocked');
    else if (ctx.liquidityLockStatus === 'partial') faults.push('liquidity is only partially locked');
    else if (ctx.liquidityLockStatus === 'unknown') faults.push('LP lock status is unknown');

    if ((ctx.top10HolderPct ?? 0) > 60)
      faults.push(`top-10 holders control ${pct(ctx.top10HolderPct!)} of supply`);
    if ((ctx.devWalletPct ?? 0) > 15)
      faults.push(`dev wallets hold ${pct(ctx.devWalletPct!)} of supply`);
    if (ctx.contractAuditStatus === 'unaudited') faults.push('contract is unaudited');

    // Structural faults are graded, but on a Tier 3 asset an unlocked LP plus
    // concentrated supply is a rug mechanism, not a risk factor.
    const rugMechanism =
      ctx.tier === 3 && ctx.liquidityLockStatus === 'unlocked' && (ctx.top10HolderPct ?? 0) > 50;

    const stance: Stance = rugMechanism
      ? 'BLOCK_RECOMMENDED'
      : faults.length >= 2
        ? 'BEARISH'
        : faults.length === 1
          ? 'NEUTRAL'
          : 'BULLISH';

    return {
      stance,
      confidence: rugMechanism ? 80 : faults.length >= 2 ? 68 : 52,
      rationale: rugMechanism
        ? `${ctx.symbol} has the complete rug mechanism in place: Tier 3 asset, unlocked liquidity, and ${pct(ctx.top10HolderPct!)} of supply in the top 10 holders. The counterparty can remove the market at will.`
        : faults.length > 0
          ? `Structural faults on ${ctx.symbol}: ${faults.join('; ')}.${lp ? ` Pooled liquidity moved ${(lp.value ?? 0) >= 0 ? '+' : ''}${pct(lp.value ?? 0)} in 24h.` : ''}`
          : `${ctx.symbol} is structurally sound: ${ctx.liquidityLockStatus} liquidity, ${ctx.contractAuditStatus} contract, supply not visibly concentrated.`,
      falsifiableCondition:
        'A verified LP lock with an expiry beyond the intended holding period, plus supply dispersion below 50% in the top 10, clears the structural objection.',
      weakestLink:
        'Registry structure fields are seeded reference data, not a live contract read — they can be stale.',
      cited,
      evidenceGaps: gaps(ctx, structureAnalyst.metricScope),
    };
  },
};

// ───────────────────────────────────────────────────── 8. adversarial

const redTeam: AgentDefinition = {
  agentId: 'red-team',
  name: 'Adversarial Red Team',
  discipline: 'adversarial',
  mandate:
    'Argues the case against acting. Exists to make the absence of evidence visible and to state the loss path explicitly. Never issues a bullish thesis.',
  sourceScope: ['on_chain', 'market_microstructure', 'narrative_social', 'regulatory', 'security'],
  metricScope: [
    'pool_depth_2pct_usd',
    'wash_trading_score_pct',
    'mention_velocity_change_pct_6h',
    'honeypot_risk_score',
  ],
  // Capped: the red team must not be able to dominate on confidence alone.
  maxConfidence: 70,
  agentVersion: '1.0.0',
  reason: (ctx) => {
    const declared = redTeam.metricScope;
    const present = declared.filter((m) => ctx.byMetric[m]);
    const missing = declared.filter((m) => !ctx.byMetric[m]);
    const cited = present.map((m) => ctx.byMetric[m]);

    const depth = ctx.byMetric['pool_depth_2pct_usd']?.value ?? null;
    const wash = ctx.byMetric['wash_trading_score_pct']?.value ?? null;
    const vel = ctx.byMetric['mention_velocity_change_pct_6h']?.value ?? null;

    const attacks: string[] = [];
    if (missing.length > 0)
      attacks.push(
        `the swarm is missing ${missing.length} of ${declared.length} declared inputs (${missing.join(', ')}), so any consensus is partly an artefact of what was not measured`
      );
    if (depth !== null && wash !== null && wash > 40)
      attacks.push(
        `the ${usd(depth)} book is ${pct(wash)} non-economic, meaning real exit depth is closer to ${usd(depth * (1 - wash / 100))}`
      );
    if (vel !== null && vel > 50 && depth !== null && depth < 100_000)
      attacks.push(
        'attention is arriving faster than liquidity — the profitable trade here may be the one being sold to us'
      );
    if (ctx.category === 'fresh-launch')
      attacks.push(
        'there is no out-of-sample history for a fresh launch; every backtest of this cohort is survivorship-biased by construction'
      );
    if (ctx.tier === 3)
      attacks.push('Tier 3 assets fail in correlated clusters, so position-level sizing understates portfolio loss');

    if (attacks.length === 0) {
      return {
        stance: 'NEUTRAL',
        confidence: 35,
        rationale: `No specific attack path found against ${ctx.symbol} on the available evidence. This is a weak result, not an endorsement — it reflects the narrow set of metrics this agent can test.`,
        falsifiableCondition: 'Any new adverse observation on depth, wash score, or sell-path integrity.',
        weakestLink: 'The absence of a found attack is limited by the metrics available to test.',
        cited,
        evidenceGaps: missing,
      };
    }

    return {
      stance: attacks.length >= 3 ? 'BLOCK_RECOMMENDED' : 'BEARISH',
      confidence: Math.min(70, 35 + attacks.length * 10),
      rationale: `Case against acting on ${ctx.symbol}: ${attacks.join('; ')}. Loss path: entry at advertised depth, adverse fill on exit, realised slippage several multiples of the modelled figure.`,
      falsifiableCondition:
        'Each listed attack is individually falsifiable by the corresponding observation moving into a benign range; the thesis fails when all of them do.',
      weakestLink:
        'This agent is structurally pessimistic and will produce a bearish case even where the true expected value is positive.',
      cited,
      evidenceGaps: missing,
    };
  },
};

export const CORE_AGENTS: AgentDefinition[] = [
  flowAnalyst,
  liquidityAnalyst,
  volumeIntegrity,
  narrativeAnalyst,
  regulatoryAnalyst,
  securityAnalyst,
  structureAnalyst,
  redTeam,
];
