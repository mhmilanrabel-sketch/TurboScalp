// server/agent/agentStorage.ts
// Persistent atomic trade journal, configuration, daily loss state,
// cooldown tracking, critical error log, walk-forward samples,
// and non-blocking Telegram notifications.
// Never persists Binance API secrets or Gemini keys.

import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';

export type AgentName =
  | 'discovery'
  | 'quant'
  | 'aiAnalyst'
  | 'riskManager'
  | 'execution'
  | 'monitor';

export type AgentHealthState =
  | 'IDLE'
  | 'STANDBY'
  | 'ACTIVE'
  | 'FALLBACK_ACTIVE'
  | 'PAUSED'
  | 'OVERLOADED'
  | 'RECOVERING'
  | 'DEGRADED'
  | 'QUOTA_EXHAUSTED'
  | 'ERROR';

export interface AgentUnitStatus {
  id: AgentName;
  label: string;
  role: string;
  status: AgentHealthState;
  lastRunAt: number | null;
  detail: string;
}

export type TradingPolicyMode = 'GEMINI_REQUIRED' | 'QUANT_ONLY_PAPER';

export interface AgentEngineConfig {
  environment: 'USD_M_FUTURES_DEMO';
  minSignalScore: number;
  riskPerTradePct: number;
  maxLeverage: number;
  maxOpenPositions: number;
  maxOrderNotionalUsd: number;
  maxDailyLossPct: number;
  cooldownMinutes: number;
  requireAiApproval: boolean;
  tradingPolicy: TradingPolicyMode;
  quantOnlyPaperMode: boolean;
  // Qwen analysis is advisory unless explicitly enabled after validation.
  localAiApprovalEnabled: boolean;
}

export const DEFAULT_AGENT_CONFIG: AgentEngineConfig = Object.freeze({
  environment: 'USD_M_FUTURES_DEMO',
  minSignalScore: 65,
  riskPerTradePct: 0.25,
  maxLeverage: 2,
  maxOpenPositions: 1,
  maxOrderNotionalUsd: 100,
  maxDailyLossPct: 1.0,
  cooldownMinutes: 30,
  requireAiApproval: true,
  tradingPolicy: 'GEMINI_REQUIRED',
  quantOnlyPaperMode: false,
  localAiApprovalEnabled: false,
});

export interface SignalLearningSnapshot {
  quantDirection: 'BUY' | 'SELL' | 'HOLD';
  heuristicScore: number;
  trendStrength: number;
  rsi14: number;
  ema9: number;
  ema21: number;
  ema50: number;
  atr14: number;
  volatilityPct: number;
  volumeRatio: number;
  breakout: 'BULLISH_BREAKOUT' | 'BEARISH_BREAKOUT' | 'NONE';
  mtfAligned: boolean;
  marketRegime: 'TRENDING' | 'SIDEWAYS' | 'VOLATILE' | 'CONFLICTED' | 'UNKNOWN';
  aiDirection: 'BUY' | 'SELL' | 'HOLD' | 'UNAVAILABLE';
  aiSentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  aiConfidence: number; // 0.0 - 1.0
  aiRiskFlags: string[];
  stopDistancePct: number;
}

export type ExecutionLifecycleStatus =
  | 'SUBMITTING'
  | 'FILLED_PROTECTED'
  | 'PARTIAL_PROTECTED'
  | 'ROLLBACK_CLOSED'
  | 'UNCERTAIN_RECOVERY_NEEDED'
  | 'CLOSED';

