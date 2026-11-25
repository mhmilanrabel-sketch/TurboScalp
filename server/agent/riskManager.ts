// server/agent/riskManager.ts
// Agent 4 – Mathematical Risk Manager (Final Trade Approval Authority)
// Enforces hard capital preservation rules and mathematical stop-distance sizing:
//   riskAmount = availableBalance * (RISK_PER_TRADE_PCT / 100)
//   riskPerUnit = abs(entryPrice - stopLoss)
//   quantity = riskAmount / riskPerUnit
// Leverage is NEVER multiplied into the risk budget.

import type { GeminiAnalysisResult } from './geminiAnalyst.js';

export const HARD_RISK_CONSTANTS = Object.freeze({
  RISK_PER_TRADE_PCT: 0.25,
  MAX_LEVERAGE: 2,
  MAX_OPEN_POSITIONS: 1,
  MAX_ORDER_NOTIONAL_USD: 100,
  MAX_DAILY_LOSS_PCT: 1.0,
  MIN_SIGNAL_SCORE: 65,
  COOLDOWN_MINUTES: 30,
  MAX_CANDLE_AGE_MS: 20 * 60_000,
  MAX_TICKER_AGE_MS: 90_000,
  MIN_STOP_DISTANCE_PCT: 0.0015,
  MAX_STOP_DISTANCE_PCT: 0.06,
  MIN_AI_CONFIDENCE: 0.55,
  MIN_FALLBACK_NOTIONAL_USD: 5,
});

export interface ExchangeSymbolFilter {
  symbol: string;
  status: string;
  contractType: string;
  quoteAsset: string;
  tickSize: number;
  stepSize: number;
  minQty: number;
  maxQty: number;
  minNotional: number;
}

export interface QuantCandidateInput {
  symbol: string;
  direction: 'BUY' | 'SELL' | 'HOLD';
  heuristicScore: number;
  signalStrengthScore: number;
  trendStrength: number;
  price: number;
  stopLoss: number | null;
  takeProfit: number | null;
  atr14: number;
  volatilityPct: number;
  latestClosedCandleTime: number;
  fetchedAt: number;
}

export interface AccountSnapshotInput {
  connected: boolean;
  canTrade: boolean;
  accountCanTrade?: boolean | null;
  accountConfigCanTrade?: boolean | null;
  orderTestPassed?: boolean;
  orderTestMessage?: string;
  availableBalance: number;
  totalWalletBalance: number;
  totalUnrealizedProfit: number;
}

export interface DailyEquitySnapshot {
  dateUtc: string;
  startingEquity: number;
  realizedPnlToday: number;
}

