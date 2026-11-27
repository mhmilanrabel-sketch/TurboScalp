// server/agent/agentEngine.ts
// Orchestrator for the 6-Agent Autonomous Binance USD-M Futures DEMO Engine
// Owns the single-instance backend scheduler, concurrency locks, startup recovery,
// and REST API endpoints (/api/agent/*).
// Automatic trading is DISABLED after every restart and requires explicit Demo confirmation.

import type { Express, Request, Response } from 'express';
import {
  appendAgentLog,
  ensureAgentStorageLoaded,
  getActiveTradeRecord,
  getAgentConfig,
  getCriticalErrors,
  getDailyEquityState,
  getLastTradeAt,
  getLearningSamples,
  getPerformanceSummary,
  getRecentLogs,
  getRecentTrades,
  getSymbolCooldown,
  getTodayRealizedPnl,
  hasClientOrderId,
  notifyTelegramEvent,
  setLastProcessedCandle,
  updateAgentConfig,
  type AgentEngineConfig,
  type AgentHealthState,
  type AgentName,
  type AgentUnitStatus,
} from './agentStorage.js';
import {
  executeApprovedOrder,
  type BinanceRequestFn,
  type DemoCredentials,
} from './executionManager.js';
import {
  analyzeQualifiedCandidatesBatch,
  ensureGeminiManagerLoaded,
  getGeminiQuotaStatus,
  recheckGeminiAvailability,
  setGeminiAwaitingCandidatesCount,
  type GeminiAnalysisResult,
  type GeminiQuotaStatusSnapshot,
} from './geminiAnalyst.js';
import {
  discoverTopLiquidMarkets,
  type DiscoveryScanProgress,
} from './marketDiscovery.js';
import {
  analyzeMarketQuantitatively,
  type QuantAnalysisResult,
} from './quantAnalyst.js';
import {
  evaluateRisk,
  HARD_RISK_CONSTANTS,
  type ExchangeSymbolFilter,
  type RiskDecision,
} from './riskManager.js';
import {
  markUncertainStartupTrades,
  reconcilePositionAndOrders,
  type ExchangePositionSnapshot,
} from './tradeMonitor.js';
import {
  runNonExecutingPermissionDiagnostic,
  type FuturesPermissionDiagnostics,
} from '../permissionDiagnostics.js';

export type EngineRunMode = 'STOPPED' | 'SCAN_ONLY' | 'AUTO_TRADING' | 'PAUSED';

export interface OpportunitySnapshot {
  symbol: string;
  quant: QuantAnalysisResult;
  aiAnalysis: GeminiAnalysisResult | null;
  riskDecision: RiskDecision | null;
}

export interface AgentEngineDependencies {
  getCredentials: (req: Request, required?: boolean) => DemoCredentials | null;
  binanceRequest: BinanceRequestFn;
  validateMutationOrigin?: (req: Request) => boolean;
}

const BACKEND_LOOP_MS = 5_000;
const SCAN_COOLDOWN_MS = 25_000;

let deps: AgentEngineDependencies | null = null;
let mode: EngineRunMode = 'STOPPED';
let autoTradingEnabled = false;
let demoExplicitlyConfirmed = false;
let activeCredentials: DemoCredentials | null = null;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let cycleBusy = false;
let startBusy = false;
const inFlightSymbols = new Set<string>();

let lastScanAt: number | null = null;
let lastErrorMessage = '';
let latestCandidates: QuantAnalysisResult[] = [];
let bestBuyOpportunity: OpportunitySnapshot | null = null;
let bestSellOpportunity: OpportunitySnapshot | null = null;
let lastAiAnalysis: { symbol: string; result: GeminiAnalysisResult } | null = null;
let lastRiskDecision: RiskDecision | null = null;
let latestExchangePositions: ExchangePositionSnapshot[] = [];
let latestOpenOrdersCount = 0;
let sessionPermissionDiagnostics: FuturesPermissionDiagnostics | null = null;
let lastLoggedQuotaErrorKey = '';

export function updateSessionPermissionDiagnostics(
  diag: FuturesPermissionDiagnostics | null
): void {
  sessionPermissionDiagnostics = diag;
  if (diag && !diag.tradingConfirmed && mode === 'AUTO_TRADING') {
    autoTradingEnabled = false;
    mode = 'PAUSED';
    setAgentStatus(
      'execution',
      'PAUSED',
      `Auto-trading paused: ${diag.classificationMessage}`
    );
  }
}

let scanProgress: DiscoveryScanProgress = {
  scanning: false,
  totalTargets: 20,
  completedTargets: 0,
  unusualMoversCount: 0,
  stageLabel: 'Idle — press START SCANNER to discover top 20 USDT perpetuals',
};

const agentStatuses: Record<AgentName, AgentUnitStatus> = {
  discovery: {
    id: 'discovery',
    label: '1. Market Discovery',
    role: 'Scans top 20 liquid USD-M USDT pairs on closed 5m & 15m candles',
    status: 'IDLE',
    lastRunAt: null,
    detail: 'Waiting for scanner start',
  },
  quant: {
    id: 'quant',
    label: '2. Quant Analyst',
    role: 'EMA 9/21/50, RSI 14, MACD, ATR 14, S/R breakouts & MTF score (>= 65)',
    status: 'IDLE',
    lastRunAt: null,
    detail: 'Waiting for market data',
  },
  aiAnalyst: {
    id: 'aiAnalyst',
    label: '3. Gemini AI Analyst',
    role: 'Regime & sentiment validation via structured JSON (DEGRADED if down)',
    status: 'IDLE',
    lastRunAt: null,
    detail: 'Waiting for top candidate setup',
  },
  riskManager: {
    id: 'riskManager',
    label: '4. Risk Manager',
    role: '0.25% risk sizing, 2x max lev, $100 max notional, 1% daily loss cap',
    status: 'IDLE',
    lastRunAt: null,
    detail: 'Final veto authority active',
  },
  execution: {
    id: 'execution',
    label: '5. Execution Agent',
    role: 'Binance Demo MARKET entry + verified Algo STOP/TP + emergency close',
    status: 'IDLE',
    lastRunAt: null,
    detail: 'Auto execution OFF by default',
  },
  monitor: {
    id: 'monitor',
    label: '6. Trade Monitor',
    role: 'Reconciles positions, Algo exits, fees, drawdown & walk-forward logs',
    status: 'IDLE',
    lastRunAt: null,
    detail: 'Journal ready',
  },
};

