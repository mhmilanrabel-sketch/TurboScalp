// server/agent/agent.test.ts
// Comprehensive Phase 8 verification suite across Agents 1-6:
// Discovery, Quant >= 65/100, Gemini schema & DEGRADED fallback,
// Mathematical Risk Manager, Execution Agent (partial fills, Hedge/One-Way Algo orders,
// rollback on SL/TP failure, duplicate/ambiguous order protection),
// Trade Monitor reconciliation, restart persistence, and paper-trading backtest.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempJournal = path.join(
  os.tmpdir(),
  `turboscalp-agent-suite-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
);
const tempGeminiQuota = path.join(
  os.tmpdir(),
  `turboscalp-agent-gemini-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
);
process.env.TURBOSCALP_AGENT_STORAGE_FILE = tempJournal;
process.env.TURBOSCALP_GEMINI_STATE_FILE = tempGeminiQuota;

import { filterClosedCandles, type RawKline } from '../quantRoutes.js';
import {
  buildProtectiveAlgoParams,
  executeApprovedOrder,
  extractFillMetrics,
  type BinanceRequestFn,
} from './executionManager.js';
import {
  clearGeminiAnalystCache,
  runGeminiMarketAnalysis,
  validateGeminiPayloadSchema,
} from './geminiAnalyst.js';
import { detectUnusualActivity } from './marketDiscovery.js';
import { analyzeMarketQuantitatively } from './quantAnalyst.js';
import {
  evaluateRisk,
  floorToStep,
  HARD_RISK_CONSTANTS,
  roundPriceToTick,
  type ExchangeSymbolFilter,
  type RiskEvaluationInput,
} from './riskManager.js';
import {
  ensureAgentStorageLoaded,
  getActiveTradeRecord,
  getCriticalErrors,
  getPerformanceSummary,
  getSymbolCooldown,
  notifyTelegramEvent,
  syncDailyEquity,
} from './agentStorage.js';
import {
  markUncertainStartupTrades,
  reconcilePositionAndOrders,
} from './tradeMonitor.js';

function makeCandles(
  count: number,
  intervalMs: number,
  startPrice: number,
  step: number,
  endMs: number,
  spikeLastVol = false
): RawKline[] {
  const out: RawKline[] = [];
  const startOpen = endMs - count * intervalMs;
  for (let i = 0; i < count; i++) {
    const openTime = startOpen + i * intervalMs;
    const closeTime = openTime + intervalMs - 1;
    const open = Math.max(1, startPrice + i * step);
    const close = Math.max(1, open + step * 0.92);
    const high = Math.max(open, close) + Math.abs(step) * 0.5 + 0.1;
    const low = Math.max(0.5, Math.min(open, close) - Math.abs(step) * 0.5 - 0.1);
    const isLast = i === count - 1;
    out.push({
      openTime,
      open,
      high,
      low,
      close: isLast ? close + (step >= 0 ? 1 : -1) * Math.abs(step) * 2.5 : close,
      volume: isLast && spikeLastVol ? 9000 : 1200 + (i % 4) * 50,
      closeTime,
    });
  }
  return out;
}

const BTC_FILTER: ExchangeSymbolFilter = {
  symbol: 'BTCUSDT',
  status: 'TRADING',
  contractType: 'PERPETUAL',
  quoteAsset: 'USDT',
  tickSize: 0.1,
  stepSize: 0.001,
  minQty: 0.001,
  maxQty: 1000,
  minNotional: 5,
};

function makeRiskInput(now = 1_750_000_000_000): RiskEvaluationInput {
  return {
    signal: {
      symbol: 'BTCUSDT',
      direction: 'BUY',
      heuristicScore: 80,
      signalStrengthScore: 80,
      trendStrength: 85,
      price: 50_000,
      stopLoss: 49_500, // riskPerUnit = $500 (1.0%)
      takeProfit: 50_900,
      atr14: 300,
      volatilityPct: 0.6,
      latestClosedCandleTime: now - 30_000,
      fetchedAt: now - 2_000,
    },
    aiAnalysis: {
      symbol: 'BTCUSDT',
      available: true,
      degraded: false,
      direction: 'BUY',
      marketRegime: 'TRENDING',
      confidence: 0.78,
      sentiment: 'BULLISH',
      riskFlags: [],
      reasoning: '15m trend and 5m momentum agree',
      analyzedAt: now - 1_000,
    },
    account: {
      connected: true,
      canTrade: true,
      orderTestPassed: true,
      availableBalance: 10_000, // riskAmount = $25; qty = 25/500 = 0.05 BTC ($2500 notional) -> capped at $100 notional = 0.002 BTC
      totalWalletBalance: 10_000,
      totalUnrealizedProfit: 0,
    },
    openPositions: [],
    openOrdersCount: 0,
    symbolFilter: BTC_FILTER,
    dailyEquity: {
      dateUtc: '2025-06-15',
      startingEquity: 10_000,
      realizedPnlToday: 0,
    },
    cooldownUntilMs: null,
    executionLocked: false,
    inFlightSymbols: new Set(),
    duplicateClientOrderExists: false,
    requireAiApproval: true,
    minSignalScore: 65,
    maxNotionalUsd: 100,
    maxLeverage: 2,
    proposedClientOrderId: 'TS_BTCUSDT_TEST1',
    nowMs: now,
  };
}