export interface AgentTradeRecord {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionMode: 'ONE_WAY' | 'HEDGE';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED' | 'EMERGENCY_CLOSED';
  executionStatus: ExecutionLifecycleStatus;
  requestedQuantity: string;
  executedQuantity: string;
  leverage: number;
  notionalUsd: number;
  riskUsd: number;
  entryPrice: number;
  exitPrice: number | null;
  markPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  entryOrderId: number | string | null;
  entryClientOrderId: string;
  stopAlgoId: number | string | null;
  stopClientAlgoId: string;
  targetAlgoId: number | string | null;
  targetClientAlgoId: string;
  emergencyOrderId: number | string | null;
  stopStatus: 'ARMED' | 'PENDING' | 'FAILED' | 'TRIGGERED' | 'CANCELLED';
  takeProfitStatus: 'ARMED' | 'PENDING' | 'FAILED' | 'TRIGGERED' | 'CANCELLED';
  unrealizedPnl: number;
  realizedPnl: number | null;
  tradingFees: number;
  fundingFees: number;
  commission: number;
  netPnl: number | null;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
  signalSnapshot: SignalLearningSnapshot;
}

export interface LearningSample {
  id: string;
  tradeId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  outcome: 'WIN' | 'LOSS' | 'FLAT';
  netPnl: number;
  returnPct: number;
  holdingMs: number;
  recordedAt: number;
  features: SignalLearningSnapshot;
}

export interface AgentLogEntry {
  id: string;
  at: number;
  agent:
    | 'SYSTEM'
    | 'AGENT_1_DISCOVERY'
    | 'AGENT_2_QUANT'
    | 'AGENT_3_GEMINI'
    | 'AGENT_4_RISK'
    | 'AGENT_5_EXECUTION'
    | 'AGENT_6_MONITOR';
  level: 'INFO' | 'WARN' | 'ERROR' | 'CRITICAL' | 'TRADE';
  message: string;
  symbol?: string;
}

export interface AgentCriticalError {
  id: string;
  at: number;
  symbol?: string;
  stage: string;
  message: string;
  resolved: boolean;
}

export interface DailyEquityState {
  dateUtc: string;
  startingEquity: number;
  peakEquity: number;
}

export interface PersistedAgentJournal {
  version: number;
  config: AgentEngineConfig;
  dailyEquity: DailyEquityState;
  lastTradeAt: number | null;
  lastProcessedCandles: Record<string, number>;
  cooldowns: Record<string, number>;
  trades: AgentTradeRecord[];
  learningSamples: LearningSample[];
  logs: AgentLogEntry[];
  criticalErrors: AgentCriticalError[];
}

export interface WalkForwardFold {
  fold: number;
  trainCount: number;
  testCount: number;
  trainWinRate: number;
  testWinRate: number;
  testNetPnl: number;
  testProfitFactor: number | null;
}

export interface WalkForwardReport {
  status: 'READY' | 'INSUFFICIENT_SAMPLES';
  minimumSamplesRequired: number;
  availableSamples: number;
  retrainPolicy: 'PERIODIC_OFFLINE_ONLY';
  dynamicRiskMutation: false;
  folds: WalkForwardFold[];
  summaryNote: string;
}

export interface PerformanceSummary {
  totalTrades: number;
  openTrades: number;
  closedTrades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  lossRate: number | null;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number | null;
  expectancyUsd: number | null;
  totalRealizedPnl: number;
  totalTradingFees: number;
  totalFundingFees: number;
  totalFees: number;
  netRealizedPnl: number;
  todayRealizedPnl: number;
  dailyStartingEquity: number;
  dailyDrawdownPct: number;
  maxDrawdownUsd: number;
  maxDrawdownPct: number;
  learningSampleCount: number;
  equityCurve: Array<{ time: number; cumulativePnl: number; drawdownUsd: number }>;
  walkForwardReport: WalkForwardReport;
}

const MAX_TRADES = 2000;
const MAX_SAMPLES = 2000;
const MAX_LOGS = 600;
const MAX_CRITICAL_ERRORS = 200;
const MIN_WALK_FORWARD_SAMPLES = 6;

function getStorageFilePath(): string {
  return (
    process.env.TURBOSCALP_AGENT_STORAGE_FILE ||
    path.resolve(process.cwd(), 'data', 'turboscalp-agent-journal.json')
  );
}

