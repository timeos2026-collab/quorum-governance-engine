import type { RiskDomain, RiskVerdict } from './db';

/**
 * THE RISK RULESET
 *
 * Every rule is named, versioned, and states its own worst possible verdict up
 * front. Rules are evaluated independently and their findings are never summed
 * — the assessment takes the most restrictive finding, so one BLOCK cannot be
 * diluted by a dozen clean checks.
 *
 * Rules that produce BLOCK are marked non-overridable. A human can release a
 * REQUIRES_HUMAN_APPROVAL — that is the verdict's entire purpose — but cannot
 * wave through a hard block from inside the app. Clearing a block means the
 * rule changes or the fact changes, and both are versioned and attributable.
 */

export const RISK_ENGINE_VERSION = 'risk-gate@1.0.0';

export type RuleEvidence = { label: string; value: string; source: string };

export type RuleFinding = {
  verdict: RiskVerdict;
  finding: string;
  evidence: RuleEvidence[];
  citedObservationKeys?: string[];
  /** Caps the permitted position size, in USD. */
  sizeCapUsd?: number;
  /** Restriction text attached to the assessment. */
  restriction?: string;
};

export type ObservationRef = {
  observationKey: string;
  metric: string;
  value?: number;
  verifiability: string;
  statement: string;
};

export type JurisdictionView = {
  jurisdictionId: string;
  name: string;
  regimeType: string;
  requiresPreApproval: boolean;
  exchangeControlFlag: boolean;
  source: string;
  effectiveFrom: Date;
};

export type GateContext = {
  strategyKey: string;
  subjectId: string;
  symbol: string;
  tier: 1 | 2 | 3;
  category: string;
  stance: string;
  /** Validation lifecycle state at the moment of assessment. */
  strategyState: string;
  proposedSizeUsd: number;

  liquidityLockStatus: string;
  regulatoryStatus: string;
  contractAuditStatus: string;
  honeypotCheckResult: string;
  devWalletPct?: number;
  top10HolderPct?: number;

  /**
   * Capital-origin and liquidity-venue jurisdictions are deliberately separate.
   * Under SA exchange control the same position can be compliant where it
   * trades and non-compliant where the money came from.
   */
  capitalOrigin: JurisdictionView | null;
  liquidityVenue: JurisdictionView | null;
  /** Whether a pre-approval fact exists for this token in a gating jurisdiction. */
  hasPreApprovalOnRecord: boolean;

  byMetric: Map<string, ObservationRef>;
};

export type RiskRule = {
  ruleId: string;
  version: string;
  domain: RiskDomain;
  title: string;
  statement: string;
  rationale: string;
  maxVerdict: RiskVerdict;
  overridable: boolean;
  evaluate: (ctx: GateContext) => RuleFinding;
};

const clean = (finding: string, evidence: RuleEvidence[] = []): RuleFinding => ({
  verdict: 'APPROVED',
  finding,
  evidence,
});

// ---------------------------------------------------------------------------

/**
 * Nigeria (and any regime flagged `requiresPreApproval`) requires per-token SEC
 * sign-off before any offering or trading — meme coins are NOT exempt. Encoded
 * as a jurisdiction property, not a Nigeria special case, so any regime that
 * adopts the same posture is covered without a code change.
 */
const preApprovalRule: RiskRule = {
  ruleId: 'JUR_PRE_APPROVAL_REQUIRED',
  version: '1.0.0',
  domain: 'JURISDICTION',
  title: 'Per-token pre-approval required by jurisdiction',
  statement:
    'If either the capital-origin or liquidity-venue jurisdiction requires per-token regulatory pre-approval, no action may proceed without an approval fact on record for this specific token. No category is exempt, including meme coins.',
  rationale:
    'Regimes such as the Nigerian SEC require token-by-token clearance. Treating a class of assets as beneath the requirement is precisely the assumption that produces an unlicensed offering.',
  maxVerdict: 'BLOCKED',
  overridable: false,
  evaluate: (ctx) => {
    const gating = [ctx.capitalOrigin, ctx.liquidityVenue].filter(
      (j): j is JurisdictionView => !!j && j.requiresPreApproval
    );
    if (gating.length === 0) {
      return clean('No jurisdiction in scope imposes a per-token pre-approval requirement.');
    }

    const evidence: RuleEvidence[] = gating.map((j) => ({
      label: `${j.name} (${j.regimeType})`,
      value: 'requiresPreApproval = true',
      source: j.source,
    }));

    if (ctx.hasPreApprovalOnRecord) {
      return {
        verdict: 'APPROVED_WITH_RESTRICTIONS',
        finding: `${gating.map((j) => j.name).join(' and ')} require per-token pre-approval and an approval fact is on record for ${ctx.symbol}. Action may proceed under the terms of that approval.`,
        evidence,
        restriction: `Action is limited to the scope of the recorded ${gating[0].name} pre-approval; any change of venue or instrument requires re-approval.`,
      };
    }

    return {
      verdict: 'BLOCKED',
      finding: `${gating.map((j) => j.name).join(' and ')} require per-token pre-approval and no approval fact exists for ${ctx.symbol}. Category "${ctx.category}" does not exempt it.`,
      evidence,
    };
  },
};