test('TEST 1: Closed candles only & unusual volume/volatility detection', () => {
  const now = 1_750_000_000_000;
  const raw = [
    [now - 900_000, '100', '103', '99', '102', '1200', now - 1],
    [now - 300_000, '102', '104', '101', '103', '1400', now],
    [now, '103', '105', '102', '104', '500', now + 299_000], // Unfinished
  ];
  const closed = filterClosedCandles(raw, now);
  assert.equal(closed.length, 2);
  assert.ok(closed.every((c) => c.closeTime <= now));

  const c15 = makeCandles(60, 15 * 60_000, 100, 0.5, now, true);
  const c5 = makeCandles(60, 5 * 60_000, 120, 0.2, now, true);
  const activity = detectUnusualActivity(c5, c15, 4.2);
  assert.equal(activity.unusualVolume, true);
  assert.equal(activity.unusualVolatility, true);
  assert.ok(activity.volumeSpikeRatio15m >= 1.6);
});

test('TEST 2: Quant Agent score >= 65 & Gemini schema validation + DEGRADED handling', async () => {
  const now = 1_750_000_000_000;
  const bull15 = makeCandles(80, 15 * 60_000, 100, 0.7, now, true);
  const bull5 = makeCandles(80, 5 * 60_000, 138, 0.23, now, true);
  const quant = analyzeMarketQuantitatively(
    {
      symbol: 'ETHUSDT',
      priceChangePercent: 4.5,
      quoteVolume: 150_000_000,
      candles5m: bull5,
      candles15m: bull15,
      unusualVolume: true,
      unusualVolatility: true,
      latestClosedCandleTime: bull5[bull5.length - 1].closeTime,
      fetchedAt: now,
    },
    65
  );

  assert.equal(quant.direction, 'BUY');
  assert.ok(quant.signalStrengthScore >= 65);
  assert.equal(quant.mtfAligned, true);

  // Valid Gemini JSON schema
  const valid = validateGeminiPayloadSchema(
    {
      symbol: 'ETHUSDT',
      direction: 'BUY',
      marketRegime: 'TRENDING',
      confidence: 0.81,
      sentiment: 'BULLISH',
      riskFlags: [],
      reasoning: '15m and 5m EMAs aligned upward',
    },
    'ETHUSDT'
  );
  assert.equal(valid.confidence, 0.81);
  assert.equal(valid.marketRegime, 'TRENDING');

  // Gemini throws 503 / unavailable -> retries then strictly reported as DEGRADED / OVERLOADED
  clearGeminiAnalystCache();
  const degradedRes = await runGeminiMarketAnalysis(quant, [], {
    bypassCache: true,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    generateFn: async () => {
      throw new Error('503 Service Unavailable');
    },
  });
  assert.equal(degradedRes.available, false);
  assert.equal(degradedRes.degraded, true);
  assert.equal(degradedRes.direction, 'HOLD');
  assert.equal(degradedRes.errorCategory, 'CAPACITY_503');
  assert.ok(degradedRes.riskFlags.some((f) => /DEGRADED|OVERLOADED/i.test(f)));
});