export function utcDateKey(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

const store: PersistedAgentJournal = {
  version: 2,
  config: { ...DEFAULT_AGENT_CONFIG },
  dailyEquity: {
    dateUtc: utcDateKey(),
    startingEquity: 0,
    peakEquity: 0,
  },
  lastTradeAt: null,
  lastProcessedCandles: {},
  cooldowns: {},
  trades: [],
  learningSamples: [],
  logs: [],
  criticalErrors: [],
};

let loaded = false;
let loadPromise: Promise<void> | null = null;
let persistChain: Promise<void> = Promise.resolve();

export async function ensureAgentStorageLoaded(): Promise<void> {
  if (loaded) return;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(getStorageFilePath(), 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedAgentJournal>;
        if (parsed.config) {
          store.config = sanitizeConfig(parsed.config);
        }
        store.lastTradeAt =
          typeof parsed.lastTradeAt === 'number' ? parsed.lastTradeAt : null;
        store.lastProcessedCandles =
          parsed.lastProcessedCandles &&
          typeof parsed.lastProcessedCandles === 'object'
            ? { ...parsed.lastProcessedCandles }
            : {};
        const now = Date.now();
        store.cooldowns = {};
        if (parsed.cooldowns && typeof parsed.cooldowns === 'object') {
          for (const [sym, until] of Object.entries(parsed.cooldowns)) {
            if (typeof until === 'number' && until > now) {
              store.cooldowns[sym] = until;
            }
          }
        }
        store.trades = Array.isArray(parsed.trades)
          ? parsed.trades.slice(-MAX_TRADES)
          : [];
        store.learningSamples = Array.isArray(parsed.learningSamples)
          ? parsed.learningSamples.slice(-MAX_SAMPLES)
          : [];
        store.logs = Array.isArray(parsed.logs)
          ? parsed.logs.slice(-MAX_LOGS)
          : [];
        store.criticalErrors = Array.isArray(parsed.criticalErrors)
          ? parsed.criticalErrors.slice(-MAX_CRITICAL_ERRORS)
          : [];
        if (parsed.dailyEquity && parsed.dailyEquity.dateUtc === utcDateKey()) {
          store.dailyEquity = {
            dateUtc: parsed.dailyEquity.dateUtc,
            startingEquity: Number(parsed.dailyEquity.startingEquity) || 0,
            peakEquity: Number(parsed.dailyEquity.peakEquity) || 0,
          };
        }
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          console.error('[agentStorage] failed to load journal:', err);
        }
      }
      loaded = true;
    })();
  }
  await loadPromise;
}

export function sanitizeConfig(
  partial: Partial<AgentEngineConfig>
): AgentEngineConfig {
  const clamp = (n: number, lo: number, hi: number) =>
    Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

  return {
    environment: 'USD_M_FUTURES_DEMO',
    minSignalScore: clamp(
      Number(partial.minSignalScore ?? DEFAULT_AGENT_CONFIG.minSignalScore),
      50,
      95
    ),
    riskPerTradePct: clamp(
      Number(partial.riskPerTradePct ?? DEFAULT_AGENT_CONFIG.riskPerTradePct),
      0.05,
      DEFAULT_AGENT_CONFIG.riskPerTradePct
    ),
    maxLeverage: Math.trunc(
      clamp(
        Number(partial.maxLeverage ?? DEFAULT_AGENT_CONFIG.maxLeverage),
        1,
        DEFAULT_AGENT_CONFIG.maxLeverage
      )
    ),
    maxOpenPositions: DEFAULT_AGENT_CONFIG.maxOpenPositions,
    maxOrderNotionalUsd: clamp(
      Number(
        partial.maxOrderNotionalUsd ?? DEFAULT_AGENT_CONFIG.maxOrderNotionalUsd
      ),
      5,
      DEFAULT_AGENT_CONFIG.maxOrderNotionalUsd
    ),
    maxDailyLossPct: clamp(
      Number(partial.maxDailyLossPct ?? DEFAULT_AGENT_CONFIG.maxDailyLossPct),
      0.25,
      DEFAULT_AGENT_CONFIG.maxDailyLossPct
    ),
    cooldownMinutes: clamp(
      Number(partial.cooldownMinutes ?? DEFAULT_AGENT_CONFIG.cooldownMinutes),
      5,
      240
    ),
    requireAiApproval: true, // GEMINI_REQUIRED is always enforced for automated Demo entries
    tradingPolicy:
      partial.tradingPolicy === 'QUANT_ONLY_PAPER' &&
      partial.quantOnlyPaperMode === true
        ? 'QUANT_ONLY_PAPER'
        : 'GEMINI_REQUIRED',
    quantOnlyPaperMode:
      partial.tradingPolicy === 'QUANT_ONLY_PAPER' ||
      partial.quantOnlyPaperMode === true
        ? Boolean(partial.quantOnlyPaperMode ?? (partial.tradingPolicy === 'QUANT_ONLY_PAPER'))
        : false,
    localAiApprovalEnabled: partial.localAiApprovalEnabled === true,
  };
}