/**
 * The specific combination the spec calls out: an unclassified Tier 3 asset
 * with unlocked LP is a hard block, not a warning. Unclassified means no
 * compliant exit venue is guaranteed; unlocked LP means the exit can be removed
 * by someone else at will. Together there is no position to size down to.
 */
const tier3UnclassifiedRule: RiskRule = {
  ruleId: 'TIER3_UNCLASSIFIED_UNLOCKED_LP',
  version: '1.0.0',
  domain: 'TIER_EXPOSURE',
  title: 'Tier 3 + unclassified status + unlocked LP',
  statement:
    'A Tier 3 asset whose regulatory status is unclassified AND whose liquidity is unlocked or of unknown lock status is BLOCKED. This is a hard block, not a soft warning, and is not size-reducible.',
  rationale:
    'Unclassified status means no exit venue is assured; unlocked LP means the exit can be withdrawn by a third party without notice. Neither risk is mitigated by trading smaller — a smaller position in an asset you cannot sell is still an asset you cannot sell.',
  maxVerdict: 'BLOCKED',
  overridable: false,
  evaluate: (ctx) => {
    const lpExposed =
      ctx.liquidityLockStatus === 'unlocked' || ctx.liquidityLockStatus === 'unknown';
    const unclassified = ctx.regulatoryStatus === 'unclassified';

    const evidence: RuleEvidence[] = [
      { label: 'Tier', value: String(ctx.tier), source: 'registry:tokens' },
      { label: 'Regulatory status', value: ctx.regulatoryStatus, source: 'registry:tokens' },
      { label: 'LP lock status', value: ctx.liquidityLockStatus, source: 'registry:tokens' },
    ];

    if (ctx.tier === 3 && unclassified && lpExposed) {
      return {
        verdict: 'BLOCKED',
        finding: `Tier 3 ${ctx.symbol} is regulatorily unclassified with "${ctx.liquidityLockStatus}" liquidity. No compliant exit venue is assured and the pool itself can be withdrawn. Blocked outright rather than sized down.`,
        evidence,
      };
    }

    if (ctx.tier === 3 && (unclassified || lpExposed)) {
      return {
        verdict: 'REQUIRES_HUMAN_APPROVAL',
        finding: `Tier 3 ${ctx.symbol} carries one of the two blocking conditions (${unclassified ? 'unclassified status' : `"${ctx.liquidityLockStatus}" liquidity`}) but not both. A human must accept the residual risk explicitly.`,
        evidence,
      };
    }

    return clean(
      `Tier ${ctx.tier} ${ctx.symbol} does not meet the unclassified-plus-unlocked block condition.`,
      evidence
    );
  },
};

/**
 * SA exchange control treats crypto as both money and capital, so the origin of
 * the capital is a separate compliance question from where the asset trades.
 * A mismatch is never silently allowed.
 */