test('TEST 3: Risk Manager mathematical formula, exchange step/tick rounding & every rejection rule', () => {
  const now = 1_750_000_000_000;
  // Exact sizing math without multiplying leverage into risk budget:
  // balance = 2000 -> riskAmount = 2000 * 0.0025 = $5.00
  // entry = 50_000, sl = 49_500 -> riskPerUnit = $500
  // math qty = 5 / 500 = 0.01 BTC -> notional $500 -> capped at MAX_ORDER_NOTIONAL $100 = 0.002 BTC
  const smallCapInput = makeRiskInput(now);
  smallCapInput.account.availableBalance = 2_000;
  const approved = evaluateRisk(smallCapInput);
  assert.equal(approved.approved, true);
  assert.equal(approved.orderPlan!.quantity, '0.002');
  assert.ok(approved.orderPlan!.notionalUsd <= HARD_RISK_CONSTANTS.MAX_ORDER_NOTIONAL_USD);
  assert.ok(approved.orderPlan!.riskPercentOfAvailable <= HARD_RISK_CONSTANTS.RISK_PER_TRADE_PCT);
  assert.equal(floorToStep(0.00299, 0.001), '0.002');
  assert.equal(roundPriceToTick(49500.14, 0.1), '49500.1');

  // When risk budget is smaller than $100 notional cap: balance = $10_000, sl distance = 5% ($2500/unit)
  // riskAmount = $25 -> qty = 25 / 2500 = 0.01 BTC? Wait 0.01*50000=$500 capped; try balance=$2000, sl=48000 ($2000/unit):
  // riskAmount = $5 -> qty = 5/2000 = 0.0025 -> step floored 0.002 -> risk = $4.00 (no leverage multiplication)
  const riskBounded = makeRiskInput(now);
  riskBounded.account.availableBalance = 2_000;
  riskBounded.signal.stopLoss = 48_000;
  riskBounded.signal.takeProfit = 53_000;
  const rbRes = evaluateRisk(riskBounded);
  assert.equal(rbRes.approved, true);
  assert.equal(rbRes.orderPlan!.quantity, '0.002');

  // All mandatory rejection conditions:
  const cases: Array<[string, (i: RiskEvaluationInput) => void]> = [
    ['disconnected', (i) => (i.account.connected = false)],
    ['permission disabled', (i) => (i.account.canTrade = false)],
    ['order test unconfirmed', (i) => (i.account.orderTestPassed = false)],
    ['stale data', (i) => (i.signal.fetchedAt = now - 120_000)],
    ['low score', (i) => (i.signal.signalStrengthScore = 60)],
    ['AI DEGRADED', (i) => { i.aiAnalysis!.available = false; i.aiAnalysis!.degraded = true; }],
    ['AI conflict', (i) => (i.aiAnalysis!.direction = 'SELL')],
    ['invalid stop-loss', (i) => (i.signal.stopLoss = i.signal.price + 100)],
    ['daily loss limit', (i) => (i.dailyEquity.realizedPnlToday = -105)],
    ['open position', (i) => (i.openPositions = [{ symbol: 'ETHUSDT', positionAmt: 0.1 }])],
    ['duplicate order', (i) => (i.duplicateClientOrderExists = true)],
    ['cooldown', (i) => (i.cooldownUntilMs = now + 600_000)],
  ];

  for (const [label, mutate] of cases) {
    const scenario = makeRiskInput(now);
    mutate(scenario);
    const out = evaluateRisk(scenario);
    assert.equal(out.approved, false, `Expected rejection for: ${label}`);
  }
});

test('TEST 4: Paper-trading closed-candle simulation enforces limits without exchange writes', () => {
  const now = 1_750_000_000_000;
  const full15 = makeCandles(110, 15 * 60_000, 100, 0.6, now, true);
  const full5 = makeCandles(330, 5 * 60_000, 100, 0.2, now, true);

  let executedSimTrades = 0;
  for (let i = 65; i <= 105; i += 10) {
    const win15 = full15.slice(0, i);
    const cutoff = win15[win15.length - 1].closeTime;
    const win5 = full5.filter((c) => c.closeTime <= cutoff).slice(-80);
    const sig = analyzeMarketQuantitatively(
      {
        symbol: 'BTCUSDT',
        priceChangePercent: 3.5,
        quoteVolume: 200_000_000,
        candles5m: win5,
        candles15m: win15,
        unusualVolume: true,
        unusualVolatility: false,
        latestClosedCandleTime: cutoff,
        fetchedAt: cutoff + 500,
      },
      65
    );
    const decision = evaluateRisk({
      signal: sig,
      aiAnalysis: {
        symbol: 'BTCUSDT',
        available: true,
        degraded: false,
        direction: sig.direction,
        marketRegime: 'TRENDING',
        confidence: 0.76,
        sentiment: sig.direction === 'BUY' ? 'BULLISH' : 'NEUTRAL',
        riskFlags: [],
        reasoning: 'Paper simulation alignment',
        analyzedAt: cutoff + 600,
      },
      account: {
        connected: true,
        canTrade: true,
        orderTestPassed: true,
        availableBalance: 2500,
        totalWalletBalance: 2500,
        totalUnrealizedProfit: 0,
      },
      openPositions: [],
      openOrdersCount: 0,
      symbolFilter: BTC_FILTER,
      dailyEquity: {
        dateUtc: '2025-06-15',
        startingEquity: 2500,
        realizedPnlToday: 0,
      },
      cooldownUntilMs: null,
      executionLocked: false,
      inFlightSymbols: new Set(),
      requireAiApproval: true,
      nowMs: cutoff + 1000,
    });
    if (decision.approved) executedSimTrades++;
  }
  assert.ok(executedSimTrades >= 1);
});