export function persistAgentStorage(): Promise<void> {
  persistChain = persistChain
    .then(async () => {
      const target = getStorageFilePath();
      const dir = path.dirname(target);
      const tmp = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
      const payload: PersistedAgentJournal = {
        version: 2,
        config: store.config,
        dailyEquity: store.dailyEquity,
        lastTradeAt: store.lastTradeAt,
        lastProcessedCandles: store.lastProcessedCandles,
        cooldowns: store.cooldowns,
        trades: store.trades.slice(-MAX_TRADES),
        learningSamples: store.learningSamples.slice(-MAX_SAMPLES),
        logs: store.logs.slice(-MAX_LOGS),
        criticalErrors: store.criticalErrors.slice(-MAX_CRITICAL_ERRORS),
      };
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
      await fs.rename(tmp, target);
    })
    .catch((err) => {
      console.error('[agentStorage] persist failed:', err);
    });
  return persistChain;
}

export function getAgentConfig(): AgentEngineConfig {
  return { ...store.config };
}

export async function updateAgentConfig(
  partial: Partial<AgentEngineConfig>
): Promise<AgentEngineConfig> {
  await ensureAgentStorageLoaded();
  store.config = sanitizeConfig({ ...store.config, ...partial });
  await persistAgentStorage();
  return { ...store.config };
}

export function appendAgentLog(
  agent: AgentLogEntry['agent'],
  level: AgentLogEntry['level'],
  message: string,
  symbol?: string
): AgentLogEntry {
  const entry: AgentLogEntry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: Date.now(),
    agent,
    level,
    message,
    ...(symbol ? { symbol } : {}),
  };
  store.logs.push(entry);
  if (store.logs.length > MAX_LOGS) {
    store.logs = store.logs.slice(-MAX_LOGS);
  }
  void persistAgentStorage();
  return entry;
}