function setAgentStatus(
  id: AgentName,
  status: AgentHealthState,
  detail: string
): void {
  agentStatuses[id] = {
    ...agentStatuses[id],
    status,
    lastRunAt: Date.now(),
    detail,
  };
}

function syncAiAnalystAgentCard(
  qStatus: GeminiQuotaStatusSnapshot,
  primaryAi?: GeminiAnalysisResult,
  cacheHits = 0,
  symbol?: string
): void {
  const cacheLabel = cacheHits > 0 ? ` (${cacheHits} cached)` : '';
  if (qStatus.status === 'QUOTA_EXHAUSTED') {
    setAgentStatus(
      'aiAnalyst',
      'QUOTA_EXHAUSTED',
      qStatus.quotaMessage || qStatus.lastApiError || 'Gemini daily quota exhausted'
    );
    const logKey = `QUOTA:${qStatus.dateUtc}:${qStatus.geminiBlockedUntil ?? qStatus.requestsUsedToday}`;
    if (lastLoggedQuotaErrorKey !== logKey) {
      lastLoggedQuotaErrorKey = logKey;
      appendAgentLog(
        'AGENT_3_GEMINI',
        'WARN',
        `${qStatus.quotaMessage || 'Gemini daily quota exhausted.'} (${qStatus.lastErrorCode || qStatus.lastApiError || '429 RESOURCE_EXHAUSTED'})`,
        symbol
      );
    }
    return;
  }

  if (qStatus.status === 'FALLBACK_ACTIVE') {
    setAgentStatus(
      'aiAnalyst',
      'FALLBACK_ACTIVE',
      primaryAi
        ? `FALLBACK (${primaryAi.modelUsed || qStatus.fallbackModel}): ${primaryAi.symbol} · ${primaryAi.marketRegime} · ${primaryAi.direction} (${(primaryAi.confidence * 100).toFixed(0)}%)${cacheLabel}`
        : `Fallback active: ${qStatus.fallbackModel} (primary ${qStatus.primaryModel} overloaded 503)`
    );
    const logKey = `FALLBACK:${qStatus.fallbackModel}:${qStatus.primaryCircuitOpenUntil ?? ''}`;
    if (lastLoggedQuotaErrorKey !== logKey) {
      lastLoggedQuotaErrorKey = logKey;
      appendAgentLog(
        'AGENT_3_GEMINI',
        'WARN',
        `Primary model ${qStatus.primaryModel} overloaded (503 UNAVAILABLE). Failover active on verified fallback ${qStatus.fallbackModel}.`,
        symbol
      );
    }
    return;
  }

  if (qStatus.status === 'OVERLOADED') {
    setAgentStatus(
      'aiAnalyst',
      'OVERLOADED',
      qStatus.lastApiError || `${qStatus.primaryModel} overloaded (503 UNAVAILABLE)`
    );
    const logKey = `OVERLOADED:${qStatus.lastErrorCode ?? ''}:${qStatus.primaryCircuitOpenUntil ?? ''}`;
    if (lastLoggedQuotaErrorKey !== logKey) {
      lastLoggedQuotaErrorKey = logKey;
      appendAgentLog(
        'AGENT_3_GEMINI',
        'ERROR',
        `Primary ${qStatus.primaryModel} OVERLOADED (${qStatus.lastErrorCode || '503 UNAVAILABLE'}): ${qStatus.lastApiError || 'High demand circuit breaker open'}`,
        symbol
      );
    }
    return;
  }

  if (qStatus.status === 'RECOVERING') {
    setAgentStatus(
      'aiAnalyst',
      'RECOVERING',
      `Cooldown elapsed — awaiting single recovery probe for ${qStatus.primaryModel}`
    );
    return;
  }

  if (qStatus.status === 'DEGRADED') {
    setAgentStatus(
      'aiAnalyst',
      'DEGRADED',
      qStatus.lastApiError || 'Gemini AI unavailable — AI Analyst is DEGRADED'
    );
    const logKey = `DEGRADED:${qStatus.lastErrorCategory}:${qStatus.lastErrorCode ?? ''}:${qStatus.nextRetryAt ?? ''}`;
    if (lastLoggedQuotaErrorKey !== logKey) {
      lastLoggedQuotaErrorKey = logKey;
      appendAgentLog(
        'AGENT_3_GEMINI',
        'ERROR',
        `[${qStatus.lastErrorCategory}] ${qStatus.lastApiError || 'Gemini AI unavailable — AI Analyst is DEGRADED'}`,
        symbol
      );
    }
    return;
  }

  if (qStatus.status === 'ACTIVE' && qStatus.lastSuccessfulAnalysisAt !== null) {
    lastLoggedQuotaErrorKey = '';
    setAgentStatus(
      'aiAnalyst',
      'ACTIVE',
      primaryAi
        ? `${primaryAi.symbol} (${primaryAi.modelUsed || qStatus.model}): ${primaryAi.marketRegime} · ${primaryAi.direction} (${(primaryAi.confidence * 100).toFixed(0)}%)${cacheLabel}`
        : `Gemini ACTIVE (${qStatus.lastRespondedModel || qStatus.primaryModel} · ${qStatus.requestsUsedToday}/${qStatus.maxDailyRequests} used today)`
    );
    return;
  }

  setAgentStatus(
    'aiAnalyst',
    'STANDBY',
    `Standby (${qStatus.primaryModel}) — waiting for qualified setup (${qStatus.requestsUsedToday}/${qStatus.maxDailyRequests} used today)`
  );
}