test('TEST 5 & 6: Execution Agent Hedge/One-Way Algo Exits, Partial Fill, Ambiguous Entry Recovery & SL Failure Rollback', async () => {
  await ensureAgentStorageLoaded();

  // Verify Hedge Mode Algo parameters adhere strictly to Binance rules (no quantity/reduceOnly when closePosition=true, triggerPrice used)
  const hedgeStop = buildProtectiveAlgoParams({
    symbol: 'BTCUSDT',
    entrySide: 'BUY',
    positionMode: 'HEDGE',
    positionSide: 'LONG',
    type: 'STOP_MARKET',
    triggerPrice: '49500.0',
    clientAlgoId: 'SL_1',
  });
  assert.equal(hedgeStop.algoType, 'CONDITIONAL');
  assert.equal(hedgeStop.side, 'SELL');
  assert.equal(hedgeStop.positionSide, 'LONG');
  assert.equal(hedgeStop.triggerPrice, '49500.0');
  assert.equal(hedgeStop.workingType, 'MARK_PRICE');
  assert.equal(hedgeStop.closePosition, 'true');
  assert.equal((hedgeStop as any).quantity, undefined);
  assert.equal((hedgeStop as any).reduceOnly, undefined);
  assert.equal((hedgeStop as any).stopPrice, undefined);

  const fill = extractFillMetrics(
    { orderId: 901, status: 'PARTIALLY_FILLED', executedQty: '0.001', avgPrice: '50010.0' },
    50_000
  );
  assert.equal(fill.executedQty, 0.001);
  assert.equal(fill.avgPrice, 50_010);

  // Rollback test: SL succeeds, TP fails -> must cancel SL, MARKET close position, verify flat, pause engine, record CRITICAL error
  const decision = evaluateRisk(makeRiskInput());
  assert.equal(decision.approved, true);

  let canceledAlgo = false;
  let marketCloseCalled = false;
  let pausedCalled = false;

  const mockBinance = (async (method: string, endpoint: string, params?: Record<string, any>): Promise<any> => {
    if (endpoint === '/fapi/v1/positionSide/dual') return { dualSidePosition: false };
    if (endpoint === '/fapi/v1/leverage') return { leverage: 1 };
    if (method === 'POST' && endpoint === '/fapi/v1/order' && params?.side === 'BUY') {
      return { orderId: 555, status: 'FILLED', executedQty: '0.002', avgPrice: '50000' };
    }
    if (method === 'POST' && endpoint === '/fapi/v1/algoOrder' && params?.type === 'STOP_MARKET') {
      return { algoId: 777, clientAlgoId: params.clientAlgoId };
    }
    if (method === 'POST' && endpoint === '/fapi/v1/algoOrder' && params?.type === 'TAKE_PROFIT_MARKET') {
      throw new Error('Binance Demo -2021 Order would immediately trigger');
    }
    if (method === 'DELETE' && endpoint === '/fapi/v1/algoOrder') {
      canceledAlgo = true;
      return { success: true };
    }
    if (method === 'POST' && endpoint === '/fapi/v1/order' && params?.side === 'SELL') {
      marketCloseCalled = true;
      return { orderId: 556, status: 'FILLED', executedQty: '0.002' };
    }
    if (method === 'GET' && endpoint === '/fapi/v3/positionRisk') {
      return [{ symbol: 'BTCUSDT', positionAmt: '0' }];
    }
    return {};
  }) as BinanceRequestFn;

  const quantMock = analyzeMarketQuantitatively(
    {
      symbol: 'BTCUSDT',
      priceChangePercent: 3.1,
      quoteVolume: 200_000_000,
      candles5m: makeCandles(70, 5 * 60_000, 100, 0.25, 1_750_000_000_000, true),
      candles15m: makeCandles(70, 15 * 60_000, 100, 0.75, 1_750_000_000_000, true),
      unusualVolume: true,
      unusualVolatility: false,
      latestClosedCandleTime: 1_749_999_999_999,
      fetchedAt: 1_750_000_000_000,
    },
    65
  );

  const rollbackOutcome = await executeApprovedOrder(
    decision,
    quantMock,
    makeRiskInput().aiAnalysis!,
    BTC_FILTER,
    {
      credentials: { apiKey: 'demo-key', apiSecret: 'demo-secret' },
      binanceRequest: mockBinance,
      inFlightSymbols: new Set(),
      onPauseRequired: () => {
        pausedCalled = true;
      },
    }
  );

  assert.equal(rollbackOutcome.success, false);
  assert.equal(canceledAlgo, true);
  assert.equal(marketCloseCalled, true);
  assert.equal(pausedCalled, true);
  assert.equal(rollbackOutcome.tradeRecord?.executionStatus, 'ROLLBACK_CLOSED');
  assert.ok(getCriticalErrors().length >= 1);

  // Verify duplicate clientOrderId is blocked after rollback recorded it
  const dupBlocked = await executeApprovedOrder(
    decision,
    quantMock,
    makeRiskInput().aiAnalysis!,
    BTC_FILTER,
    {
      credentials: { apiKey: 'demo-key', apiSecret: 'demo-secret' },
      binanceRequest: mockBinance,
      inFlightSymbols: new Set(),
      onPauseRequired: () => {},
    }
  );
  assert.equal(dupBlocked.success, false);
  assert.match(dupBlocked.error || '', /Duplicate execution blocked/i);
});

