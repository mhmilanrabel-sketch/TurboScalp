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
  runGeminiMarketAnalysis,
  type GeminiAnalysisResult,
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

    const topCandidate =
      quantResults.find((q) => q.direction !== 'HOLD') ?? quantResults[0] ?? null;
    if (!topCandidate) {
      bestBuyOpportunity = null;
      bestSellOpportunity = null;
      return;
    }

    // Agent 3: Gemini AI Market Analyst on top setup
    setAgentStatus('aiAnalyst', 'ACTIVE', `Evaluating ${topCandidate.symbol} regime & risk flags`);
    const aiResult = await runGeminiMarketAnalysis(topCandidate);
    lastAiAnalysis = { symbol: topCandidate.symbol, result: aiResult };
    if (aiResult.degraded || !aiResult.available) {
      setAgentStatus(
        'aiAnalyst',
        'DEGRADED',
        aiResult.error || 'Gemini AI unavailable — AI Analyst is DEGRADED'
      );
      appendAgentLog('AGENT_3_GEMINI', 'ERROR', aiResult.reasoning, topCandidate.symbol);
    } else {
      setAgentStatus(
        'aiAnalyst',
        'ACTIVE',
        `${topCandidate.symbol}: ${aiResult.marketRegime} · ${aiResult.direction} (${(aiResult.confidence * 100).toFixed(0)}%)`
      );
    }

    // Agent 4: Mathematical Risk Manager evaluation
    const filterMap = new Map<string, ExchangeSymbolFilter>(
      discovered.markets.map((m) => [m.symbol, m.filter])
    );

    const runRiskFor = (
      q: QuantAnalysisResult | null
    ): OpportunitySnapshot | null => {
      if (!q) return null;
      const aiForSymbol = q.symbol === topCandidate.symbol ? aiResult : null;
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
        account: monitorRes.snapshot.account,
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
        requireAiApproval: cfg.requireAiApproval,
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

    bestBuyOpportunity = runRiskFor(bestBuyQuant);
    bestSellOpportunity = runRiskFor(bestSellQuant);

    const topOpportunity =
      topCandidate.direction === 'BUY'
        ? bestBuyOpportunity
        : topCandidate.direction === 'SELL'
          ? bestSellOpportunity
          : runRiskFor(topCandidate);

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
      if (symFilter) {
        const execRes = await executeApprovedOrder(
          decision,
          topCandidate,
          aiResult,
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
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
}

function buildStatusResponse() {
  const perf = getPerformanceSummary();
  const cfg = getAgentConfig();
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

  // Startup initialization: NEVER auto-start automated trading; recover journal cleanly.
  void ensureAgentStorageLoaded().then(() => {
    const active = getActiveTradeRecord();
    if (active) {
      markUncertainStartupTrades(active);
      setAgentStatus(
        'monitor',
        'PAUSED',
        `Restored open ${active.symbol} from journal (awaiting Demo session for exchange check)`
      );
    }
  });

  app.get('/api/agent/status', async (_req: Request, res: Response) => {
    await ensureAgentStorageLoaded();
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
    await ensureAgentStorageLoaded();
    res.json({
      success: true,
      environment: 'USD_M_FUTURES_DEMO',
      liveTradingEnabled: false,
      config: getAgentConfig(),
      hardLimits: HARD_RISK_CONSTANTS,
    });
  });

  app.post('/api/agent/config', async (req: Request, res: Response) => {
    if (deps?.validateMutationOrigin && !deps.validateMutationOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Cross-origin mutation rejected.' });
    }
    const updated = await updateAgentConfig(req.body as Partial<AgentEngineConfig>);
    appendAgentLog(
      'SYSTEM',
      'INFO',
      `Agent config updated (minSignalScore=${updated.minSignalScore}, requireAiApproval=${updated.requireAiApproval}, cooldown=${updated.cooldownMinutes}m).`
    );
    return res.json({ success: true, config: updated });
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
        const recon = await reconcilePositionAndOrders(
          deps!.binanceRequest,
          creds,
          cfg.cooldownMinutes
        );
        if (!recon.snapshot.account.canTrade) {
          return res.status(403).json({
            success: false,
            error: 'Binance Demo account reports Futures trading permission is disabled.',
          });
        }
        if (recon.snapshot.account.availableBalance <= 0) {
          return res.status(400).json({
            success: false,
            error: 'Binance Demo available USDT balance must be greater than zero.',
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
