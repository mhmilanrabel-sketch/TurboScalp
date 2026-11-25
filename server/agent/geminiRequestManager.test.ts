// server/agent/geminiRequestManager.test.ts
// Complete unit tests for Gemini 503 auto-recovery, retry policy, circuit breaker,
// verified model failover, 429 non-bypass, error taxonomy, 5-key cache, concurrency lock,
// RECHECK AI manual probe, persistence across restart, and Risk Manager GEMINI_REQUIRED veto.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const tempQuotaFile = path.join(
  os.tmpdir(),
  `turboscalp-gemini-503-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
);
process.env.TURBOSCALP_GEMINI_STATE_FILE = tempQuotaFile;

import type { QuantAnalysisResult } from './quantAnalyst.js';
import {
  analyzeQualifiedCandidatesBatch,
  runGeminiMarketAnalysis,
} from './geminiAnalyst.js';
import {
  classifyGeminiError,
  ensureGeminiManagerLoaded,
  GEMINI_CIRCUIT_COOLDOWNS_MS,
  GEMINI_DEFAULT_PRIMARY_MODEL,
  GEMINI_MAX_DAILY_REQUESTS,
  GEMINI_QUOTA_EXHAUSTED_BANNER,
  getGeminiQuotaStatus,
  parseDurationToMs,
  recheckGeminiAvailability,
  resetGeminiRequestManagerForTests,
} from './geminiRequestManager.js';
import { evaluateRisk, type ExchangeSymbolFilter } from './riskManager.js';

function makeQuant(
  symbol: string,
  direction: 'BUY' | 'SELL' | 'HOLD',
  candleTime: number,
  score = 78
): QuantAnalysisResult {
  const price = symbol === 'BTCUSDT' ? 60000 : symbol === 'ETHUSDT' ? 3000 : 150;
  return {
    symbol,
    direction,
    heuristicScore: direction === 'SELL' ? -score : direction === 'BUY' ? score : 12,
    signalStrengthScore: direction === 'HOLD' ? 12 : score,
    minScoreRequired: 65,
    price,
    change24h: 3.2,
    quoteVolume: 180_000_000,
    ema9_15m: price * 0.995,
    ema21_15m: price * 0.99,
    ema50_15m: price * 0.98,
    ema9_5m: price * 0.997,
    ema21_5m: price * 0.994,
    ema50_5m: price * 0.99,
    rsi14: direction === 'SELL' ? 38 : 61,
    rsi5m: direction === 'SELL' ? 35 : 63,
    macd: 1.5,
    macdSignal: 1.0,
    macdHistogram: direction === 'SELL' ? -0.5 : 0.5,
    atr14: price * 0.008,
    volatilityPct: 0.8,
    volumeRatio: 2.1,
    trendStrength: 82,
    supportLevel: price * 0.985,
    resistanceLevel: price * 1.015,
    breakout:
      direction === 'BUY'
        ? 'BULLISH_BREAKOUT'
        : direction === 'SELL'
          ? 'BEARISH_BREAKOUT'
          : 'NONE',
    mtfAligned: true,
    marketStructure: direction === 'SELL' ? 'DOWNTREND_LH_LL' : 'UPTREND_HH_HL',
    unusualVolume: true,
    unusualVolatility: false,
    stopLoss: direction === 'SELL' ? price * 1.01 : price * 0.99,
    takeProfit: direction === 'SELL' ? price * 0.98 : price * 1.02,
    reasons: ['MTF EMA alignment', 'Closed-candle volume expansion'],
    latestClosedCandleTime: candleTime,
    fetchedAt: candleTime + 500,
  };
}

const SAMPLE_FILTER: ExchangeSymbolFilter = {
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

function make503Error(msg = '503 UNAVAILABLE: This model is currently experiencing high demand.'): Error & { status: number } {
  const err: any = new Error(msg);
  err.status = 503;
  return err;
}

test('1. Initial state is STANDBY (never ACTIVE before actual response) & primary success sets ACTIVE', async () => {
  delete process.env.GEMINI_PRIMARY_MODEL;
  delete process.env.GEMINI_FALLBACK_MODEL;
  await resetGeminiRequestManagerForTests({ clearDisk: true });
  await ensureGeminiManagerLoaded();

  const initial = getGeminiQuotaStatus();
  assert.equal(initial.status, 'STANDBY');
  assert.equal(initial.primaryModel, GEMINI_DEFAULT_PRIMARY_MODEL);
  assert.equal(initial.primaryStatus, 'STANDBY');
  assert.equal(initial.fallbackModel, null);
  assert.equal(initial.fallbackStatus, 'DISABLED');
  assert.equal(initial.lastSuccessfulAnalysisAt, null);

  const candleTime = Date.now() - 10_000;
  const btc = makeQuant('BTCUSDT', 'BUY', candleTime, 84);
  const eth = makeQuant('ETHUSDT', 'BUY', candleTime, 80);
  const sol = makeQuant('SOLUSDT', 'SELL', candleTime, 76);
  const holdCoin = makeQuant('DOGEUSDT', 'HOLD', candleTime, 15);

  let generatorCalls = 0;
  let capturedModel = '';
  let capturedBatchLen = 0;

  const outcome = await analyzeQualifiedCandidatesBatch([btc, eth, sol, holdCoin], {
    minIntervalMs: 0,
    batchGenerateFn: async ({ model, candidates }) => {
      generatorCalls++;
      capturedModel = model;
      capturedBatchLen = candidates.length;
      return {
        analyses: candidates.map((c: any) => ({
          symbol: c.symbol,
          direction: c.quantProposedDirection,
          marketRegime: 'TRENDING',
          confidence: 0.82,
          sentiment: c.quantProposedDirection === 'BUY' ? 'BULLISH' : 'BEARISH',
          riskFlags: [],
          reasoning: `Verified closed candle alignment for ${c.symbol}.`,
        })),
      };
    },
  });

  assert.equal(generatorCalls, 1);
  assert.equal(capturedModel, GEMINI_DEFAULT_PRIMARY_MODEL);
  assert.equal(capturedBatchLen, 3);
  assert.equal(outcome.resultsBySymbol.get('BTCUSDT')?.modelUsed, GEMINI_DEFAULT_PRIMARY_MODEL);
  assert.equal(outcome.resultsBySymbol.get('BTCUSDT')?.usedFallback, false);
  assert.equal(outcome.quotaStatus.status, 'ACTIVE');
  assert.equal(outcome.quotaStatus.primaryStatus, 'ACTIVE');
  assert.ok(outcome.quotaStatus.lastSuccessfulAnalysisAt !== null);
});

test('2. Primary model 503 x3 opens circuit breaker (OVERLOADED), persists cooldown & blocks flood', async () => {
  delete process.env.GEMINI_FALLBACK_MODEL;
  await resetGeminiRequestManagerForTests({ clearDisk: true });

  const now = 1_750_000_000_000;
  const btc1 = makeQuant('BTCUSDT', 'BUY', now - 15_000, 82);
  const btc2 = makeQuant('BTCUSDT', 'BUY', now - 5_000, 84);

  let attempts = 0;
  const res1 = await analyzeQualifiedCandidatesBatch([btc1], {
    nowMs: now,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    batchGenerateFn: async () => {
      attempts++;
      throw make503Error();
    },
  });

  // 1 initial + 2 retries = 3 total attempts
  assert.equal(attempts, 3);
  assert.equal(res1.quotaStatus.primaryStatus, 'OVERLOADED');
  assert.equal(res1.quotaStatus.status, 'DEGRADED'); // No fallback configured -> overall DEGRADED
  assert.equal(res1.quotaStatus.consecutive503Cycles, 1);
  assert.equal(res1.quotaStatus.primaryCircuitOpenUntil, now + GEMINI_CIRCUIT_COOLDOWNS_MS[0]);
  assert.equal(res1.quotaStatus.lastErrorCategory, 'CAPACITY_503');
  assert.equal(res1.resultsBySymbol.get('BTCUSDT')?.available, false);

  // Subsequent scan within 5m cooldown must NOT dispatch primary requests
  const res2 = await analyzeQualifiedCandidatesBatch([btc2], {
    nowMs: now + 60_000,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    batchGenerateFn: async () => {
      attempts++;
      throw make503Error();
    },
  });
  assert.equal(attempts, 3);
  assert.equal(res2.requestsDispatched, 0);

  // Restart persistence keeps circuit open & cycle count intact
  await resetGeminiRequestManagerForTests({ clearDisk: false });
  await ensureGeminiManagerLoaded();
  const reloaded = getGeminiQuotaStatus(now + 120_000);
  assert.equal(reloaded.primaryStatus, 'OVERLOADED');
  assert.equal(reloaded.consecutive503Cycles, 1);
  assert.equal(reloaded.primaryCircuitOpenUntil, now + GEMINI_CIRCUIT_COOLDOWNS_MS[0]);
});

test('3. Primary succeeds on 3rd attempt after two 503 retries -> ACTIVE', async () => {
  delete process.env.GEMINI_FALLBACK_MODEL;
  await resetGeminiRequestManagerForTests({ clearDisk: true });

  const now = Date.now();
  const eth = makeQuant('ETHUSDT', 'BUY', now - 10_000, 81);
  let calls = 0;

  const outcome = await analyzeQualifiedCandidatesBatch([eth], {
    nowMs: now,
    retryDelaysMs: [2, 2],
    jitterFn: () => 0,
    minIntervalMs: 0,
    batchGenerateFn: async () => {
      calls++;
      if (calls < 3) throw make503Error();
      return {
        analyses: [
          {
            symbol: 'ETHUSDT',
            direction: 'BUY',
            marketRegime: 'TRENDING',
            confidence: 0.79,
            sentiment: 'BULLISH',
            riskFlags: [],
            reasoning: 'Recovered on retry attempt 3.',
          },
        ],
      };
    },
  });

  assert.equal(calls, 3);
  assert.equal(outcome.quotaStatus.status, 'ACTIVE');
  assert.equal(outcome.quotaStatus.primaryStatus, 'ACTIVE');
  assert.equal(outcome.quotaStatus.consecutive503Cycles, 0);
  assert.equal(outcome.resultsBySymbol.get('ETHUSDT')?.available, true);
  assert.equal(outcome.resultsBySymbol.get('ETHUSDT')?.modelUsed, GEMINI_DEFAULT_PRIMARY_MODEL);
});

test('4. Primary fails 503 and verified fallback succeeds -> FALLBACK_ACTIVE with true modelUsed attribution', async () => {
  process.env.GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash';
  await resetGeminiRequestManagerForTests({ clearDisk: true });

  const now = 1_750_000_000_000;
  const btc = makeQuant('BTCUSDT', 'BUY', now - 10_000, 86);
  const calledModels: string[] = [];

  const outcome = await analyzeQualifiedCandidatesBatch([btc], {
    nowMs: now,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    verifyFallbackModelFn: async (m) => ({
      supported: m === 'gemini-2.5-flash',
    }),
    batchGenerateFn: async ({ model }) => {
      calledModels.push(model);
      if (model === GEMINI_DEFAULT_PRIMARY_MODEL) {
        throw make503Error();
      }
      return {
        analyses: [
          {
            symbol: 'BTCUSDT',
            direction: 'BUY',
            marketRegime: 'TRENDING',
            confidence: 0.84,
            sentiment: 'BULLISH',
            riskFlags: [],
            reasoning: 'Fallback model verified setup cleanly.',
          },
        ],
      };
    },
  });

  assert.deepEqual(calledModels, [
    GEMINI_DEFAULT_PRIMARY_MODEL,
    GEMINI_DEFAULT_PRIMARY_MODEL,
    GEMINI_DEFAULT_PRIMARY_MODEL,
    'gemini-2.5-flash',
  ]);
  const res = outcome.resultsBySymbol.get('BTCUSDT')!;
  assert.equal(res.available, true);
  assert.equal(res.usedFallback, true);
  assert.equal(res.modelUsed, 'gemini-2.5-flash');
  assert.equal(outcome.quotaStatus.status, 'FALLBACK_ACTIVE');
  assert.equal(outcome.quotaStatus.primaryStatus, 'OVERLOADED');
  assert.equal(outcome.quotaStatus.fallbackStatus, 'ACTIVE');
  assert.equal(outcome.quotaStatus.fallbackActive, true);
  assert.equal(outcome.quotaStatus.lastRespondedModel, 'gemini-2.5-flash');

  // Next candle during cooldown routes directly to fallback without retrying overloaded primary
  const btcNext = makeQuant('BTCUSDT', 'BUY', now + 60_000, 85);
  const outcome2 = await analyzeQualifiedCandidatesBatch([btcNext], {
    nowMs: now + 60_000,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    verifyFallbackModelFn: async () => ({ supported: true }),
    batchGenerateFn: async ({ model }) => {
      calledModels.push(model);
      return {
        analyses: [
          {
            symbol: 'BTCUSDT',
            direction: 'BUY',
            marketRegime: 'TRENDING',
            confidence: 0.81,
            sentiment: 'BULLISH',
            riskFlags: [],
            reasoning: 'Fallback reused while circuit open.',
          },
        ],
      };
    },
  });
  assert.equal(calledModels[calledModels.length - 1], 'gemini-2.5-flash');
  assert.equal(calledModels.length, 5); // Strictly 1 new dispatch to fallback
  assert.equal(outcome2.quotaStatus.status, 'FALLBACK_ACTIVE');

  delete process.env.GEMINI_FALLBACK_MODEL;
});

test('5. Unverified or failing fallback (both 503) -> DEGRADED, while Risk Manager allows QUANT_ONLY paper testing & blocks GEMINI_REQUIRED Demo entry', async () => {
  process.env.GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash';
  await resetGeminiRequestManagerForTests({ clearDisk: true });

  const now = 1_750_000_000_000;
  const btc = makeQuant('BTCUSDT', 'BUY', now - 10_000, 86);

  const outcome = await analyzeQualifiedCandidatesBatch([btc], {
    nowMs: now,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    verifyFallbackModelFn: async () => ({ supported: true }),
    batchGenerateFn: async () => {
      throw make503Error();
    },
  });

  assert.equal(outcome.quotaStatus.status, 'DEGRADED');
  assert.equal(outcome.quotaStatus.primaryStatus, 'OVERLOADED');
  assert.equal(outcome.quotaStatus.fallbackStatus, 'DEGRADED');
  assert.equal(outcome.quotaStatus.fallbackActive, false);

  const failedAi = outcome.resultsBySymbol.get('BTCUSDT')!;
  assert.equal(failedAi.available, false);

  // Automated Demo entry blocked under GEMINI_REQUIRED = true
  const demoGate = evaluateRisk({
    signal: btc,
    aiAnalysis: failedAi,
    account: {
      connected: true,
      canTrade: true,
      accountConfigCanTrade: true,
      orderTestPassed: true,
      availableBalance: 5000,
      totalWalletBalance: 5000,
      totalUnrealizedProfit: 0,
    },
    openPositions: [],
    openOrdersCount: 0,
    symbolFilter: SAMPLE_FILTER,
    dailyEquity: { dateUtc: '2025-06-15', startingEquity: 5000, realizedPnlToday: 0 },
    cooldownUntilMs: null,
    executionLocked: false,
    inFlightSymbols: new Set(),
    requireAiApproval: true,
    nowMs: now,
  });
  assert.equal(demoGate.approved, false);
  assert.ok(demoGate.reasons.some((r) => /503|OVERLOADED|DEGRADED/i.test(r)));

  // Mathematical Quant & Paper testing remains operational
  const paperGate = evaluateRisk({
    signal: btc,
    aiAnalysis: null,
    account: {
      connected: true,
      canTrade: true,
      accountConfigCanTrade: true,
      orderTestPassed: true,
      availableBalance: 5000,
      totalWalletBalance: 5000,
      totalUnrealizedProfit: 0,
    },
    openPositions: [],
    openOrdersCount: 0,
    symbolFilter: SAMPLE_FILTER,
    dailyEquity: { dateUtc: '2025-06-15', startingEquity: 5000, realizedPnlToday: 0 },
    cooldownUntilMs: null,
    executionLocked: false,
    inFlightSymbols: new Set(),
    requireAiApproval: false,
    nowMs: now,
  });
  assert.equal(paperGate.approved, true);

  delete process.env.GEMINI_FALLBACK_MODEL;
});

test('6. 429 RESOURCE_EXHAUSTED sets QUOTA_EXHAUSTED and NEVER bypasses via fallback model', async () => {
  process.env.GEMINI_FALLBACK_MODEL = 'gemini-2.5-flash';
  await resetGeminiRequestManagerForTests({ clearDisk: true });

  const now = 1_750_000_000_000;
  const eth = makeQuant('ETHUSDT', 'BUY', now - 10_000, 82);
  const calledModels: string[] = [];

  const res = await analyzeQualifiedCandidatesBatch([eth], {
    nowMs: now,
    minIntervalMs: 0,
    verifyFallbackModelFn: async () => ({ supported: true }),
    batchGenerateFn: async ({ model }) => {
      calledModels.push(model);
      const err: any = new Error(
        '429 RESOURCE_EXHAUSTED GenerateRequestsPerDayPerModel-FreeTier retryDelay="3600s"'
      );
      err.status = 429;
      throw err;
    },
  });

  // Only primary called once; NO retries and NO fallback bypass
  assert.deepEqual(calledModels, [GEMINI_DEFAULT_PRIMARY_MODEL]);
  assert.equal(res.quotaStatus.status, 'QUOTA_EXHAUSTED');
  assert.equal(res.quotaStatus.quotaMessage, GEMINI_QUOTA_EXHAUSTED_BANNER);
  assert.equal(res.quotaStatus.fallbackActive, false);

  // RECHECK AI must also respect 429 daily block without calling any model
  const rechecked = await recheckGeminiAvailability([], {
    nowMs: now + 10_000,
    minIntervalMs: 0,
    batchGenerateFn: async ({ model }) => {
      calledModels.push(model);
      return { analyses: [] };
    },
  });
  assert.equal(calledModels.length, 1);
  assert.equal(rechecked.status, 'QUOTA_EXHAUSTED');

  delete process.env.GEMINI_FALLBACK_MODEL;
});

test('7. Error taxonomy classifies 429, 503, 504, 400, 401/403 distinctly without treating them as 503', async () => {
  const now = 1_750_000_000_000;
  assert.equal(parseDurationToMs('42s'), 42_000);
  assert.equal(parseDurationToMs('14h20m15s'), (14 * 3600 + 20 * 60 + 15) * 1000);

  const c503 = classifyGeminiError(make503Error(), now);
  assert.equal(c503.category, 'CAPACITY_503');
  assert.equal(c503.kind, 'MODEL_OVERLOADED_503');

  const c504 = classifyGeminiError({ status: 504, message: '504 DEADLINE_EXCEEDED' }, now);
  assert.equal(c504.category, 'TIMEOUT_504');
  assert.equal(c504.kind, 'DEADLINE_TIMEOUT_504');

  const c400 = classifyGeminiError({ status: 400, message: '400 INVALID_ARGUMENT bad schema' }, now);
  assert.equal(c400.category, 'INVALID_ARGUMENT_400');
  assert.equal(c400.kind, 'INVALID_ARGUMENT_400');

  const c401 = classifyGeminiError({ status: 401, message: '401 UNAUTHENTICATED invalid API key' }, now);
  assert.equal(c401.category, 'AUTH_401_403');
  assert.equal(c401.kind, 'AUTH_ERROR_401_403');

  const c429Rpm = classifyGeminiError(
    { status: 429, message: '429 RESOURCE_EXHAUSTED RequestsPerMinute retryDelay="12s"' },
    now
  );
  assert.equal(c429Rpm.category, 'RATE_LIMIT_429');
  assert.equal(c429Rpm.kind, 'RATE_LIMIT_TRANSIENT');

  // Verify 400 INVALID_ARGUMENT is NOT retried 3 times like 503
  await resetGeminiRequestManagerForTests({ clearDisk: true });
  let attempts400 = 0;
  const outcome400 = await analyzeQualifiedCandidatesBatch(
    [makeQuant('SOLUSDT', 'SELL', now - 5_000, 79)],
    {
      nowMs: now,
      minIntervalMs: 0,
      batchGenerateFn: async () => {
        attempts400++;
        const e: any = new Error('400 INVALID_ARGUMENT');
        e.status = 400;
        throw e;
      },
    }
  );
  assert.equal(attempts400, 1);
  assert.equal(outcome400.quotaStatus.lastErrorCategory, 'INVALID_ARGUMENT_400');
  assert.equal(outcome400.quotaStatus.status, 'DEGRADED');
});

test('8. Circuit breaker escalates 5m -> 10m -> 20m -> 30m max & recovers via single RECOVERING probe -> ACTIVE', async () => {
  delete process.env.GEMINI_FALLBACK_MODEL;
  await resetGeminiRequestManagerForTests({ clearDisk: true });

  const t0 = 1_750_000_000_000;
  const btc1 = makeQuant('BTCUSDT', 'BUY', t0 - 10_000, 82);

  // Cycle 1: 5m cooldown
  await analyzeQualifiedCandidatesBatch([btc1], {
    nowMs: t0,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    batchGenerateFn: async () => {
      throw make503Error();
    },
  });
  let snap = getGeminiQuotaStatus(t0 + 1_000);
  assert.equal(snap.primaryCircuitOpenUntil, t0 + GEMINI_CIRCUIT_COOLDOWNS_MS[0]); // +5m

  // After 5m expires -> state transitions cleanly to RECOVERING
  const t1 = t0 + GEMINI_CIRCUIT_COOLDOWNS_MS[0] + 1_000;
  snap = getGeminiQuotaStatus(t1);
  assert.equal(snap.primaryStatus, 'RECOVERING');
  assert.equal(snap.status, 'RECOVERING');

  // Cycle 2 recovery probe (strictly 1 attempt, fails 503) -> escalates to +10m
  let cycle2Attempts = 0;
  const btc2 = makeQuant('BTCUSDT', 'BUY', t1 - 5_000, 83);
  await analyzeQualifiedCandidatesBatch([btc2], {
    nowMs: t1,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    batchGenerateFn: async () => {
      cycle2Attempts++;
      throw make503Error();
    },
  });
  assert.equal(cycle2Attempts, 1);
  snap = getGeminiQuotaStatus(t1 + 100);
  assert.equal(snap.primaryCircuitOpenUntil, t1 + GEMINI_CIRCUIT_COOLDOWNS_MS[1]); // +10m

  // Cycle 3 recovery probe fails -> +20m
  const t2 = t1 + GEMINI_CIRCUIT_COOLDOWNS_MS[1] + 1_000;
  await analyzeQualifiedCandidatesBatch([makeQuant('BTCUSDT', 'BUY', t2 - 5_000, 83)], {
    nowMs: t2,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    batchGenerateFn: async () => {
      throw make503Error();
    },
  });
  snap = getGeminiQuotaStatus(t2 + 100);
  assert.equal(snap.primaryCircuitOpenUntil, t2 + GEMINI_CIRCUIT_COOLDOWNS_MS[2]); // +20m

  // Cycle 4 & 5 fail -> capped at 30m max
  const t3 = t2 + GEMINI_CIRCUIT_COOLDOWNS_MS[2] + 1_000;
  await analyzeQualifiedCandidatesBatch([makeQuant('BTCUSDT', 'BUY', t3 - 5_000, 83)], {
    nowMs: t3,
    retryDelaysMs: [1, 1],
    jitterFn: () => 0,
    minIntervalMs: 0,
    batchGenerateFn: async () => {
      throw make503Error();
    },
  });
  snap = getGeminiQuotaStatus(t3 + 100);
  assert.equal(snap.primaryCircuitOpenUntil, t3 + GEMINI_CIRCUIT_COOLDOWNS_MS[3]); // +30m cap

  // Finally, RECHECK AI manual probe succeeds -> primaryStatus ACTIVE, circuit reset!
  const t4 = t3 + 5_000;
  const recovered = await recheckGeminiAvailability([], {
    nowMs: t4,
    minIntervalMs: 0,
    batchGenerateFn: async () => ({
      analyses: [
        {
          symbol: 'BTCUSDT',
          direction: 'HOLD',
          marketRegime: 'SIDEWAYS',
          confidence: 0.72,
          sentiment: 'NEUTRAL',
          riskFlags: [],
          reasoning: 'Primary healthy again.',
        },
      ],
    }),
  });
  assert.equal(recovered.status, 'ACTIVE');
  assert.equal(recovered.primaryStatus, 'ACTIVE');
  assert.equal(recovered.primaryCircuitOpenUntil, null);
  assert.equal(recovered.consecutive503Cycles, 0);
  assert.equal(recovered.cachedAnalysesCount, 0); // Synthetic probe did not pollute candle cache
});

test('9. Concurrent duplicate request lock & 5-key cache reuse work together', async () => {
  await resetGeminiRequestManagerForTests({ clearDisk: true });
  const candleTime = Date.now() - 10_000;
  const btc = makeQuant('BTCUSDT', 'BUY', candleTime, 85);

  let dispatchCount = 0;
  const gen = async () => {
    dispatchCount++;
    await new Promise((r) => setTimeout(r, 30));
    return {
      symbol: 'BTCUSDT',
      direction: 'BUY',
      marketRegime: 'TRENDING',
      confidence: 0.85,
      sentiment: 'BULLISH',
      riskFlags: [],
      reasoning: 'Single in-flight deduplicated analysis.',
    };
  };

  const [r1, r2, r3] = await Promise.all([
    runGeminiMarketAnalysis(btc, [], { generateFn: gen, minIntervalMs: 0 }),
    runGeminiMarketAnalysis(btc, [], { generateFn: gen, minIntervalMs: 0 }),
    runGeminiMarketAnalysis(btc, [], { generateFn: gen, minIntervalMs: 0 }),
  ]);

  assert.equal(dispatchCount, 1);
  assert.equal(r1.direction, 'BUY');
  assert.equal(r2.direction, 'BUY');
  assert.equal(r3.direction, 'BUY');
  assert.equal(getGeminiQuotaStatus().requestsUsedToday, 1);

  // Subsequent call for identical (symbol, candleTime, modelId, promptVersion, featureVersion) hits cache
  const r4 = await runGeminiMarketAnalysis(btc, [], { generateFn: gen, minIntervalMs: 0 });
  assert.equal(dispatchCount, 1);
  assert.equal(r4.fromCache, true);
});

test.after(async () => {
  delete process.env.GEMINI_PRIMARY_MODEL;
  delete process.env.GEMINI_FALLBACK_MODEL;
  await fs.rm(tempQuotaFile, { force: true }).catch(() => {});
});
