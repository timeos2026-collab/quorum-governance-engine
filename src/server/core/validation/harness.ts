import type { TestResult, TestType } from './db';

/**
 * VALIDATION HARNESS
 *
 * Six independent tests. Each answers a different question about the world, so
 * none of them can substitute for another and none of them are averaged.
 *
 * The performance-history tests (backtest / walk-forward / regime) have no real
 * price history to read yet — QUORUM's evidence layer is currently synthetic.
 * Rather than fabricate a Sharpe ratio and present it as a measurement, those
 * tests derive a DETERMINISTIC synthetic track record from the strategy key and
 * label every result with its limitations. The three tests that CAN be computed
 * from actually-observed data — slippage on observed pool depth, wash-adjusted
 * volume, and the adversarial red team — read real observations from the
 * evidence layer.
 *
 * This split is deliberate and is surfaced in the UI. A validation record that
 * quietly mixes measured and imagined results is worse than no validation.
 */

export const VALIDATION_ENGINE_VERSION = 'validation-engine@1.0.0';

function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function rand(seed: string): number {
  let t = hashString(seed) + 0x6d2b79f5;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

function between(seed: string, min: number, max: number, decimals = 2): number {
  const v = min + rand(seed) * (max - min);
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function round(v: number, decimals = 2) {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export type Metric = {
  label: string;
  value: number;
  unit: string;
  threshold?: number;
  comparator?: string;
};

export type TestOutput = {
  type: TestType;
  result: TestResult;
  rule: string;
  finding: string;
  metrics: Metric[];
  limitations: string[];
  citedObservationKeys: string[];
};

export type ObservationView = {
  observationKey: string;
  metric: string;
  value?: number;
  verifiability: string;
  dataOrigin: string;
  statement: string;
};

export type StrategyContext = {
  strategyKey: string;
  subjectId: string;
  symbol: string;
  tier: 1 | 2 | 3;
  category: string;
  stance: string;
  conviction: number;
  liquidityLockStatus: string;
  regulatoryStatus: string;
  honeypotCheckResult: string;
  /** Latest observation per metric for this subject (and its chain). */
  byMetric: Map<string, ObservationView>;
  /** Intended position size the tests must clear, in USD. Tier-scaled. */
  intendedSizeUsd: number;
};

/** Position size a tier is expected to support. Tier 3 is deliberately small. */
export function intendedSizeForTier(tier: 1 | 2 | 3): number {
  if (tier === 1) return 500_000;
  if (tier === 2) return 100_000;
  return 15_000;
}

// ---------------------------------------------------------------------------
// 1. Survivorship-corrected backtest
// ---------------------------------------------------------------------------

function backtest(ctx: StrategyContext): TestOutput {
  const s = ctx.strategyKey;

  // A naive backtest silently drops tokens that died. The corrected run
  // includes them at their terminal loss, which is where most of the edge in
  // crypto backtests actually disappears.
  const universeSize = 40 + Math.floor(rand(`${s}:universe`) * 60);
  const deadTokens = Math.floor(universeSize * between(`${s}:mortality`, 0.18, 0.46, 4));
  const naiveReturnPct = between(`${s}:naive`, -10, 85);
  const survivorshipDragPct = round(
    (deadTokens / universeSize) * between(`${s}:drag`, 45, 110),
    2
  );
  const correctedReturnPct = round(naiveReturnPct - survivorshipDragPct, 2);

  const metrics: Metric[] = [
    { label: 'Universe size', value: universeSize, unit: 'tokens' },
    { label: 'Delisted / dead included', value: deadTokens, unit: 'tokens' },
    { label: 'Naive return (survivors only)', value: naiveReturnPct, unit: '%' },
    { label: 'Survivorship drag', value: survivorshipDragPct, unit: '%' },
    {
      label: 'Survivorship-corrected return',
      value: correctedReturnPct,
      unit: '%',
      threshold: 0,
      comparator: '>',
    },
  ];

  const limitations = [
    'Track record is DERIVED, not measured: QUORUM has no real price history connected yet.',
    'Corrected return assumes dead tokens exit at terminal value with no recovery.',
  ];

  if (correctedReturnPct <= 0) {
    return {
      type: 'SURVIVORSHIP_CORRECTED_BACKTEST',
      result: 'FAIL',
      rule: 'EDGE_DISAPPEARS_UNDER_SURVIVORSHIP_CORRECTION',
      finding: `Naive return of ${naiveReturnPct}% collapses to ${correctedReturnPct}% once the ${deadTokens} dead/delisted tokens in the ${universeSize}-token universe are included. The apparent edge was survivorship.`,
      metrics,
      limitations,
      citedObservationKeys: [],
    };
  }

  return {
    type: 'SURVIVORSHIP_CORRECTED_BACKTEST',
    result: 'PASS',
    rule: 'EDGE_SURVIVES_MORTALITY_CORRECTION',
    finding: `Return of ${correctedReturnPct}% holds after absorbing ${survivorshipDragPct}% of survivorship drag from ${deadTokens} dead tokens.`,
    metrics,
    limitations,
    citedObservationKeys: [],
  };
}

// ---------------------------------------------------------------------------
// 2. Walk-forward
// ---------------------------------------------------------------------------

function walkForward(ctx: StrategyContext): TestOutput {
  const s = ctx.strategyKey;
  const inSample = between(`${s}:is`, 8, 70);
  const degradation = between(`${s}:degrade`, 0.15, 1.05, 4);
  const outOfSample = round(inSample * (1 - degradation), 2);
  const degradationPct = round(degradation * 100, 1);
  const folds = 4 + Math.floor(rand(`${s}:folds`) * 5);
  const positiveFolds = Math.round(folds * between(`${s}:posfolds`, 0.25, 1, 4));

  const metrics: Metric[] = [
    { label: 'Folds', value: folds, unit: 'windows' },
    { label: 'In-sample return', value: inSample, unit: '%' },
    { label: 'Out-of-sample return', value: outOfSample, unit: '%' },
    {
      label: 'Degradation',
      value: degradationPct,
      unit: '%',
      threshold: 60,
      comparator: '<=',
    },
    {
      label: 'Profitable folds',
      value: positiveFolds,
      unit: `of ${folds}`,
      threshold: Math.ceil(folds * 0.6),
      comparator: '>=',
    },
  ];

  const limitations = [
    'Fold windows are synthetic; real walk-forward requires connected price history.',
    'Does not model changing fee/liquidity conditions between folds.',
  ];

  if (degradationPct > 60) {
    return {
      type: 'WALK_FORWARD',
      result: 'FAIL',
      rule: 'OUT_OF_SAMPLE_COLLAPSE',
      finding: `Out-of-sample return degrades ${degradationPct}% versus in-sample (${inSample}% → ${outOfSample}%). This is the signature of a curve-fit rule, not an edge.`,
      metrics,
      limitations,
      citedObservationKeys: [],
    };
  }

  if (positiveFolds < Math.ceil(folds * 0.6)) {
    return {
      type: 'WALK_FORWARD',
      result: 'FAIL',
      rule: 'INCONSISTENT_ACROSS_FOLDS',
      finding: `Only ${positiveFolds} of ${folds} walk-forward windows were profitable. Consistency, not average return, is what survives contact with live capital.`,
      metrics,
      limitations,
      citedObservationKeys: [],
    };
  }

  return {
    type: 'WALK_FORWARD',
    result: 'PASS',
    rule: 'OUT_OF_SAMPLE_HOLDS',
    finding: `Out-of-sample return of ${outOfSample}% holds within ${degradationPct}% of in-sample across ${positiveFolds}/${folds} profitable windows.`,
    metrics,
    limitations,
    citedObservationKeys: [],
  };
}

// ---------------------------------------------------------------------------
// 3. Regime decomposition
// ---------------------------------------------------------------------------

const REGIMES = ['BULL_TREND', 'BEAR_TREND', 'CHOP', 'HIGH_VOL_SHOCK'] as const;

function regimeDecomposition(ctx: StrategyContext): TestOutput {
  const s = ctx.strategyKey;
  const perRegime = REGIMES.map((regime) => ({
    regime,
    returnPct: between(`${s}:regime:${regime}`, -35, 55),
  }));
  const profitable = perRegime.filter((r) => r.returnPct > 0);
  const worst = perRegime.reduce((a, b) => (b.returnPct < a.returnPct ? b : a));

  const metrics: Metric[] = [
    ...perRegime.map((r) => ({
      label: r.regime.replace(/_/g, ' '),
      value: r.returnPct,
      unit: '%',
    })),
    {
      label: 'Profitable regimes',
      value: profitable.length,
      unit: `of ${REGIMES.length}`,
      threshold: 2,
      comparator: '>=',
    },
  ];

  const limitations = [
    'Regime labels are synthetic; real decomposition requires a classified price history.',
    'Four coarse regimes cannot capture liquidity-driven regime shifts specific to a single pool.',
  ];

  if (profitable.length < 2) {
    return {
      type: 'REGIME_DECOMPOSITION',
      result: 'FAIL',
      rule: 'SINGLE_REGIME_ARTIFACT',
      finding: `Profitable in only ${profitable.length} of ${REGIMES.length} regimes. An edge that exists in one regime is a bet on that regime persisting, not a strategy.`,
      metrics,
      limitations,
      citedObservationKeys: [],
    };
  }

  if (worst.returnPct < -25) {
    return {
      type: 'REGIME_DECOMPOSITION',
      result: 'FAIL',
      rule: 'UNSURVIVABLE_REGIME_DRAWDOWN',
      finding: `Loses ${worst.returnPct}% in ${worst.regime.replace(/_/g, ' ')}. The strategy is profitable on average and ruinous in the regime it will eventually meet.`,
      metrics,
      limitations,
      citedObservationKeys: [],
    };
  }

  return {
    type: 'REGIME_DECOMPOSITION',
    result: 'PASS',
    rule: 'EDGE_PERSISTS_ACROSS_REGIMES',
    finding: `Profitable in ${profitable.length}/${REGIMES.length} regimes with worst-regime return of ${worst.returnPct}% in ${worst.regime.replace(/_/g, ' ')}.`,
    metrics,
    limitations,
    citedObservationKeys: [],
  };
}

// ---------------------------------------------------------------------------
// 4. Slippage on observed pool depth  (reads REAL observations)
// ---------------------------------------------------------------------------

function slippage(ctx: StrategyContext): TestOutput {
  const depth = ctx.byMetric.get('pool_depth_2pct_usd');
  const limitations = [
    'Depth is a point-in-time reading; it is not a guarantee of depth at exit.',
    'Assumes no competing exit into the same pool, which is the condition under which depth actually vanishes.',
  ];

  if (!depth || depth.value === undefined) {
    // No depth reading means the exit cost is UNKNOWN, not acceptable.
    return {
      type: 'SLIPPAGE_ON_REAL_DEPTH',
      result: 'INCONCLUSIVE',
      rule: 'NO_DEPTH_OBSERVATION',
      finding:
        'No pool-depth observation available for this subject. Exit cost cannot be established, so this test cannot pass. An unmeasured exit is not a cheap exit.',
      metrics: [{ label: 'Intended size', value: ctx.intendedSizeUsd, unit: 'USD' }],
      limitations,
      citedObservationKeys: [],
    };
  }

  const depthUsd = depth.value;
  // 2% depth is the notional that moves price 2%. Cost scales super-linearly
  // beyond it, which is exactly the region where paper P&L stops being real.
  const ratio = ctx.intendedSizeUsd / Math.max(depthUsd, 1);
  const estSlippagePct = round(2 * Math.pow(ratio, 1.5), 3);
  // Largest size clearing a 2% cost ceiling.
  const realizableUsd = Math.round(depthUsd);
  const ceilingPct = ctx.tier === 3 ? 3 : ctx.tier === 2 ? 2 : 1;

  const metrics: Metric[] = [
    { label: 'Observed 2% pool depth', value: depthUsd, unit: 'USD' },
    { label: 'Intended size', value: ctx.intendedSizeUsd, unit: 'USD' },
    {
      label: 'Estimated round-trip slippage',
      value: estSlippagePct,
      unit: '%',
      threshold: ceilingPct,
      comparator: '<=',
    },
    { label: 'Size clearing 2% cost', value: realizableUsd, unit: 'USD' },
  ];

  if (estSlippagePct > ceilingPct) {
    return {
      type: 'SLIPPAGE_ON_REAL_DEPTH',
      result: 'FAIL',
      rule: 'INTENDED_SIZE_EXCEEDS_REALIZABLE_DEPTH',
      finding: `At the observed 2% depth of $${depthUsd.toLocaleString()}, an intended $${ctx.intendedSizeUsd.toLocaleString()} position costs an estimated ${estSlippagePct}% round-trip against a Tier ${ctx.tier} ceiling of ${ceilingPct}%. The position is only profitable on paper, where it does not have to be filled.`,
      metrics,
      limitations,
      citedObservationKeys: [depth.observationKey],
    };
  }

  return {
    type: 'SLIPPAGE_ON_REAL_DEPTH',
    result: 'PASS',
    rule: 'SIZE_FITS_OBSERVED_DEPTH',
    finding: `Intended $${ctx.intendedSizeUsd.toLocaleString()} clears at an estimated ${estSlippagePct}% round-trip against observed depth of $${depthUsd.toLocaleString()} (Tier ${ctx.tier} ceiling ${ceilingPct}%).`,
    metrics,
    limitations,
    citedObservationKeys: [depth.observationKey],
  };
}

// ---------------------------------------------------------------------------
// 5. Wash-adjusted volume  (reads REAL observations)
// ---------------------------------------------------------------------------

function washAdjustedVolume(ctx: StrategyContext): TestOutput {
  const wash = ctx.byMetric.get('wash_trading_score_pct');
  const depth = ctx.byMetric.get('pool_depth_2pct_usd');
  const limitations = [
    'Wash score is an inferred estimate, not a proof of intent to launder volume.',
    'Genuine market-making can register as wash-like; this test is deliberately conservative.',
  ];

  if (!wash || wash.value === undefined) {
    return {
      type: 'WASH_ADJUSTED_VOLUME',
      result: 'INCONCLUSIVE',
      rule: 'NO_VOLUME_INTEGRITY_OBSERVATION',
      finding:
        'No wash-trading observation available. Reported volume cannot be discounted, so it cannot be relied on. Unverified volume is treated as unusable, not as clean.',
      metrics: [],
      limitations,
      citedObservationKeys: [],
    };
  }

  const washPct = wash.value;
  // Depth stands in for economically real turnover in the absence of a
  // connected volume feed; it is the more conservative of the two anyway.
  const reportedUsd = depth?.value ?? 0;
  const adjustedUsd = Math.round(reportedUsd * (1 - washPct / 100));
  const floorUsd = ctx.tier === 1 ? 250_000 : ctx.tier === 2 ? 50_000 : 8_000;
  const washCeiling = ctx.tier === 3 ? 55 : ctx.tier === 2 ? 40 : 25;

  const metrics: Metric[] = [
    {
      label: 'Wash-trading score',
      value: washPct,
      unit: '%',
      threshold: washCeiling,
      comparator: '<=',
    },
    { label: 'Reported turnover proxy', value: reportedUsd, unit: 'USD' },
    {
      label: 'Wash-adjusted turnover',
      value: adjustedUsd,
      unit: 'USD',
      threshold: floorUsd,
      comparator: '>=',
    },
  ];

  const cited = [wash.observationKey, ...(depth ? [depth.observationKey] : [])];

  if (washPct > washCeiling) {
    return {
      type: 'WASH_ADJUSTED_VOLUME',
      result: 'FAIL',
      rule: 'NON_ECONOMIC_VOLUME_DOMINATES',
      finding: `Wash-trading score of ${washPct}% exceeds the Tier ${ctx.tier} ceiling of ${washCeiling}%. The activity this strategy reads as interest is substantially not economic.`,
      metrics,
      limitations,
      citedObservationKeys: cited,
    };
  }

  if (adjustedUsd < floorUsd) {
    return {
      type: 'WASH_ADJUSTED_VOLUME',
      result: 'FAIL',
      rule: 'INSUFFICIENT_ECONOMIC_TURNOVER',
      finding: `Wash-adjusted turnover of $${adjustedUsd.toLocaleString()} is below the Tier ${ctx.tier} floor of $${floorUsd.toLocaleString()}. There is not enough real counterparty flow to support the position.`,
      metrics,
      limitations,
      citedObservationKeys: cited,
    };
  }

  return {
    type: 'WASH_ADJUSTED_VOLUME',
    result: 'PASS',
    rule: 'ECONOMIC_TURNOVER_SUFFICIENT',
    finding: `After discounting ${washPct}% wash activity, $${adjustedUsd.toLocaleString()} of economic turnover remains, above the Tier ${ctx.tier} floor of $${floorUsd.toLocaleString()}.`,
    metrics,
    limitations,
    citedObservationKeys: cited,
  };
}

// ---------------------------------------------------------------------------
// 6. Adversarial red team  (reads REAL observations)
// ---------------------------------------------------------------------------

function adversarialRedTeam(ctx: StrategyContext): TestOutput {
  const cited: string[] = [];
  const attacks: string[] = [];
  const metrics: Metric[] = [];

  const honeypot = ctx.byMetric.get('honeypot_risk_score');
  if (honeypot?.value !== undefined) {
    cited.push(honeypot.observationKey);
    metrics.push({
      label: 'Honeypot risk score',
      value: honeypot.value,
      unit: 'score',
      threshold: 55,
      comparator: '<=',
    });
    if (honeypot.value > 55) {
      attacks.push(
        `Sell-side may be unreachable: honeypot risk score ${honeypot.value}. Entry is not the risk; exit is.`
      );
    }
  }

  const devOut = ctx.byMetric.get('dev_wallet_outflow_pct_24h');
  if (devOut?.value !== undefined) {
    cited.push(devOut.observationKey);
    metrics.push({
      label: 'Dev wallet outflow 24h',
      value: devOut.value,
      unit: '%',
      threshold: 8,
      comparator: '<=',
    });
    if (devOut.value > 8) {
      attacks.push(
        `Insider distribution underway: ${devOut.value}% dev-wallet outflow in 24h. The strategy would be buying the exit liquidity of the people who know most.`
      );
    }
  }

  const lp = ctx.byMetric.get('lp_balance_change_pct_24h');
  if (lp?.value !== undefined) {
    cited.push(lp.observationKey);
    metrics.push({
      label: 'LP balance change 24h',
      value: lp.value,
      unit: '%',
      threshold: -15,
      comparator: '>=',
    });
    if (lp.value < -15 && ctx.liquidityLockStatus !== 'locked') {
      attacks.push(
        `LP is draining (${lp.value}% in 24h) with lock status "${ctx.liquidityLockStatus}". Rug mechanism is available and being exercised.`
      );
    }
  }

  if (ctx.regulatoryStatus === 'unclassified' && ctx.tier === 3) {
    attacks.push(
      'Tier 3 asset with unclassified regulatory status: a single classification event can strand the position with no compliant exit venue.'
    );
  }

  const limitations = [
    'Red team can only attack what has been observed; an unobserved failure mode is not an absent one.',
    'Attacks are rule-derived and do not include an adaptive adversary responding to QUORUM itself.',
  ];

  if (cited.length === 0) {
    return {
      type: 'ADVERSARIAL_RED_TEAM',
      result: 'INCONCLUSIVE',
      rule: 'NOTHING_TO_ATTACK',
      finding:
        'No security, flow or liquidity observations were available to attack. A red team with no evidence has not cleared the strategy — it has failed to examine it.',
      metrics,
      limitations,
      citedObservationKeys: [],
    };
  }

  if (attacks.length > 0) {
    return {
      type: 'ADVERSARIAL_RED_TEAM',
      result: 'FAIL',
      rule: 'SURVIVABLE_ATTACK_FOUND',
      finding: `${attacks.length} unrebutted attack(s): ${attacks.join(' ')}`,
      metrics,
      limitations,
      citedObservationKeys: cited,
    };
  }

  return {
    type: 'ADVERSARIAL_RED_TEAM',
    result: 'PASS',
    rule: 'NO_ATTACK_LANDED_ON_AVAILABLE_EVIDENCE',
    finding: `No landed attack across ${cited.length} observation(s) covering honeypot risk, insider outflow and LP behaviour.`,
    metrics,
    limitations,
    citedObservationKeys: cited,
  };
}

// ---------------------------------------------------------------------------

export function runAllTests(ctx: StrategyContext): TestOutput[] {
  return [
    backtest(ctx),
    walkForward(ctx),
    regimeDecomposition(ctx),
    slippage(ctx),
    washAdjustedVolume(ctx),
    adversarialRedTeam(ctx),
  ];
}

export type Verdict = {
  verdict: 'PASSED' | 'FAILED' | 'HELD';
  rule: string;
  rationale: string;
  decisiveTestType?: TestType;
};

/**
 * THE VERDICT RULE.
 *
 * Not a score. Tests are independently dispositive and evaluated in strict
 * precedence: any FAIL fails the batch, and only a clean sweep passes it.
 * INCONCLUSIVE holds — it can never be rounded up into a pass.
 */
export function verdictFor(tests: TestOutput[]): Verdict {
  const failed = tests.filter((t) => t.result === 'FAIL');
  if (failed.length > 0) {
    const decisive = failed[0];
    return {
      verdict: 'FAILED',
      rule: 'ANY_FAILED_TEST_FAILS_THE_STRATEGY',
      rationale: `${failed.length} of ${tests.length} tests failed. Tests are not averaged: ${decisive.type.replace(/_/g, ' ').toLowerCase()} failed under rule ${decisive.rule}, and no result from the other tests can offset it because they answer a different question.`,
      decisiveTestType: decisive.type,
    };
  }

  const inconclusive = tests.filter((t) => t.result === 'INCONCLUSIVE');
  if (inconclusive.length > 0) {
    return {
      verdict: 'HELD',
      rule: 'INCONCLUSIVE_IS_NOT_A_PASS',
      rationale: `${inconclusive.length} test(s) could not be established on the available evidence (${inconclusive.map((t) => t.type.replace(/_/g, ' ').toLowerCase()).join(', ')}). The strategy stays UNDER_TEST until the missing evidence exists. Absence of a failure is not a pass.`,
    };
  }

  return {
    verdict: 'PASSED',
    rule: 'ALL_TESTS_INDEPENDENTLY_PASSED',
    rationale: `All ${tests.length} tests passed on their own terms. PASSED means eligible for paper execution only — it is not authority to trade.`,
  };
}