const capitalOriginRule: RiskRule = {
  ruleId: 'CAPITAL_ORIGIN_VENUE_MISMATCH',
  version: '1.0.0',
  domain: 'CAPITAL_CONTROL',
  title: 'Capital origin under exchange control differs from liquidity venue',
  statement:
    'If the capital-origin jurisdiction operates exchange control and differs from the liquidity-venue jurisdiction, the action requires human approval and is capped, regardless of the asset tier.',
  rationale:
    'South African exchange control treats crypto as simultaneously money and capital. Cross-border deployment of that capital is a distinct regulatory event from the trade itself, and collapsing the two into one jurisdiction field is how a compliant trade becomes an unauthorised outward transfer.',
  maxVerdict: 'REQUIRES_HUMAN_APPROVAL',
  overridable: true,
  evaluate: (ctx) => {
    const origin = ctx.capitalOrigin;
    const venue = ctx.liquidityVenue;

    if (!origin) {
      return {
        verdict: 'REQUIRES_HUMAN_APPROVAL',
        finding:
          'Capital-origin jurisdiction is not recorded for this position. Exchange-control exposure cannot be established, and an unestablished control position is not a clear one.',
        evidence: [{ label: 'Capital origin', value: 'unrecorded', source: 'registry:tokens' }],
      };
    }

    const evidence: RuleEvidence[] = [
      {
        label: 'Capital origin',
        value: `${origin.name} (exchange control: ${origin.exchangeControlFlag})`,
        source: origin.source,
      },
      {
        label: 'Liquidity venue',
        value: venue ? `${venue.name} (${venue.regimeType})` : 'unrecorded',
        source: venue?.source ?? 'registry:tokens',
      },
    ];

    if (!origin.exchangeControlFlag) {
      return clean(
        `Capital origin ${origin.name} does not operate exchange control; cross-border deployment is not a gating event here.`,
        evidence
      );
    }

    if (venue && venue.jurisdictionId === origin.jurisdictionId) {
      return clean(
        `Capital and liquidity are both in ${origin.name}; no cross-border movement of controlled capital.`,
        evidence
      );
    }

    return {
      verdict: 'REQUIRES_HUMAN_APPROVAL',
      finding: `Capital originates in ${origin.name}, which operates exchange control, while liquidity sits in ${venue?.name ?? 'an unrecorded jurisdiction'}. This is an outward deployment of controlled capital and needs an explicit human decision, not an inferred one.`,
      evidence,
      sizeCapUsd: 50_000,
      restriction: `Cross-border exposure capped at $50,000 pending ${origin.name} exchange-control clearance.`,
    };
  },
};

/** Tier exposure ceilings. Crypto is not one asset class and is not gated as one. */
const tierSizeRule: RiskRule = {
  ruleId: 'TIER_POSITION_CEILING',
  version: '1.0.0',
  domain: 'TIER_EXPOSURE',
  title: 'Position ceiling by asset tier',
  statement:
    'Tier 1 positions are capped at $500,000, Tier 2 at $100,000 and Tier 3 at $15,000. A request above the ceiling is approved with restrictions at the ceiling, never rejected outright.',
  rationale:
    'A major and a fresh launch are not the same instrument and must not share a limit. Reducing to the ceiling rather than refusing keeps the gate from being routed around by resubmission.',
  maxVerdict: 'APPROVED_WITH_RESTRICTIONS',
  overridable: true,
  evaluate: (ctx) => {
    const ceiling = ctx.tier === 1 ? 500_000 : ctx.tier === 2 ? 100_000 : 15_000;
    const evidence: RuleEvidence[] = [
      { label: 'Tier', value: String(ctx.tier), source: 'registry:tokens' },
      { label: 'Requested size', value: `$${ctx.proposedSizeUsd.toLocaleString()}`, source: 'module request' },
      { label: 'Tier ceiling', value: `$${ceiling.toLocaleString()}`, source: 'policy' },
    ];

    if (ctx.proposedSizeUsd <= ceiling) {
      return clean(
        `Requested $${ctx.proposedSizeUsd.toLocaleString()} is within the Tier ${ctx.tier} ceiling of $${ceiling.toLocaleString()}.`,
        evidence
      );
    }

    return {
      verdict: 'APPROVED_WITH_RESTRICTIONS',
      finding: `Requested $${ctx.proposedSizeUsd.toLocaleString()} exceeds the Tier ${ctx.tier} ceiling of $${ceiling.toLocaleString()}; permitted size reduced to the ceiling.`,
      evidence,
      sizeCapUsd: ceiling,
      restriction: `Size capped at the Tier ${ctx.tier} ceiling of $${ceiling.toLocaleString()}.`,
    };
  },
};