function ensureSchedulerRunning(): void {
  if (schedulerTimer) return;
  schedulerTimer = setInterval(() => {
    void runOrchestrationCycle();
  }, BACKEND_LOOP_MS);
}

function stopSchedulerIfIdle(): void {
  if (mode === 'STOPPED' && !getActiveTradeRecord() && schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

async function runOrchestrationCycle(): Promise<void> {
  if (cycleBusy || !deps) return;
  cycleBusy = true;

  try {
    await ensureAgentStorageLoaded();
    await ensureGeminiManagerLoaded();
    const cfg = getAgentConfig();

    // Agent 6: Always reconcile exchange positions & protective orders (even when paused or stopped)
    const monitorRes = await reconcilePositionAndOrders(
      deps.binanceRequest,
      activeCredentials,
      cfg.cooldownMinutes
    );
    latestExchangePositions = monitorRes.snapshot.positions;
    latestOpenOrdersCount = monitorRes.snapshot.openOrdersCount;
    setAgentStatus(
      'monitor',
      activeCredentials ? 'ACTIVE' : 'IDLE',
      monitorRes.reconcileNote
    );

    if (mode === 'STOPPED' || mode === 'PAUSED') {
      return;
    }

    if (monitorRes.activeTradeStillOpen && autoTradingEnabled) {
      setAgentStatus(
        'riskManager',
        'ACTIVE',
        '1 active position open — new entries locked while Trade Monitor reconciles exits'
      );
      return;
    }

    if (lastScanAt && Date.now() - lastScanAt < SCAN_COOLDOWN_MS) {
      return;
    }

    // Agent 1: Market Discovery
    setAgentStatus('discovery', 'ACTIVE', 'Scanning top 20 USDT perpetual pairs...');
    const discovered = await discoverTopLiquidMarkets((p) => {
      scanProgress = p;
    });
    lastScanAt = Date.now();
    setAgentStatus(
      'discovery',
      'ACTIVE',
      `Scanned ${discovered.markets.length}/${discovered.eligibleCount} pairs · ${scanProgress.unusualMoversCount} unusual`
    );

    // Agent 2: Quantitative Analysis
    setAgentStatus(
      'quant',
      'ACTIVE',
      `Scoring closed 5m/15m candles (min score ${cfg.minSignalScore}/100)`
    );
    const quantResults: QuantAnalysisResult[] = [];
    for (const m of discovered.markets) {
      try {
        const res = analyzeMarketQuantitatively(m, cfg.minSignalScore);
        quantResults.push(res);
        setLastProcessedCandle(m.symbol, m.latestClosedCandleTime);
      } catch {
        // Skip invalid symbols cleanly
      }
    }
    quantResults.sort(
      (a, b) => Math.abs(b.heuristicScore) - Math.abs(a.heuristicScore)
    );
    latestCandidates = quantResults;

    const bestBuyQuant =
      quantResults.find((q) => q.direction === 'BUY') ??
      quantResults
        .filter((q) => q.heuristicScore > 0)
        .sort((a, b) => b.heuristicScore - a.heuristicScore)[0] ??
      null;
    const bestSellQuant =
      quantResults.find((q) => q.direction === 'SELL') ??
      quantResults
        .filter((q) => q.heuristicScore < 0)
        .sort((a, b) => a.heuristicScore - b.heuristicScore)[0] ??
      null;

    const actionableBuyCount = quantResults.filter((q) => q.direction === 'BUY').length;
    const actionableSellCount = quantResults.filter((q) => q.direction === 'SELL').length;
    setAgentStatus(
      'quant',
      'ACTIVE',
      `Ranked ${quantResults.length} pairs · Actionable BUY=${actionableBuyCount} · SELL=${actionableSellCount}`
    );

    const qualifiedCandidates = quantResults
      .filter((q) => q.direction !== 'HOLD' && q.signalStrengthScore >= cfg.minSignalScore)
      .sort((a, b) => b.signalStrengthScore - a.signalStrengthScore);

    const topCandidate = qualifiedCandidates[0] ?? quantResults[0] ?? null;
    if (!topCandidate) {
      setGeminiAwaitingCandidatesCount(0);
      bestBuyOpportunity = null;
      bestSellOpportunity = null;
      return;
    }

    // Agent 3: Smart Batched Gemini AI Market Analyst (up to 3 qualified candidates per call)
    // Never wastes requests on non-actionable HOLD markets.
    let aiResultsMap = new Map<string, GeminiAnalysisResult>();
    if (qualifiedCandidates.length > 0) {
      const preStatus = getGeminiQuotaStatus();
      setAgentStatus(
        'aiAnalyst',
        preStatus.status === 'RECOVERING' ? 'RECOVERING' : preStatus.status,
        `Checking up to 3 qualified setups (${qualifiedCandidates.length} awaiting)`
      );
      const batchOutcome = await analyzeQualifiedCandidatesBatch(
        qualifiedCandidates.slice(0, 3)
      );
      aiResultsMap = batchOutcome.resultsBySymbol;

      const primaryAi = aiResultsMap.get(qualifiedCandidates[0].symbol);
      if (primaryAi) {
        lastAiAnalysis = { symbol: qualifiedCandidates[0].symbol, result: primaryAi };
      }

      syncAiAnalystAgentCard(
        batchOutcome.quotaStatus,
        primaryAi,
        batchOutcome.cacheHits,
        qualifiedCandidates[0].symbol
      );
    } else {
      setGeminiAwaitingCandidatesCount(0);
      const qStatus = getGeminiQuotaStatus();
      syncAiAnalystAgentCard(qStatus);
      if (qStatus.status === 'STANDBY' || qStatus.status === 'ACTIVE') {
        agentStatuses.aiAnalyst = {
          ...agentStatuses.aiAnalyst,
          detail: `0 qualified signals (>= ${cfg.minSignalScore}) — skipping Gemini call to conserve quota (${qStatus.requestsUsedToday}/${qStatus.maxDailyRequests})`,
        };
      }
    }

    // Agent 4: Mathematical Risk Manager evaluation (GEMINI_REQUIRED enforced for automated Demo entries)
    const filterMap = new Map<string, ExchangeSymbolFilter>(
      discovered.markets.map((m) => [m.symbol, m.filter])
    );

    const runRiskFor = (
      q: QuantAnalysisResult | null,
      requireAiForDecision = true
    ): OpportunitySnapshot | null => {
      if (!q) return null;
      const aiForSymbol = aiResultsMap.get(q.symbol) ?? null;
      const clientOrderId = `TS_${q.symbol.slice(0, 8)}_${q.latestClosedCandleTime}`;
      const decision = evaluateRisk({
        signal: {
          symbol: q.symbol,
          direction: q.direction,
          heuristicScore: q.heuristicScore,
          signalStrengthScore: q.signalStrengthScore,
          trendStrength: q.trendStrength,
          price: q.price,
          stopLoss: q.stopLoss,
          takeProfit: q.takeProfit,
          atr14: q.atr14,
          volatilityPct: q.volatilityPct,
          latestClosedCandleTime: q.latestClosedCandleTime,
          fetchedAt: q.fetchedAt,
        },
        aiAnalysis: aiForSymbol,
        account: {
          ...monitorRes.snapshot.account,
          accountCanTrade: null,
          accountConfigCanTrade:
            sessionPermissionDiagnostics?.accountConfigCanTrade ??
            monitorRes.snapshot.account.canTrade,
          orderTestPassed: sessionPermissionDiagnostics?.orderTestPassed === true,
          orderTestMessage: sessionPermissionDiagnostics?.orderTestMessage,
        },
        openPositions: monitorRes.snapshot.positions,
        openOrdersCount: monitorRes.snapshot.openOrdersCount,
        symbolFilter: filterMap.get(q.symbol) ?? null,
        dailyEquity: {
          ...getDailyEquityState(),
          realizedPnlToday: getTodayRealizedPnl(),
        },
        cooldownUntilMs: getSymbolCooldown(q.symbol),
        executionLocked: cycleBusy && inFlightSymbols.size > 0,
        inFlightSymbols,
        duplicateClientOrderExists: hasClientOrderId(clientOrderId),
        requireAiApproval: requireAiForDecision,
        minSignalScore: cfg.minSignalScore,
        maxNotionalUsd: cfg.maxOrderNotionalUsd,
        maxLeverage: cfg.maxLeverage,
        proposedClientOrderId: clientOrderId,
      });

      return {
        symbol: q.symbol,
        quant: q,
        aiAnalysis: aiForSymbol,
        riskDecision: decision,
      };
    };

    // Always require AI approval (GEMINI_REQUIRED = true) for actual Demo execution risk gates
    bestBuyOpportunity = runRiskFor(bestBuyQuant, true);
    bestSellOpportunity = runRiskFor(bestSellQuant, true);

    // Explicitly configured QUANT_ONLY paper-testing evaluation (never auto-activated, never places Demo orders)
    if (cfg.quantOnlyPaperMode && mode === 'SCAN_ONLY' && qualifiedCandidates.length > 0) {
      const paperTop = qualifiedCandidates[0];
      const paperEval = evaluateRisk({
        signal: {
          symbol: paperTop.symbol,
          direction: paperTop.direction,
          heuristicScore: paperTop.heuristicScore,
          signalStrengthScore: paperTop.signalStrengthScore,
          trendStrength: paperTop.trendStrength,
          price: paperTop.price,
          stopLoss: paperTop.stopLoss,
          takeProfit: paperTop.takeProfit,
          atr14: paperTop.atr14,
          volatilityPct: paperTop.volatilityPct,
          latestClosedCandleTime: paperTop.latestClosedCandleTime,
          fetchedAt: paperTop.fetchedAt,
        },
        aiAnalysis: null,
        account: {
          connected: true,
          canTrade: true,
          accountCanTrade: null,
          accountConfigCanTrade: true,
          orderTestPassed: true,
          availableBalance: monitorRes.snapshot.account.availableBalance || 5000,
          totalWalletBalance: monitorRes.snapshot.account.totalWalletBalance || 5000,
          totalUnrealizedProfit: 0,
        },
        openPositions: [],
        openOrdersCount: 0,
        symbolFilter: filterMap.get(paperTop.symbol) ?? null,
        dailyEquity: {
          ...getDailyEquityState(),
          realizedPnlToday: getTodayRealizedPnl(),
        },
        cooldownUntilMs: getSymbolCooldown(paperTop.symbol),
        executionLocked: false,
        inFlightSymbols: new Set(),
        duplicateClientOrderExists: false,
        requireAiApproval: false,
        minSignalScore: cfg.minSignalScore,
        maxNotionalUsd: cfg.maxOrderNotionalUsd,
        maxLeverage: cfg.maxLeverage,
      });
      appendAgentLog(
        'AGENT_2_QUANT',
        'INFO',
        `[QUANT_ONLY PAPER TEST] ${paperTop.direction} ${paperTop.symbol} score=${paperTop.signalStrengthScore}/100 · RiskCheck=${paperEval.approved ? 'PAPER_READY' : `PAPER_SKIP (${paperEval.reasons[0]})`} (zero exchange orders placed).`,
        paperTop.symbol
      );
    }

    const topOpportunity =
      topCandidate.direction === 'BUY'
        ? bestBuyOpportunity
        : topCandidate.direction === 'SELL'
          ? bestSellOpportunity
          : runRiskFor(topCandidate, true);

    const decision = topOpportunity?.riskDecision ?? null;
    lastRiskDecision = decision;

    if (decision) {
      if (decision.dailyLossTriggered) {
        autoTradingEnabled = false;
        mode = 'PAUSED';
        setAgentStatus('riskManager', 'PAUSED', 'Daily 1% loss circuit breaker triggered');
        appendAgentLog(
          'AGENT_4_RISK',
          'CRITICAL',
          `Daily loss limit reached — automated entries PAUSED.`,
          decision.symbol
        );
        void notifyTelegramEvent(
          'DAILY_LOSS_LIMIT',
          `Daily loss limit (${cfg.maxDailyLossPct}%) triggered. New automated Demo entries PAUSED.`,
          `daily-loss-${getDailyEquityState().dateUtc}`
        );
        return;
      }

      setAgentStatus(
        'riskManager',
        decision.approved ? 'ACTIVE' : 'PAUSED',
        decision.approved
          ? `APPROVED ${decision.symbol} (${decision.orderPlan?.quantity} @ ${decision.orderPlan?.leverage}x)`
          : `REJECTED ${decision.symbol}: ${decision.reasons[0] || 'Risk gate failed'}`
      );

      if (topCandidate.direction !== 'HOLD') {
        appendAgentLog(
          'AGENT_4_RISK',
          decision.approved ? 'INFO' : 'WARN',
          decision.approved
            ? decision.reasons[0]
            : `${decision.symbol} rejected: ${decision.reasons.join(' | ')}`,
          decision.symbol
        );
        if (decision.approved) {
          void notifyTelegramEvent(
            'SIGNAL_APPROVED',
            `APPROVED ${decision.orderPlan!.side} ${decision.symbol} qty=${decision.orderPlan!.quantity} ($${decision.orderPlan!.notionalUsd.toFixed(2)} @ ${decision.orderPlan!.leverage}x)`,
            `sig-app-${decision.symbol}-${topCandidate.latestClosedCandleTime}`
          );
        } else {
          void notifyTelegramEvent(
            'RISK_REJECTED',
            `${decision.symbol} rejected: ${decision.reasons[0]}`,
            `sig-rej-${decision.symbol}-${topCandidate.latestClosedCandleTime}`
          );
        }
      }
    }

    // Agent 5: Automated Demo Execution ONLY when explicitly started and approved
    if (
      mode === 'AUTO_TRADING' &&
      autoTradingEnabled &&
      demoExplicitlyConfirmed &&
      activeCredentials &&
      decision?.approved &&
      decision.orderPlan
    ) {
      const symFilter = filterMap.get(topCandidate.symbol);
      const topAiResult = aiResultsMap.get(topCandidate.symbol) ?? null;
      if (symFilter && topAiResult?.available && !topAiResult.degraded && !topAiResult.quotaExhausted) {
        const execRes = await executeApprovedOrder(
          decision,
          topCandidate,
          topAiResult,
          symFilter,
          {
            credentials: activeCredentials,
            binanceRequest: deps.binanceRequest,
            inFlightSymbols,
            onPauseRequired: (reason) => {
              autoTradingEnabled = false;
              mode = 'PAUSED';
              setAgentStatus('execution', 'PAUSED', reason);
            },
          }
        );

        if (execRes.success) {
          setAgentStatus(
            'execution',
            'ACTIVE',
            `OPEN ${execRes.tradeRecord?.symbol} qty=${execRes.tradeRecord?.executedQuantity} (SL/TP ARMED)`
          );
        } else {
          setAgentStatus(
            'execution',
            'ERROR',
            execRes.error || 'Execution halted safely'
          );
        }
      }
    }

    lastErrorMessage = '';
  } catch (err: any) {
    lastErrorMessage = err?.message || 'Multi-agent cycle error';
    appendAgentLog('SYSTEM', 'ERROR', lastErrorMessage);
  } finally {
    cycleBusy = false;
  }
}

export async function reconcileOnSessionConnected(
  creds: DemoCredentials
): Promise<void> {
  if (!deps) return;
  activeCredentials = creds;
  await ensureAgentStorageLoaded();
  const active = getActiveTradeRecord();
  if (active) {
    ensureSchedulerRunning();
  }
  try {
    const cfg = getAgentConfig();
    const res = await reconcilePositionAndOrders(
      deps.binanceRequest,
      creds,
      cfg.cooldownMinutes
    );
    latestExchangePositions = res.snapshot.positions;
    latestOpenOrdersCount = res.snapshot.openOrdersCount;
    setAgentStatus('monitor', 'ACTIVE', res.reconcileNote);
  } catch (err: any) {
    setAgentStatus('monitor', 'ERROR', err?.message || 'Initial reconciliation failed');
  }
}

export function pauseAutoAgentOnDisconnect(
  reason = 'Binance Demo session disconnected'
): void {
  autoTradingEnabled = false;
  demoExplicitlyConfirmed = false;
  activeCredentials = null;
  sessionPermissionDiagnostics = null;
  if (mode === 'AUTO_TRADING') {
    mode = 'PAUSED';
  }
  setAgentStatus('execution', 'PAUSED', reason);
  appendAgentLog(
    'SYSTEM',
    'WARN',
    `${reason}. New entries paused; open exchange orders remain untouched.`
  );
}

export function shutdownAutoAgent(): void {
  autoTradingEnabled = false;
  mode = 'STOPPED';
  activeCredentials = null;
  sessionPermissionDiagnostics = null;
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function buildStatusResponse() {
  const perf = getPerformanceSummary();
  const cfg = getAgentConfig();
  const geminiStatus = getGeminiQuotaStatus();
  return {
    success: true,
    environment: 'USD_M_FUTURES_DEMO' as const,
    liveTradingEnabled: false as const,
    mode,
    autoTradingEnabled,
    demoExplicitlyConfirmed,
    credentialsBound: Boolean(
      activeCredentials?.apiKey && activeCredentials?.apiSecret
    ),
    permissionDiagnostics: sessionPermissionDiagnostics,
    config: cfg,
    riskLimits: HARD_RISK_CONSTANTS,
    lastScanAt,
    lastTradeAt: getLastTradeAt(),
    scanProgress,
    agents: Object.values(agentStatuses),
    opportunities: {
      bestBuy: bestBuyOpportunity,
      bestSell: bestSellOpportunity,
      scannedTopCount: latestCandidates.length,
      candidates: latestCandidates.slice(0, 12),
    },
    aiAnalysis: lastAiAnalysis,
    geminiStatus,
    riskDecision: lastRiskDecision,
    activeTrade: getActiveTradeRecord(),
    exchangePositions: latestExchangePositions,
    exchangeOpenOrdersCount: latestOpenOrdersCount,
    recentTrades: getRecentTrades(25),
    criticalErrors: getCriticalErrors(20),
    todayRealizedPnl: perf.todayRealizedPnl,
    unrealizedPnl: latestExchangePositions.reduce(
      (s, p) => s + p.unRealizedProfit,
      0
    ),
    performance: perf,
    lastError: lastErrorMessage || null,
    updatedAt: Date.now(),
  };
}

export function registerAgentEngineRoutes(
  app: Express,
  dependencies: AgentEngineDependencies
): void {
  deps = dependencies;

  // Startup initialization: NEVER auto-start automated trading; recover journal & Gemini quota state cleanly.
  void Promise.all([ensureAgentStorageLoaded(), ensureGeminiManagerLoaded()]).then(() => {
    const active = getActiveTradeRecord();
    if (active) {
      markUncertainStartupTrades(active);
      setAgentStatus(
        'monitor',
        'PAUSED',
        `Restored open ${active.symbol} from journal (awaiting Demo session for exchange check)`
      );
    }
    const qStatus = getGeminiQuotaStatus();
    syncAiAnalystAgentCard(qStatus);
  });

  app.get('/api/agent/status', async (_req: Request, res: Response) => {
    await Promise.all([ensureAgentStorageLoaded(), ensureGeminiManagerLoaded()]);
    res.json(buildStatusResponse());
  });

  app.get('/api/agent/logs', async (req: Request, res: Response) => {
    await ensureAgentStorageLoaded();
    const rawLimit = Number(req.query.limit ?? 150);
    const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 150));
    res.json({
      success: true,
      logs: getRecentLogs(limit),
      criticalErrors: getCriticalErrors(30),
    });
  });

  app.get('/api/agent/performance', async (_req: Request, res: Response) => {
    await ensureAgentStorageLoaded();
    const perf = getPerformanceSummary();
    res.json({
      success: true,
      environment: 'USD_M_FUTURES_DEMO',
      performance: perf,
      trades: getRecentTrades(100),
      learningSamplesCount: getLearningSamples(200).length,
    });
  });

  app.get('/api/agent/config', async (_req: Request, res: Response) => {
    await Promise.all([ensureAgentStorageLoaded(), ensureGeminiManagerLoaded()]);
    res.json({
      success: true,
      environment: 'USD_M_FUTURES_DEMO',
      liveTradingEnabled: false,
      config: getAgentConfig(),
      geminiStatus: getGeminiQuotaStatus(),
      hardLimits: HARD_RISK_CONSTANTS,
    });
  });

  app.post('/api/agent/config', async (req: Request, res: Response) => {
    if (deps?.validateMutationOrigin && !deps.validateMutationOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Cross-origin mutation rejected.' });
    }
    await ensureGeminiManagerLoaded();
    const updated = await updateAgentConfig(req.body as Partial<AgentEngineConfig>);
    appendAgentLog(
      'SYSTEM',
      'INFO',
      `Agent config updated (minSignalScore=${updated.minSignalScore}, policy=${updated.tradingPolicy}, quantOnlyPaperMode=${updated.quantOnlyPaperMode}, cooldown=${updated.cooldownMinutes}m).`
    );
    return res.json({
      success: true,
      config: updated,
      geminiStatus: getGeminiQuotaStatus(),
    });
  });

  app.post('/api/agent/gemini/recheck', async (req: Request, res: Response) => {
    if (deps?.validateMutationOrigin && !deps.validateMutationOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Cross-origin mutation rejected.' });
    }
    try {
      await Promise.all([ensureAgentStorageLoaded(), ensureGeminiManagerLoaded()]);
      const cfg = getAgentConfig();
      const qualifiedCandidates = latestCandidates
        .filter((q) => q.direction !== 'HOLD' && q.signalStrengthScore >= cfg.minSignalScore)
        .slice(0, 3);
      const geminiStatus = await recheckGeminiAvailability(qualifiedCandidates);
      syncAiAnalystAgentCard(geminiStatus);
      appendAgentLog(
        'AGENT_3_GEMINI',
        geminiStatus.status === 'ACTIVE' || geminiStatus.status === 'FALLBACK_ACTIVE' ? 'INFO' : 'WARN',
        `Manual RECHECK AI completed: status=${geminiStatus.status}, primary=${geminiStatus.primaryModel} (${geminiStatus.primaryStatus}), fallback=${geminiStatus.fallbackModel || 'NOT CONFIGURED'} (${geminiStatus.fallbackStatus}).`
      );
      return res.json(buildStatusResponse());
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to recheck Gemini AI availability.',
      });
    }
  });

  app.post('/api/agent/start', async (req: Request, res: Response) => {
    if (deps?.validateMutationOrigin && !deps.validateMutationOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Cross-origin mutation rejected.' });
    }
    if (startBusy) {
      return res.status(409).json({ success: false, error: 'Agent start already in progress.' });
    }
    startBusy = true;

    try {
      await ensureAgentStorageLoaded();
      const requestedMode =
        req.body?.mode === 'AUTO_TRADING' ? 'AUTO_TRADING' : 'SCAN_ONLY';

      if (requestedMode === 'AUTO_TRADING') {
        if (req.body?.demoConfirmed !== true) {
          return res.status(400).json({
            success: false,
            error:
              'Explicit Demo-only confirmation is required before enabling Binance Demo auto trading.',
          });
        }
        const creds = deps!.getCredentials(req, false);
        if (!creds?.apiKey || !creds?.apiSecret) {
          return res.status(401).json({
            success: false,
            error:
              'Connect your Binance USD-M Futures Demo account before starting Demo auto trading.',
          });
        }

        const cfg = getAgentConfig();
        const [recon, diag] = await Promise.all([
          reconcilePositionAndOrders(
            deps!.binanceRequest,
            creds,
            cfg.cooldownMinutes
          ),
          runNonExecutingPermissionDiagnostic(deps!.binanceRequest, creds),
        ]);
        sessionPermissionDiagnostics = diag;

        if (!diag.apiAuthenticated) {
          return res.status(401).json({
            success: false,
            error:
              diag.classificationMessage ||
              diag.orderTestMessage ||
              'Binance Demo authentication failed.',
            diagnostics: diag,
          });
        }
        if (
          !diag.tradingConfirmed ||
          diag.accountConfigCanTrade !== true ||
          !recon.snapshot.account.canTrade
        ) {
          return res.status(403).json({
            success: false,
            error: diag.classificationMessage || 'ACCOUNT TRADING DISABLED.',
            diagnostics: diag,
          });
        }
        if (recon.snapshot.account.availableBalance <= 0) {
          return res.status(400).json({
            success: false,
            error: 'Binance Demo available USDT balance must be greater than zero.',
            diagnostics: diag,
          });
        }

        activeCredentials = creds;
        demoExplicitlyConfirmed = true;
        autoTradingEnabled = true;
        mode = 'AUTO_TRADING';
        setAgentStatus(
          'execution',
          'ACTIVE',
          'Demo auto-trading ARMED (0.25% risk, max 2x, $100 cap, max 1 pos)'
        );
        appendAgentLog(
          'SYSTEM',
          'INFO',
          'DEMO AUTO TRADING started with explicit user confirmation.'
        );
      } else {
        const maybeCreds = deps!.getCredentials(req, false);
        if (maybeCreds) activeCredentials = maybeCreds;
        autoTradingEnabled = false;
        demoExplicitlyConfirmed = false;
        mode = 'SCAN_ONLY';
        setAgentStatus(
          'execution',
          'IDLE',
          'Scanner running only — Demo auto execution disabled'
        );
        appendAgentLog(
          'SYSTEM',
          'INFO',
          'Market Scanner started in SCAN_ONLY mode (no orders placed).'
        );
      }

      lastScanAt = null;
      ensureSchedulerRunning();
      void runOrchestrationCycle();

      return res.json(buildStatusResponse());
    } catch (err: any) {
      return res.status(500).json({
        success: false,
        error: err?.message || 'Failed to start multi-agent engine.',
      });
    } finally {
      startBusy = false;
    }
  });

  app.post('/api/agent/position/close', async (req: Request, res: Response) => {
    if (deps?.validateMutationOrigin && !deps.validateMutationOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Cross-origin mutation rejected.' });
    }
    if (req.body?.confirm !== true) {
      return res.status(400).json({ success: false, error: 'Explicit close confirmation is required.' });
    }

    await ensureAgentStorageLoaded();
    const active = getActiveTradeRecord();
    if (!active) {
      return res.status(404).json({ success: false, error: 'No tracked open Demo trade exists.' });
    }

    const credentials = deps!.getCredentials(req, false) || activeCredentials;
    if (!credentials?.apiKey || !credentials?.apiSecret) {
      return res.status(401).json({ success: false, error: 'Connect Binance Futures Demo before closing the position.' });
    }
    activeCredentials = credentials;

    try {
      const before = await deps!.binanceRequest<any[]>(
        'GET',
        '/fapi/v3/positionRisk',
        { symbol: active.symbol },
        true,
        credentials
      );
      if (!Array.isArray(before)) {
        throw new Error('Binance returned an invalid position snapshot; close was not submitted.');
      }

      const live = before.find((p) =>
        p.symbol === active.symbol &&
        (active.positionMode === 'ONE_WAY' || p.positionSide === active.positionSide) &&
        Math.abs(Number(p.positionAmt || 0)) > 1e-12
      );

      // A user may already have closed the position manually on Binance.
      // Reconcile the journal only after the exchange snapshot confirms flat.
      if (!live) {
        const reconciled = await reconcilePositionAndOrders(
          deps!.binanceRequest,
          credentials,
          getAgentConfig().cooldownMinutes
        );
        latestExchangePositions = reconciled.snapshot.positions;
        latestOpenOrdersCount = reconciled.snapshot.openOrdersCount;
        return res.json({
          success: true,
          alreadyFlat: true,
          message: 'Binance confirms the position is already flat; trade journal reconciled.',
          ...buildStatusResponse(),
        });
      }

      const quantity = Math.abs(Number(live.positionAmt)).toString();
      const closeParams: Record<string, any> = {
        symbol: active.symbol,
        side: active.side === 'BUY' ? 'SELL' : 'BUY',
        type: 'MARKET',
        quantity,
        newClientOrderId: `TS-MANUAL-CLOSE-${Date.now()}`,
        newOrderRespType: 'RESULT',
      };
      if (active.positionMode === 'HEDGE') {
        closeParams.positionSide = active.positionSide;
      } else {
        closeParams.reduceOnly = 'true';
      }

      let closeResponse: any = null;
      let submitError: unknown = null;
      try {
        closeResponse = await deps!.binanceRequest<any>(
          'POST',
          '/fapi/v1/order',
          closeParams,
          true,
          credentials
        );
      } catch (err) {
        submitError = err;
      }

      // Never infer closure from the POST response. Re-read Binance position risk.
      const after = await deps!.binanceRequest<any[]>(
        'GET',
        '/fapi/v3/positionRisk',
        { symbol: active.symbol },
        true,
        credentials
      );
      if (!Array.isArray(after)) {
        throw new Error('Close request outcome is uncertain: Binance position verification returned an invalid response. Check the Demo account before retrying.');
      }
      const remaining = after.find((p) =>
        p.symbol === active.symbol &&
        (active.positionMode === 'ONE_WAY' || p.positionSide === active.positionSide)
      );
      const remainingQty = Math.abs(Number(remaining?.positionAmt || 0));
      if (remainingQty > 1e-12) {
        const reason = submitError instanceof Error ? submitError.message : 'Binance still reports an open position.';
        return res.status(409).json({
          success: false,
          error: `Position is not confirmed closed (remaining quantity ${remainingQty}). ${reason} Do not submit another close until the exchange state is checked.`,
          orderId: closeResponse?.orderId ?? null,
        });
      }

      const reconciled = await reconcilePositionAndOrders(
        deps!.binanceRequest,
        credentials,
        getAgentConfig().cooldownMinutes
      );
      latestExchangePositions = reconciled.snapshot.positions;
      latestOpenOrdersCount = reconciled.snapshot.openOrdersCount;
      appendAgentLog(
        'AGENT_5_EXECUTION',
        'TRADE',
        `Manual close verified by Binance for ${active.symbol}; order=${closeResponse?.orderId ?? 'response unavailable'}.`,
        active.symbol
      );
      return res.json({
        success: true,
        alreadyFlat: false,
        orderId: closeResponse?.orderId ?? null,
        message: 'Binance confirms the position is flat. Trade history has been reconciled.',
        ...buildStatusResponse(),
      });
    } catch (err: any) {
      recordCriticalError(
        'MANUAL_CLOSE_UNVERIFIED',
        err?.message || 'Manual close could not be verified. Check Binance Demo directly.',
        active.symbol
      );
      return res.status(502).json({
        success: false,
        error: err?.message || 'Manual close could not be verified. Check Binance Demo directly.',
        exchangeState: 'UNKNOWN',
      });
    }
  });

  app.post('/api/agent/pause', async (req: Request, res: Response) => {
    if (deps?.validateMutationOrigin && !deps.validateMutationOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Cross-origin mutation rejected.' });
    }
    await ensureAgentStorageLoaded();
    autoTradingEnabled = false;
    mode = 'PAUSED';
    setAgentStatus(
      'execution',
      'PAUSED',
      'New entries PAUSED — existing positions & protective Algo orders preserved'
    );
    appendAgentLog(
      'SYSTEM',
      'WARN',
      'New trades PAUSED by user. Monitoring and protective exits remain active.'
    );
    return res.json(buildStatusResponse());
  });

  app.post('/api/agent/resume', async (req: Request, res: Response) => {
    if (deps?.validateMutationOrigin && !deps.validateMutationOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Cross-origin mutation rejected.' });
    }
    await ensureAgentStorageLoaded();
    const wantsAuto =
      req.body?.mode === 'AUTO_TRADING' || demoExplicitlyConfirmed;

    if (wantsAuto) {
      const creds = deps!.getCredentials(req, false) || activeCredentials;
      if (!creds?.apiKey || !creds?.apiSecret) {
        return res.status(401).json({
          success: false,
          error: 'Connect your Binance Demo API before resuming auto trading.',
        });
      }
      if (!demoExplicitlyConfirmed && req.body?.demoConfirmed !== true) {
        return res.status(400).json({
          success: false,
          error: 'Explicit Demo-only confirmation required to resume auto trading.',
        });
      }
      const diag = await runNonExecutingPermissionDiagnostic(
        deps!.binanceRequest,
        creds
      );
      sessionPermissionDiagnostics = diag;
      if (
        !diag.apiAuthenticated ||
        !diag.tradingConfirmed ||
        diag.accountConfigCanTrade !== true ||
        !diag.orderTestPassed
      ) {
        autoTradingEnabled = false;
        return res.status(403).json({
          success: false,
          error: diag.classificationMessage || 'ACCOUNT TRADING DISABLED.',
          diagnostics: diag,
        });
      }
      activeCredentials = creds;
      demoExplicitlyConfirmed = true;
      autoTradingEnabled = true;
      mode = 'AUTO_TRADING';
      setAgentStatus('execution', 'ACTIVE', 'Demo auto-trading RESUMED');
      appendAgentLog('SYSTEM', 'INFO', 'Resumed Demo automated trading.');
    } else {
      autoTradingEnabled = false;
      mode = 'SCAN_ONLY';
      setAgentStatus('execution', 'IDLE', 'Resumed market scanner (SCAN_ONLY)');
      appendAgentLog('SYSTEM', 'INFO', 'Resumed market scanner (SCAN_ONLY).');
    }

    ensureSchedulerRunning();
    void runOrchestrationCycle();
    return res.json(buildStatusResponse());
  });

  app.post('/api/agent/stop', async (req: Request, res: Response) => {
    if (deps?.validateMutationOrigin && !deps.validateMutationOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Cross-origin mutation rejected.' });
    }
    await ensureAgentStorageLoaded();
    autoTradingEnabled = false;
    demoExplicitlyConfirmed = false;
    mode = 'STOPPED';

    const active = getActiveTradeRecord();
    if (active) {
      setAgentStatus(
        'execution',
        'IDLE',
        `New trades STOPPED · preserving Algo SL/TP on ${active.symbol}`
      );
      setAgentStatus(
        'monitor',
        'ACTIVE',
        `Continuing protective reconciliation for open ${active.symbol}`
      );
      appendAgentLog(
        'SYSTEM',
        'WARN',
        `New trades stopped by user. Open position ${active.symbol} and protective Algo exits remain monitored.`
      );
      ensureSchedulerRunning();
    } else {
      setAgentStatus('execution', 'IDLE', 'Stopped — no new entries allowed');
      appendAgentLog('SYSTEM', 'INFO', 'Engine stopped by user.');
      stopSchedulerIfIdle();
    }
    return res.json(buildStatusResponse());
  });
}