export interface RiskCheckItem {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ApprovedOrderPlan {
  symbol: string;
  side: 'BUY' | 'SELL';
  leverage: number;
  quantity: string;
  numericQuantity: number;
  notionalUsd: number;
  requiredMarginUsd: number;
  riskAmountUsd: number;
  riskPerUnit: number;
  riskPercentOfAvailable: number;
  stopDistancePct: number;
  entryPrice: number;
  stopPrice: string;
  takeProfitPrice: string;
  clientOrderId: string;
}

export interface RiskDecision {
  symbol: string;
  approved: boolean;
  reasons: string[];
  checks: RiskCheckItem[];
  orderPlan: ApprovedOrderPlan | null;
  dailyLossTriggered: boolean;
  evaluatedAt: number;
}

export interface RiskEvaluationInput {
  signal: QuantCandidateInput;
  aiAnalysis: GeminiAnalysisResult | null;
  account: AccountSnapshotInput;
  openPositions: Array<{ symbol: string; positionAmt: number }>;
  openOrdersCount: number;
  symbolFilter: ExchangeSymbolFilter | null;
  dailyEquity: DailyEquitySnapshot;
  cooldownUntilMs: number | null;
  executionLocked: boolean;
  inFlightSymbols: Set<string>;
  duplicateClientOrderExists?: boolean;
  requireAiApproval: boolean;
  minSignalScore?: number;
  maxNotionalUsd?: number;
  maxLeverage?: number;
  proposedClientOrderId?: string;
  nowMs?: number;
}

export function decimalPrecisionFromStep(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const text = step.toString().toLowerCase();
  if (text.includes('e-')) {
    const exp = Number(text.split('e-')[1]);
    return Number.isFinite(exp) ? Math.min(12, Math.max(0, exp)) : 0;
  }
  const dot = text.indexOf('.');
  if (dot < 0) return 0;
  return text.slice(dot + 1).replace(/0+$/, '').length;
}

export function floorToStep(value: number, stepSize: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (!Number.isFinite(stepSize) || stepSize <= 0) return String(value);
  const precision = decimalPrecisionFromStep(stepSize);
  const steps = Math.floor(value / stepSize + 1e-10);
  return (steps * stepSize).toFixed(precision);
}

export function roundPriceToTick(price: number, tickSize: number): string {
  if (!Number.isFinite(price) || price <= 0) return '0';
  if (!Number.isFinite(tickSize) || tickSize <= 0) return price.toFixed(4);
  const precision = decimalPrecisionFromStep(tickSize);
  const ticks = Math.round(price / tickSize);
  return (ticks * tickSize).toFixed(precision);
}

export function evaluateRisk(input: RiskEvaluationInput): RiskDecision {
  const now = input.nowMs ?? Date.now();
  const checks: RiskCheckItem[] = [];
  const reasons: string[] = [];

  const minScore = Math.max(
    50,
    input.minSignalScore ?? HARD_RISK_CONSTANTS.MIN_SIGNAL_SCORE
  );
  const maxNotional = Math.min(
    HARD_RISK_CONSTANTS.MAX_ORDER_NOTIONAL_USD,
    Math.max(5, input.maxNotionalUsd ?? HARD_RISK_CONSTANTS.MAX_ORDER_NOTIONAL_USD)
  );
  const maxLeverage = Math.min(
    HARD_RISK_CONSTANTS.MAX_LEVERAGE,
    Math.max(1, Math.trunc(input.maxLeverage ?? HARD_RISK_CONSTANTS.MAX_LEVERAGE))
  );

  const record = (name: string, passed: boolean, detail: string) => {
    checks.push({ name, passed, detail });
    if (!passed) reasons.push(detail);
  };

  // 1. Directional & minimum signal score check (65/100)
  const validDirection =
    input.signal.direction === 'BUY' || input.signal.direction === 'SELL';
  const scoreOk =
    validDirection && input.signal.signalStrengthScore >= minScore;
  record(
    'Signal Threshold',
    scoreOk,
    !validDirection
      ? `Quant Analyst returned HOLD for ${input.signal.symbol}; no directional entry.`
      : scoreOk
        ? `${input.signal.direction} ${input.signal.symbol} score ${input.signal.signalStrengthScore}/100 >= ${minScore}.`
        : `Signal score ${input.signal.signalStrengthScore}/100 is below minimum ${minScore}/100.`
  );

  // 2. Binance Demo API connected, authoritative /fapi/v1/accountConfig canTrade=true, AND order test passed
  const accountConfigCanTrade =
    input.account.accountConfigCanTrade !== undefined
      ? input.account.accountConfigCanTrade
      : input.account.canTrade;
  const accountPermsEnabled =
    input.account.canTrade === true && accountConfigCanTrade === true;
  const orderTestConfirmed = input.account.orderTestPassed === true;
  const apiReady =
    input.account.connected &&
    accountPermsEnabled &&
    orderTestConfirmed &&
    Number.isFinite(input.account.availableBalance) &&
    input.account.availableBalance > 0;
  record(
    'API & Permission',
    apiReady,
    !input.account.connected
      ? 'Binance Demo API session is disconnected.'
      : accountConfigCanTrade === null
        ? 'FUTURES ACCOUNT TRADING PERMISSION: UNKNOWN.'
        : !accountPermsEnabled
          ? 'ACCOUNT TRADING DISABLED.'
          : !orderTestConfirmed
            ? input.account.orderTestMessage
              ? `POST /fapi/v1/order/test failed: ${input.account.orderTestMessage}`
              : 'POST /fapi/v1/order/test not verified.'
            : input.account.availableBalance <= 0
              ? 'Available Binance Demo USDT balance is zero.'
              : `Demo API & /fapi/v1/accountConfig permission confirmed ($${input.account.availableBalance.toFixed(2)} available).`
  );

  // 3. Stale market data check
  const fetchAgeMs = now - input.signal.fetchedAt;
  const candleAgeMs = now - input.signal.latestClosedCandleTime;
  const freshData =
    Number.isFinite(fetchAgeMs) &&
    fetchAgeMs >= 0 &&
    fetchAgeMs <= HARD_RISK_CONSTANTS.MAX_TICKER_AGE_MS &&
    Number.isFinite(candleAgeMs) &&
    candleAgeMs >= 0 &&
    candleAgeMs <= HARD_RISK_CONSTANTS.MAX_CANDLE_AGE_MS;
  record(
    'Market Freshness',
    freshData,
    freshData
      ? `Closed candle and market snapshot verified (${Math.round(fetchAgeMs / 1000)}s old).`
      : `Market data is stale (fetchAge=${Math.round(fetchAgeMs / 1000)}s, candleAge=${Math.round(candleAgeMs / 1000)}s).`
  );

  // 4. Duplicate execution / lock check
  const noDuplicate =
    !input.executionLocked &&
    !input.inFlightSymbols.has(input.signal.symbol) &&
    !input.duplicateClientOrderExists;
  record(
    'Duplicate Prevention',
    noDuplicate,
    noDuplicate
      ? 'Execution lock clear and unique clientOrderId verified.'
      : `Duplicate execution blocked (${input.signal.symbol} locked, in flight, or duplicate clientOrderId).`
  );

  // 5. Exposure / max open positions (1) & open orders check
  const activePositions = input.openPositions.filter(
    (p) => Math.abs(Number(p.positionAmt)) > 1e-12
  );
  const exposureOk =
    activePositions.length < HARD_RISK_CONSTANTS.MAX_OPEN_POSITIONS &&
    input.openOrdersCount === 0;
  record(
    'Exposure Limit',
    exposureOk,
    activePositions.length >= HARD_RISK_CONSTANTS.MAX_OPEN_POSITIONS
      ? `Existing open position exposure blocks new trade (max ${HARD_RISK_CONSTANTS.MAX_OPEN_POSITIONS}).`
      : input.openOrdersCount > 0
        ? `Rejected because ${input.openOrdersCount} open/conditional order(s) remain on exchange.`
        : 'Exchange exposure clear (0 open positions, 0 pending orders).'
  );

  // 6. Cooldown check (30 min default)
  const cooldownClear = !input.cooldownUntilMs || now >= input.cooldownUntilMs;
  record(
    'Symbol Cooldown',
    cooldownClear,
    cooldownClear
      ? `No active cooldown on ${input.signal.symbol}.`
      : `${input.signal.symbol} is in cooldown (${Math.ceil((input.cooldownUntilMs! - now) / 60_000)}m remaining).`
  );

  // 7. Daily loss circuit breaker (1% of daily starting equity)
  const startingEquity = input.dailyEquity.startingEquity;
  const currentEquity =
    startingEquity +
    input.dailyEquity.realizedPnlToday +
    (Number.isFinite(input.account.totalUnrealizedProfit)
      ? input.account.totalUnrealizedProfit
      : 0);
  const dailyDrawdownPct =
    startingEquity > 0
      ? ((startingEquity - currentEquity) / startingEquity) * 100
      : 0;
  const dailyLossTriggered =
    startingEquity > 0 &&
    dailyDrawdownPct >= HARD_RISK_CONSTANTS.MAX_DAILY_LOSS_PCT;
  record(
    'Daily Loss Limit',
    !dailyLossTriggered,
    !dailyLossTriggered
      ? `Daily equity change: ${dailyDrawdownPct <= 0 ? '+' : '-'}${Math.abs(dailyDrawdownPct).toFixed(2)}% (limit -${HARD_RISK_CONSTANTS.MAX_DAILY_LOSS_PCT.toFixed(1)}%).`
      : `Daily loss limit (${HARD_RISK_CONSTANTS.MAX_DAILY_LOSS_PCT.toFixed(1)}%) reached at -${dailyDrawdownPct.toFixed(2)}%.`
  );

  // 8. Gemini AI validation & conflict check
  if (input.requireAiApproval) {
    const ai = input.aiAnalysis;
    const hasCriticalFlag = Boolean(
      ai?.riskFlags?.some((f) => f.toUpperCase().includes('CRITICAL'))
    );
    const aiOk = Boolean(
      ai &&
        ai.available &&
        !ai.degraded &&
        ai.direction === input.signal.direction &&
        ai.confidence >= HARD_RISK_CONSTANTS.MIN_AI_CONFIDENCE &&
        !hasCriticalFlag
    );

    let aiDetail = ai?.usedFallback
      ? `Gemini Fallback (${ai.modelUsed || 'fallback'}) aligned with technical direction.`
      : 'Gemini AI Analyst aligned with technical direction.';
    if (!ai || !ai.available || ai.degraded || ai.quotaExhausted) {
      if (ai?.quotaExhausted || ai?.errorCategory === 'QUOTA_429') {
        aiDetail =
          'Gemini daily quota exhausted — AI-dependent automated entries are paused.';
      } else if (ai?.errorCategory === 'CAPACITY_503') {
        aiDetail = `AI Analyst OVERLOADED (503 UNAVAILABLE): ${ai.error || 'Model experiencing high demand — automated entries blocked.'}`;
      } else if (ai?.error) {
        aiDetail = `AI Analyst DEGRADED${ai.errorCategory && ai.errorCategory !== 'NONE' ? ` (${ai.errorCategory})` : ''}: ${ai.error}`;
      } else {
        aiDetail =
          'AI Analyst is unavailable or DEGRADED while AI approval is required.';
      }
    } else if (ai.direction !== input.signal.direction) {
      aiDetail = `Technical (${input.signal.direction}) and AI (${ai.direction} · ${ai.marketRegime}) directions conflict.`;
    } else if (ai.confidence < HARD_RISK_CONSTANTS.MIN_AI_CONFIDENCE) {
      aiDetail = `AI confidence ${ai.confidence.toFixed(2)} is below minimum ${HARD_RISK_CONSTANTS.MIN_AI_CONFIDENCE.toFixed(2)}.`;
    } else if (hasCriticalFlag) {
      aiDetail = `AI Analyst flagged critical market risk: ${ai.riskFlags.join(', ')}.`;
    }
    record('Gemini AI Alignment', aiOk, aiDetail);
  }

  // 9. Exchange symbol rules & stop-loss validity
  const filter = input.symbolFilter;
  const marketActive = Boolean(
    filter &&
      filter.status === 'TRADING' &&
      filter.contractType === 'PERPETUAL' &&
      filter.quoteAsset === 'USDT'
  );
  record(
    'Exchange Filters',
    marketActive,
    marketActive
      ? `${input.signal.symbol} USDT Perpetual (step=${filter!.stepSize}, tick=${filter!.tickSize}).`
      : `Missing active USDT Perpetual filters for ${input.signal.symbol}.`
  );

  const entryPrice = input.signal.price;
  const rawSl = input.signal.stopLoss ?? 0;
  const rawTp = input.signal.takeProfit ?? 0;

  const geometryValid =
    entryPrice > 0 &&
    rawSl > 0 &&
    rawTp > 0 &&
    ((input.signal.direction === 'BUY' && rawSl < entryPrice && rawTp > entryPrice) ||
      (input.signal.direction === 'SELL' && rawSl > entryPrice && rawTp < entryPrice));

  const riskPerUnit = geometryValid ? Math.abs(entryPrice - rawSl) : 0;
  const stopDistancePct = entryPrice > 0 ? riskPerUnit / entryPrice : 0;
  const stopValid =
    geometryValid &&
    riskPerUnit > 0 &&
    stopDistancePct >= HARD_RISK_CONSTANTS.MIN_STOP_DISTANCE_PCT &&
    stopDistancePct <= HARD_RISK_CONSTANTS.MAX_STOP_DISTANCE_PCT;

  record(
    'Stop-Loss Geometry',
    stopValid,
    !geometryValid
      ? 'Stop-loss or take-profit price geometry is invalid.'
      : stopValid
        ? `Stop distance ${(stopDistancePct * 100).toFixed(2)}% valid ($${riskPerUnit.toPrecision(4)}/unit).`
        : `Stop distance ${(stopDistancePct * 100).toFixed(2)}% outside [${(HARD_RISK_CONSTANTS.MIN_STOP_DISTANCE_PCT * 100).toFixed(2)}%, ${(HARD_RISK_CONSTANTS.MAX_STOP_DISTANCE_PCT * 100).toFixed(1)}%].`
  );

  // 10. Mathematical Position Sizing (NEVER multiply leverage into risk budget)
  let orderPlan: ApprovedOrderPlan | null = null;
  if (marketActive && filter && stopValid && input.account.availableBalance > 0) {
    // Formula: riskAmount = availableBalance * 0.0025; quantity = riskAmount / riskPerUnit
    const riskAmount =
      input.account.availableBalance * (HARD_RISK_CONSTANTS.RISK_PER_TRADE_PCT / 100);
    const riskSizedQty = riskAmount / riskPerUnit;
    const maxNotionalQty = maxNotional / entryPrice;
    const maxMarginQty =
      (input.account.availableBalance * maxLeverage * 0.95) / entryPrice;

    const rawQty = Math.min(riskSizedQty, maxNotionalQty, maxMarginQty);
    const quantityStr = floorToStep(rawQty, filter.stepSize);
    const numericQuantity = Number(quantityStr);
    const notionalUsd = numericQuantity * entryPrice;
    const minRequiredNotional = Math.max(
      filter.minNotional || 0,
      HARD_RISK_CONSTANTS.MIN_FALLBACK_NOTIONAL_USD
    );
    const actualRiskUsd = numericQuantity * riskPerUnit;

    // Pick lowest leverage needed (1x if margin fits, otherwise max 2x)
    const leverage =
      notionalUsd <= input.account.availableBalance * 0.9
        ? 1
        : Math.min(2, maxLeverage);
    const requiredMarginUsd = notionalUsd / leverage;

    const sizingValid =
      Number.isFinite(numericQuantity) &&
      numericQuantity >= filter.minQty &&
      numericQuantity <= filter.maxQty &&
      notionalUsd >= minRequiredNotional &&
      notionalUsd <= maxNotional + 0.25 &&
      requiredMarginUsd <= input.account.availableBalance * 0.98 &&
      actualRiskUsd <= riskAmount * 1.02;

    record(
      'Mathematical Sizing',
      sizingValid,
      sizingValid
        ? `qty=${quantityStr} ${input.signal.symbol} ($${notionalUsd.toFixed(2)} @ ${leverage}x, risk=$${actualRiskUsd.toFixed(2)} <= $${riskAmount.toFixed(2)}).`
        : `Exchange limits failed: qty=${quantityStr} (minQty=${filter.minQty}), notional=$${notionalUsd.toFixed(2)} (min=$${minRequiredNotional}, max=$${maxNotional}).`
    );

    if (sizingValid && reasons.length === 0) {
      const clientOrderId =
        input.proposedClientOrderId ||
        `TS_${input.signal.symbol.slice(0, 8)}_${Date.now().toString(36)}`;
      orderPlan = {
        symbol: input.signal.symbol,
        side: input.signal.direction as 'BUY' | 'SELL',
        leverage,
        quantity: quantityStr,
        numericQuantity,
        notionalUsd: Number(notionalUsd.toFixed(4)),
        requiredMarginUsd: Number(requiredMarginUsd.toFixed(4)),
        riskAmountUsd: Number(actualRiskUsd.toFixed(4)),
        riskPerUnit: Number(riskPerUnit.toFixed(6)),
        riskPercentOfAvailable: Number(
          ((actualRiskUsd / input.account.availableBalance) * 100).toFixed(4)
        ),
        stopDistancePct: Number((stopDistancePct * 100).toFixed(4)),
        entryPrice,
        stopPrice: roundPriceToTick(rawSl, filter.tickSize),
        takeProfitPrice: roundPriceToTick(rawTp, filter.tickSize),
        clientOrderId,
      };
    }
  } else {
    record(
      'Mathematical Sizing',
      false,
      'Skipped mathematical sizing because prerequisite checks failed.'
    );
  }

  const approved = checks.every((c) => c.passed) && orderPlan !== null;
  if (approved && orderPlan) {
    reasons.push(
      `APPROVED: ${orderPlan.side} ${orderPlan.symbol} qty=${orderPlan.quantity} ($${orderPlan.notionalUsd.toFixed(2)} @ ${orderPlan.leverage}x, max risk $${orderPlan.riskAmountUsd.toFixed(2)}).`
    );
  }

  return {
    symbol: input.signal.symbol,
    approved,
    reasons,
    checks,
    orderPlan,
    dailyLossTriggered,
    evaluatedAt: now,
  };
}