/** Exit depth. Size the gate permits is bounded by what the pool can absorb. */
const liquidityRule: RiskRule = {
  ruleId: 'EXIT_DEPTH_SUFFICIENCY',
  version: '1.0.0',
  domain: 'LIQUIDITY',
  title: 'Permitted size bounded by observed exit depth',
  statement:
    'Permitted size may not exceed the observed 2% pool depth. Where no depth observation exists, the action requires human approval rather than proceeding on an assumed exit.',
  rationale:
    'Entry is always available; exit is the risk. A position larger than the depth that absorbs it is a position that can only be closed at a price nobody modelled.',
  maxVerdict: 'REQUIRES_HUMAN_APPROVAL',
  overridable: true,
  evaluate: (ctx) => {
    const depth = ctx.byMetric.get('pool_depth_2pct_usd');
    if (!depth || depth.value === undefined) {
      return {
        verdict: 'REQUIRES_HUMAN_APPROVAL',
        finding:
          'No pool-depth observation is available. The gate will not assume an exit exists; a human must accept the unmeasured exit risk.',
        evidence: [{ label: 'Pool depth', value: 'unobserved', source: 'evidence layer' }],
      };
    }

    const evidence: RuleEvidence[] = [
      {
        label: 'Observed 2% depth',
        value: `$${depth.value.toLocaleString()}`,
        source: `evidence:${depth.observationKey}`,
      },
      { label: 'Requested size', value: `$${ctx.proposedSizeUsd.toLocaleString()}`, source: 'module request' },
    ];

    if (ctx.proposedSizeUsd <= depth.value) {
      return {
        ...clean(
          `Requested $${ctx.proposedSizeUsd.toLocaleString()} sits inside observed 2% depth of $${depth.value.toLocaleString()}.`,
          evidence
        ),
        citedObservationKeys: [depth.observationKey],
      };
    }

    return {
      verdict: 'APPROVED_WITH_RESTRICTIONS',
      finding: `Requested $${ctx.proposedSizeUsd.toLocaleString()} exceeds observed 2% depth of $${depth.value.toLocaleString()}; permitted size reduced to observed depth.`,
      evidence,
      citedObservationKeys: [depth.observationKey],
      sizeCapUsd: Math.floor(depth.value),
      restriction: `Size capped at observed 2% pool depth of $${Math.floor(depth.value).toLocaleString()}.`,
    };
  },
};

/** Contract-level security. A honeypot is a block; unaudited is a human call. */
const securityRule: RiskRule = {
  ruleId: 'CONTRACT_SECURITY_POSTURE',
  version: '1.0.0',
  domain: 'SECURITY',
  title: 'Contract security posture',
  statement:
    'A confirmed honeypot, or a honeypot risk score above 70, is BLOCKED. An unaudited contract at Tier 3 requires human approval.',
  rationale:
    'A contract that cannot be sold out of is not a risky position, it is not a position at all. This is the one check that is about whether the asset is real rather than whether the trade is good.',
  maxVerdict: 'BLOCKED',
  overridable: false,
  evaluate: (ctx) => {
    const score = ctx.byMetric.get('honeypot_risk_score');
    const evidence: RuleEvidence[] = [
      { label: 'Honeypot check', value: ctx.honeypotCheckResult, source: 'registry:tokens' },
      { label: 'Audit status', value: ctx.contractAuditStatus, source: 'registry:tokens' },
    ];
    if (score?.value !== undefined) {
      evidence.push({
        label: 'Honeypot risk score',
        value: String(score.value),
        source: `evidence:${score.observationKey}`,
      });
    }

    if (ctx.honeypotCheckResult === 'honeypot' || (score?.value ?? 0) > 70) {
      return {
        verdict: 'BLOCKED',
        finding: `${ctx.symbol} presents as a honeypot (check: ${ctx.honeypotCheckResult}${score?.value !== undefined ? `, risk score ${score.value}` : ''}). The sell side is not reliably reachable.`,
        evidence,
        citedObservationKeys: score ? [score.observationKey] : [],
      };
    }

    if (ctx.honeypotCheckResult === 'not_run') {
      return {
        verdict: 'REQUIRES_HUMAN_APPROVAL',
        finding: `No honeypot check has been run on ${ctx.symbol}. An unrun check is not a clean check.`,
        evidence,
      };
    }

    if (ctx.tier === 3 && ctx.contractAuditStatus !== 'audited') {
      return {
        verdict: 'REQUIRES_HUMAN_APPROVAL',
        finding: `Tier 3 ${ctx.symbol} is "${ctx.contractAuditStatus}". A human must accept unaudited contract risk explicitly.`,
        evidence,
        citedObservationKeys: score ? [score.observationKey] : [],
      };
    }

    return {
      ...clean(`Contract posture acceptable: ${ctx.honeypotCheckResult}, ${ctx.contractAuditStatus}.`, evidence),
      citedObservationKeys: score ? [score.observationKey] : [],
    };
  },
};