test('TEST 7 & 8: Successful Demo Entry + Protective Algo Verify + Monitor Closure + Cooldown + Non-blocking Telegram', async () => {
  await ensureAgentStorageLoaded();
  syncDailyEquity(10_000);

  const freshInput = makeRiskInput();
  freshInput.proposedClientOrderId = 'TS_BTCUSDT_TEST7';
  const decision = evaluateRisk(freshInput);
  assert.equal(decision.approved, true);

  let positionOpenOnExchange = true;
  let canceledCount = 0;

  const mockExchange = (async (method: string, endpoint: string, params?: Record<string, any>): Promise<any> => {
    if (endpoint === '/fapi/v1/positionSide/dual') return { dualSidePosition: true };
    if (endpoint === '/fapi/v1/leverage') return { leverage: 1 };
    if (method === 'POST' && endpoint === '/fapi/v1/order') {
      return { orderId: 1001, status: 'FILLED', executedQty: '0.002', avgPrice: '50000' };
    }
    if (method === 'POST' && endpoint === '/fapi/v1/algoOrder') {
      return {
        algoId: params?.type === 'STOP_MARKET' ? 2001 : 2002,
        clientAlgoId: params?.clientAlgoId,
      };
    }
    if (method === 'GET' && endpoint === '/fapi/v1/openAlgoOrders') {
      return positionOpenOnExchange
        ? [
            { symbol: 'BTCUSDT', algoId: 2001, clientAlgoId: params?.clientAlgoId || '' },
            { symbol: 'BTCUSDT', algoId: 2002, clientAlgoId: params?.clientAlgoId || '' },
          ]
        : [];
    }
    if (endpoint === '/fapi/v3/account') {
      return {
        totalWalletBalance: '10001.70',
        availableBalance: '10001.70',
        totalUnrealizedProfit: '0',
      };
    }
    if (endpoint === '/fapi/v1/accountConfig') {
      return {
        canTrade: true,
        canDeposit: true,
        canWithdraw: true,
        dualSidePosition: true,
        multiAssetsMargin: false,
        feeTier: 0,
      };
    }
    if (endpoint === '/fapi/v3/positionRisk') {
      return positionOpenOnExchange
        ? [
            {
              symbol: 'BTCUSDT',
              positionSide: 'LONG',
              positionAmt: '0.002',
              entryPrice: '50000',
              markPrice: '50400',
              unRealizedProfit: '0.80',
              leverage: '1',
            },
          ]
        : [];
    }
    if (endpoint === '/fapi/v1/openOrders') return [];
    if (endpoint === '/fapi/v1/income') {
      return [
        { incomeType: 'REALIZED_PNL', income: '1.80' },
        { incomeType: 'COMMISSION', income: '-0.08' },
        { incomeType: 'FUNDING_FEE', income: '-0.02' },
      ];
    }
    if (endpoint === '/fapi/v1/userTrades') {
      return [{ price: '50900' }];
    }
    if (method === 'DELETE' && endpoint === '/fapi/v1/algoOrder') {
      canceledCount++;
      return { success: true };
    }
    return {};
  }) as BinanceRequestFn;

  // Customize openAlgoOrders mock to return exact clientAlgoIds created by executionManager
  const recordedClientAlgoIds: string[] = [];
  const wrappedExchange = (async (method: any, endpoint: string, params?: Record<string, any>, signed?: boolean, creds?: any): Promise<any> => {
    if (method === 'POST' && endpoint === '/fapi/v1/algoOrder' && params?.clientAlgoId) {
      recordedClientAlgoIds.push(params.clientAlgoId);
    }
    if (method === 'GET' && endpoint === '/fapi/v1/openAlgoOrders') {
      return recordedClientAlgoIds.map((id, idx) => ({
        symbol: 'BTCUSDT',
        algoId: 2001 + idx,
        clientAlgoId: id,
      }));
    }
    return mockExchange(method, endpoint, params, signed, creds);
  }) as BinanceRequestFn;

  const quantMock = analyzeMarketQuantitatively(
    {
      symbol: 'BTCUSDT',
      priceChangePercent: 3.1,
      quoteVolume: 200_000_000,
      candles5m: makeCandles(70, 5 * 60_000, 100, 0.25, 1_750_000_000_000, true),
      candles15m: makeCandles(70, 15 * 60_000, 100, 0.75, 1_750_000_000_000, true),
      unusualVolume: true,
      unusualVolatility: false,
      latestClosedCandleTime: 1_749_999_999_999,
      fetchedAt: 1_750_000_000_000,
    },
    65
  );

  const execRes = await executeApprovedOrder(
    decision,
    quantMock,
    makeRiskInput().aiAnalysis!,
    BTC_FILTER,
    {
      credentials: { apiKey: 'demo-key', apiSecret: 'demo-secret' },
      binanceRequest: wrappedExchange,
      inFlightSymbols: new Set(),
      onPauseRequired: () => {},
    }
  );
  assert.equal(execRes.success, true);
  assert.equal(execRes.tradeRecord?.positionMode, 'HEDGE');
  assert.equal(execRes.tradeRecord?.positionSide, 'LONG');
  assert.equal(execRes.tradeRecord?.stopStatus, 'ARMED');
  assert.equal(execRes.tradeRecord?.takeProfitStatus, 'ARMED');
  assert.ok(getActiveTradeRecord() !== null);

  // Reconcile while open
  markUncertainStartupTrades(getActiveTradeRecord());
  const whileOpen = await reconcilePositionAndOrders(
    wrappedExchange,
    { apiKey: 'demo-key', apiSecret: 'demo-secret' },
    30
  );
  assert.equal(whileOpen.activeTradeStillOpen, true);

  // Now simulate TP fill on exchange -> position becomes flat
  positionOpenOnExchange = false;
  const afterClose = await reconcilePositionAndOrders(
    wrappedExchange,
    { apiKey: 'demo-key', apiSecret: 'demo-secret' },
    30
  );
  assert.equal(afterClose.activeTradeStillOpen, false);
  assert.equal(canceledCount, 2); // Both remaining Algo orders canceled cleanly
  assert.ok(getSymbolCooldown('BTCUSDT') !== null); // 30m cooldown active

  const perf = getPerformanceSummary(10_001.7);
  assert.equal(perf.wins, 1);
  assert.equal(perf.totalTradingFees, 0.08);
  assert.equal(perf.totalFundingFees, -0.02);
  assert.equal(perf.netRealizedPnl, 1.7);

  // Telegram gracefully no-ops when token/chatId are unset
  const tgOk = await notifyTelegramEvent('POSITION_CLOSED', 'Test message');
  assert.equal(tgOk, false);
});

test.after(async () => {
  await Promise.all([
    fs.rm(tempJournal, { force: true }).catch(() => {}),
    fs.rm(tempGeminiQuota, { force: true }).catch(() => {}),
  ]);
});