export function recordCriticalError(
  stage: string,
  message: string,
  symbol?: string
): AgentCriticalError {
  const err: AgentCriticalError = {
    id: `crit-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    at: Date.now(),
    ...(symbol ? { symbol } : {}),
    stage,
    message,
    resolved: false,
  };
  store.criticalErrors.push(err);
  if (store.criticalErrors.length > MAX_CRITICAL_ERRORS) {
    store.criticalErrors = store.criticalErrors.slice(-MAX_CRITICAL_ERRORS);
  }
  appendAgentLog('AGENT_5_EXECUTION', 'CRITICAL', `[${stage}] ${message}`, symbol);
  void persistAgentStorage();
  return err;
}

export function getCriticalErrors(limit = 50): AgentCriticalError[] {
  return store.criticalErrors
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export function syncDailyEquity(currentEquity: number): DailyEquityState {
  const today = utcDateKey();
  if (store.dailyEquity.dateUtc !== today) {
    store.dailyEquity = {
      dateUtc: today,
      startingEquity: currentEquity > 0 ? currentEquity : 0,
      peakEquity: currentEquity > 0 ? currentEquity : 0,
    };
    void persistAgentStorage();
  } else if (currentEquity > 0) {
    if (store.dailyEquity.startingEquity <= 0) {
      store.dailyEquity.startingEquity = currentEquity;
      store.dailyEquity.peakEquity = currentEquity;
      void persistAgentStorage();
    } else if (currentEquity > store.dailyEquity.peakEquity) {
      store.dailyEquity.peakEquity = currentEquity;
      void persistAgentStorage();
    }
  }
  return { ...store.dailyEquity };
}

export function getDailyEquityState(): DailyEquityState {
  const today = utcDateKey();
  if (store.dailyEquity.dateUtc !== today) {
    return { dateUtc: today, startingEquity: 0, peakEquity: 0 };
  }
  return { ...store.dailyEquity };
}

export function getSymbolCooldown(symbol: string): number | null {
  const until = store.cooldowns[symbol];
  if (!until) return null;
  if (Date.now() >= until) {
    delete store.cooldowns[symbol];
    return null;
  }
  return until;
}

export async function startSymbolCooldown(
  symbol: string,
  minutes = store.config.cooldownMinutes
): Promise<number> {
  await ensureAgentStorageLoaded();
  const until = Date.now() + Math.max(1, minutes) * 60_000;
  store.cooldowns[symbol] = until;
  await persistAgentStorage();
  return until;
}

export function getLastProcessedCandle(symbol: string): number | null {
  return store.lastProcessedCandles[symbol] ?? null;
}

export function setLastProcessedCandle(symbol: string, closeTimeMs: number): void {
  store.lastProcessedCandles[symbol] = closeTimeMs;
}

export function hasClientOrderId(clientOrderId: string): boolean {
  return store.trades.some(
    (t) =>
      t.entryClientOrderId === clientOrderId ||
      t.stopClientAlgoId === clientOrderId ||
      t.targetClientAlgoId === clientOrderId
  );
}

export function getLastTradeAt(): number | null {
  return store.lastTradeAt;
}

export async function recordTradeOpened(trade: AgentTradeRecord): Promise<void> {
  await ensureAgentStorageLoaded();
  store.lastTradeAt = trade.openedAt;
  store.trades.push(trade);
  if (store.trades.length > MAX_TRADES) {
    store.trades = store.trades.slice(-MAX_TRADES);
  }
  await persistAgentStorage();
}

export function getActiveTradeRecord(): AgentTradeRecord | null {
  const open = store.trades.filter((t) => t.status === 'OPEN');
  return open.length > 0 ? open[open.length - 1] : null;
}

export function getRecentTrades(limit = 50): AgentTradeRecord[] {
  return store.trades
    .slice()
    .sort((a, b) => b.openedAt - a.openedAt)
    .slice(0, limit);
}

export function getRecentLogs(limit = 150): AgentLogEntry[] {
  return store.logs
    .slice()
    .sort((a, b) => b.at - a.at)
    .slice(0, limit);
}

export function getLearningSamples(limit = 200): LearningSample[] {
  return store.learningSamples.slice(-limit);
}

export async function updateOpenTradeMetrics(
  tradeId: string,
  updates: Partial<
    Pick<
      AgentTradeRecord,
      | 'markPrice'
      | 'unrealizedPnl'
      | 'executedQuantity'
      | 'entryPrice'
      | 'stopAlgoId'
      | 'targetAlgoId'
      | 'stopStatus'
      | 'takeProfitStatus'
      | 'executionStatus'
      | 'fundingFees'
    >
  >
): Promise<void> {
  await ensureAgentStorageLoaded();
  const trade = store.trades.find((t) => t.id === tradeId);
  if (!trade) return;
  Object.assign(trade, updates);
  await persistAgentStorage();
}

export async function recordTradeClosed(
  tradeId: string,
  params: {
    status: 'CLOSED' | 'EMERGENCY_CLOSED';
    exitPrice: number | null;
    realizedPnl: number;
    tradingFees: number;
    fundingFees?: number;
    closeReason: string;
    executionStatus?: ExecutionLifecycleStatus;
  }
): Promise<AgentTradeRecord | null> {
  await ensureAgentStorageLoaded();
  const trade = store.trades.find((t) => t.id === tradeId);
  if (!trade) return null;

  const tradingFees = Math.abs(params.tradingFees);
  const fundingFees = params.fundingFees ?? trade.fundingFees ?? 0;
  const totalCommission = tradingFees;
  const netPnl = params.realizedPnl - tradingFees + fundingFees;
  const closedAt = Date.now();

  trade.status = params.status;
  trade.executionStatus = params.executionStatus ?? 'CLOSED';
  trade.exitPrice = params.exitPrice;
  trade.realizedPnl = params.realizedPnl;
  trade.tradingFees = tradingFees;
  trade.fundingFees = fundingFees;
  trade.commission = totalCommission;
  trade.netPnl = netPnl;
  trade.unrealizedPnl = 0;
  trade.closedAt = closedAt;
  trade.closeReason = params.closeReason;

  const outcome: LearningSample['outcome'] =
    netPnl > 1e-6 ? 'WIN' : netPnl < -1e-6 ? 'LOSS' : 'FLAT';
  const returnPct =
    trade.notionalUsd > 0 ? (netPnl / trade.notionalUsd) * 100 : 0;

  store.learningSamples.push({
    id: `sample-${trade.id}`,
    tradeId: trade.id,
    symbol: trade.symbol,
    side: trade.side,
    outcome,
    netPnl,
    returnPct,
    holdingMs: Math.max(0, closedAt - trade.openedAt),
    recordedAt: closedAt,
    features: trade.signalSnapshot,
  });

  if (store.learningSamples.length > MAX_SAMPLES) {
    store.learningSamples = store.learningSamples.slice(-MAX_SAMPLES);
  }

  await persistAgentStorage();
  return trade;
}

export function getTodayRealizedPnl(): number {
  const today = utcDateKey();
  return store.trades
    .filter(
      (t) =>
        t.status !== 'OPEN' &&
        t.closedAt &&
        utcDateKey(t.closedAt) === today &&
        t.netPnl !== null
    )
    .reduce((sum, t) => sum + (t.netPnl ?? 0), 0);
}

export function buildWalkForwardReport(
  samples: LearningSample[]
): WalkForwardReport {
  const ordered = samples
    .slice()
    .sort((a, b) => a.recordedAt - b.recordedAt);

  if (ordered.length < MIN_WALK_FORWARD_SAMPLES) {
    return {
      status: 'INSUFFICIENT_SAMPLES',
      minimumSamplesRequired: MIN_WALK_FORWARD_SAMPLES,
      availableSamples: ordered.length,
      retrainPolicy: 'PERIODIC_OFFLINE_ONLY',
      dynamicRiskMutation: false,
      folds: [],
      summaryNote: `Collected ${ordered.length}/${MIN_WALK_FORWARD_SAMPLES} closed trade samples required for chronological walk-forward folds. Live risk limits remain locked.`,
    };
  }

  const folds: WalkForwardFold[] = [];
  const foldCount = Math.min(3, Math.floor(ordered.length / 3));
  const testSize = Math.max(2, Math.floor(ordered.length / (foldCount + 1)));

  for (let i = 0; i < foldCount; i++) {
    const trainEnd = ordered.length - (foldCount - i) * testSize;
    const testEnd = trainEnd + testSize;
    if (trainEnd < 2) continue;

    const trainSlice = ordered.slice(0, trainEnd);
    const testSlice = ordered.slice(trainEnd, testEnd);
    if (testSlice.length === 0) continue;

    const trainWins = trainSlice.filter((s) => s.outcome === 'WIN').length;
    const testWins = testSlice.filter((s) => s.outcome === 'WIN').length;
    const testGrossWin = testSlice
      .filter((s) => s.netPnl > 0)
      .reduce((acc, s) => acc + s.netPnl, 0);
    const testGrossLoss = Math.abs(
      testSlice
        .filter((s) => s.netPnl < 0)
        .reduce((acc, s) => acc + s.netPnl, 0)
    );
    const testNetPnl = testSlice.reduce((acc, s) => acc + s.netPnl, 0);

    folds.push({
      fold: folds.length + 1,
      trainCount: trainSlice.length,
      testCount: testSlice.length,
      trainWinRate: Number(((trainWins / trainSlice.length) * 100).toFixed(1)),
      testWinRate: Number(((testWins / testSlice.length) * 100).toFixed(1)),
      testNetPnl: Number(testNetPnl.toFixed(4)),
      testProfitFactor:
        testGrossLoss > 0
          ? Number((testGrossWin / testGrossLoss).toFixed(2))
          : testGrossWin > 0
            ? 99
            : null,
    });
  }

  return {
    status: 'READY',
    minimumSamplesRequired: MIN_WALK_FORWARD_SAMPLES,
    availableSamples: ordered.length,
    retrainPolicy: 'PERIODIC_OFFLINE_ONLY',
    dynamicRiskMutation: false,
    folds,
    summaryNote: `Prepared ${folds.length} chronological walk-forward fold(s) across ${ordered.length} closed trades for periodic evaluation. Live risk limits cannot be auto-escalated.`,
  };
}

export function getPerformanceSummary(currentEquity = 0): PerformanceSummary {
  const closed = store.trades
    .filter((t) => t.status !== 'OPEN' && t.netPnl !== null)
    .slice()
    .sort((a, b) => (a.closedAt ?? a.openedAt) - (b.closedAt ?? b.openedAt));

  const openTrades = store.trades.filter((t) => t.status === 'OPEN').length;
  const wins = closed.filter((t) => (t.netPnl ?? 0) > 0).length;
  const losses = closed.filter((t) => (t.netPnl ?? 0) < 0).length;
  const grossProfit = closed
    .filter((t) => (t.netPnl ?? 0) > 0)
    .reduce((sum, t) => sum + (t.netPnl ?? 0), 0);
  const grossLoss = Math.abs(
    closed
      .filter((t) => (t.netPnl ?? 0) < 0)
      .reduce((sum, t) => sum + (t.netPnl ?? 0), 0)
  );
  const totalRealizedPnl = closed.reduce(
    (sum, t) => sum + (t.realizedPnl ?? 0),
    0
  );
  const totalTradingFees = closed.reduce(
    (sum, t) => sum + (t.tradingFees ?? t.commission ?? 0),
    0
  );
  const totalFundingFees = closed.reduce(
    (sum, t) => sum + (t.fundingFees ?? 0),
    0
  );
  const netRealizedPnl = closed.reduce((sum, t) => sum + (t.netPnl ?? 0), 0);

  let cumulative = 0;
  let peak = 0;
  let maxDrawdownUsd = 0;
  const equityCurve: PerformanceSummary['equityCurve'] = [];

  for (const t of closed) {
    cumulative += t.netPnl ?? 0;
    if (cumulative > peak) peak = cumulative;
    const dd = peak - cumulative;
    if (dd > maxDrawdownUsd) maxDrawdownUsd = dd;
    equityCurve.push({
      time: t.closedAt ?? t.openedAt,
      cumulativePnl: Number(cumulative.toFixed(4)),
      drawdownUsd: Number(dd.toFixed(4)),
    });
  }

  const daily = getDailyEquityState();
  const baseEquity =
    daily.startingEquity > 0 ? daily.startingEquity : currentEquity;
  const maxDrawdownPct =
    baseEquity > 0 ? (maxDrawdownUsd / baseEquity) * 100 : 0;
  const todayRealizedPnl = getTodayRealizedPnl();
  const dailyDrawdownPct =
    daily.startingEquity > 0 && currentEquity > 0
      ? Math.max(
          0,
          ((daily.startingEquity - currentEquity) / daily.startingEquity) * 100
        )
      : 0;

  return {
    totalTrades: store.trades.length,
    openTrades,
    closedTrades: closed.length,
    wins,
    losses,
    winRate:
      closed.length > 0
        ? Number(((wins / closed.length) * 100).toFixed(1))
        : null,
    lossRate:
      closed.length > 0
        ? Number(((losses / closed.length) * 100).toFixed(1))
        : null,
    grossProfit: Number(grossProfit.toFixed(4)),
    grossLoss: Number(grossLoss.toFixed(4)),
    profitFactor:
      grossLoss > 0
        ? Number((grossProfit / grossLoss).toFixed(2))
        : grossProfit > 0
          ? 99
          : null,
    expectancyUsd:
      closed.length > 0
        ? Number((netRealizedPnl / closed.length).toFixed(4))
        : null,
    totalRealizedPnl: Number(totalRealizedPnl.toFixed(4)),
    totalTradingFees: Number(totalTradingFees.toFixed(4)),
    totalFundingFees: Number(totalFundingFees.toFixed(4)),
    totalFees: Number(totalTradingFees.toFixed(4)),
    netRealizedPnl: Number(netRealizedPnl.toFixed(4)),
    todayRealizedPnl: Number(todayRealizedPnl.toFixed(4)),
    dailyStartingEquity: Number(daily.startingEquity.toFixed(2)),
    dailyDrawdownPct: Number(dailyDrawdownPct.toFixed(2)),
    maxDrawdownUsd: Number(maxDrawdownUsd.toFixed(4)),
    maxDrawdownPct: Number(maxDrawdownPct.toFixed(2)),
    learningSampleCount: store.learningSamples.length,
    equityCurve,
    walkForwardReport: buildWalkForwardReport(store.learningSamples),
  };
}

// ── Non-blocking Server-Side Telegram Notifier ──────────────────────────

export type TelegramEventType =
  | 'SIGNAL_APPROVED'
  | 'RISK_REJECTED'
  | 'DEMO_ORDER_EXECUTED'
  | 'SL_CONFIRMED'
  | 'TP_CONFIRMED'
  | 'POSITION_CLOSED'
  | 'DAILY_LOSS_LIMIT'
  | 'CRITICAL_FAILURE';

const TELEGRAM_DEDUPE_MS = 60_000;
const recentTelegramKeys = new Map<string, number>();

export async function notifyTelegramEvent(
  eventType: TelegramEventType,
  text: string,
  dedupeKey?: string
): Promise<boolean> {
  const token = (process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const chatId = (process.env.TELEGRAM_CHAT_ID || '').trim();
  if (!token || !chatId) return false;

  if (dedupeKey) {
    const prev = recentTelegramKeys.get(dedupeKey);
    if (prev && Date.now() - prev < TELEGRAM_DEDUPE_MS) {
      return false;
    }
    recentTelegramKeys.set(dedupeKey, Date.now());
  }

  try {
    const safeText = `[TURBOSCALP DEMO · ${eventType}]\n${text}`.slice(0, 3800);
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        chat_id: chatId,
        text: safeText,
        disable_web_page_preview: true,
      },
      { timeout: 5_000 }
    );
    return true;
  } catch (err: any) {
    // Non-blocking: Telegram failures must never interfere with exchange risk protection.
    console.warn('[telegram] notification skipped:', err?.message || 'error');
    return false;
  }
}