/** Holder concentration — the counterparty who can end the position alone. */
const concentrationRule: RiskRule = {
  ruleId: 'HOLDER_CONCENTRATION',
  version: '1.0.0',
  domain: 'COUNTERPARTY',
  title: 'Insider and holder concentration',
  statement:
    'A dev wallet above 20% of supply, or top-10 holders above 70%, requires human approval. Above 35% dev wallet the action is blocked.',
  rationale:
    'Concentration is the counterparty risk that does not appear on any counterparty list: a single holder able to end the position unilaterally is a risk no position size mitigates proportionally.',
  maxVerdict: 'BLOCKED',
  overridable: false,
  evaluate: (ctx) => {
    const evidence: RuleEvidence[] = [];
    if (ctx.devWalletPct !== undefined) {
      evidence.push({
        label: 'Dev wallet share',
        value: `${ctx.devWalletPct}%`,
        source: 'registry:tokens',
      });
    }
    if (ctx.top10HolderPct !== undefined) {
      evidence.push({
        label: 'Top-10 holder share',
        value: `${ctx.top10HolderPct}%`,
        source: 'registry:tokens',
      });
    }

    if ((ctx.devWalletPct ?? 0) > 35) {
      return {
        verdict: 'BLOCKED',
        finding: `Dev wallet holds ${ctx.devWalletPct}% of supply. A single unilateral seller of that size makes the position untenable at any size.`,
        evidence,
      };
    }

    if ((ctx.devWalletPct ?? 0) > 20 || (ctx.top10HolderPct ?? 0) > 70) {
      return {
        verdict: 'REQUIRES_HUMAN_APPROVAL',
        finding: `Concentration is elevated (dev ${ctx.devWalletPct ?? 'n/a'}%, top-10 ${ctx.top10HolderPct ?? 'n/a'}%). A human must accept the unilateral-seller risk.`,
        evidence,
      };
    }

    return clean('Holder concentration within tolerance.', evidence);
  },
};

/**
 * The rule that keeps the pipeline honest. Reaching the gate does not imply
 * validation succeeded, and the gate checks rather than assumes.
 */
const validationIntegrityRule: RiskRule = {
  ruleId: 'VALIDATION_PREREQUISITE',
  version: '1.0.0',
  domain: 'VALIDATION_INTEGRITY',
  title: 'Validation must have passed before the gate assesses',
  statement:
    'Any strategy not in PAPER, SHADOW or PRODUCTION is BLOCKED at the gate. Agent consensus and debate outcome are not substitutes for validation.',
  rationale:
    'The gate is the last checkpoint, which makes it the one most likely to be reached by something that skipped an earlier one. It verifies the prerequisite rather than trusting the caller.',
  maxVerdict: 'BLOCKED',
  overridable: false,
  evaluate: (ctx) => {
    const evidence: RuleEvidence[] = [
      { label: 'Strategy state', value: ctx.strategyState, source: 'validation lifecycle' },
    ];
    const eligible = ['PAPER', 'SHADOW', 'PRODUCTION'];
    if (!eligible.includes(ctx.strategyState)) {
      return {
        verdict: 'BLOCKED',
        finding: `Strategy is ${ctx.strategyState}. Only PAPER, SHADOW or PRODUCTION strategies may be assessed — validation is a prerequisite for the gate, not a parallel opinion.`,
        evidence,
      };
    }
    return clean(`Strategy is ${ctx.strategyState}; validation prerequisite satisfied.`, evidence);
  },
};

/**
 * The gate can never permit an execution mode above the strategy's own state.
 * Paper is the default and the ceiling until a human moves the lifecycle.
 */
const executionModeRule: RiskRule = {
  ruleId: 'EXECUTION_MODE_CEILING',
  version: '1.0.0',
  domain: 'EXECUTION_MODE',
  title: 'Permitted execution mode may not exceed lifecycle state',
  statement:
    'The gate permits at most the execution mode matching the strategy lifecycle state: PAPER→paper, SHADOW→shadow, PRODUCTION→production. It can never grant more.',
  rationale:
    'Two independent controls on live execution — the lifecycle and the gate — are only independent if neither can be used to bypass the other.',
  maxVerdict: 'APPROVED_WITH_RESTRICTIONS',
  overridable: false,
  evaluate: (ctx) => {
    const evidence: RuleEvidence[] = [
      { label: 'Lifecycle state', value: ctx.strategyState, source: 'validation lifecycle' },
    ];
    if (ctx.strategyState === 'PRODUCTION') {
      return clean('Production execution permitted by lifecycle state.', evidence);
    }
    return {
      verdict: 'APPROVED_WITH_RESTRICTIONS',
      finding: `Execution restricted to ${ctx.strategyState.toLowerCase()} mode by lifecycle state. The gate cannot grant live execution to a ${ctx.strategyState} strategy.`,
      evidence,
      restriction: `Execution mode limited to ${ctx.strategyState}.`,
    };
  },
};

export const RISK_RULES: RiskRule[] = [
  validationIntegrityRule,
  preApprovalRule,
  tier3UnclassifiedRule,
  capitalOriginRule,
  securityRule,
  concentrationRule,
  liquidityRule,
  tierSizeRule,
  executionModeRule,
];

export function policyKeyOf(rule: RiskRule) {
  return `${rule.ruleId}@${rule.version}`;
}
