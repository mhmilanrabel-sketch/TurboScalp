export type Timeframe = '1m' | '5m' | '15m' | '1h' | '4h' | '1d';

export type SignalDirection = 'BUY (LONG)' | 'SELL (SHORT)' | 'BUY' | 'SELL';

export type SignalStatus = 'ACTIVE' | 'TP1_HIT' | 'TP2_HIT' | 'TP3_HIT' | 'SL_HIT' | 'CLOSED' | 'CANCELLED';

export interface ConfluenceIndicator {
  name: string;
  value: string;
  status: 'bullish' | 'bearish' | 'neutral';
  description: string;
}

export interface TradeSignal {
  id: string;
  symbol: string;
  name: string;
  assetClass: 'Crypto';
  direction: 'BUY (LONG)' | 'SELL (SHORT)';
  status: SignalStatus;
  timeframe: Timeframe;
  currentPrice: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit1: number;
  takeProfit2: number;
  takeProfit3?: number;
  targetPrice: number;
  riskRewardRatio: number;
  confidenceScore: number; // 0 - 100
  pnlPercentage: number;
  pnlUsd?: number;
  confluences: ConfluenceIndicator[];
  reasoning: string;
  chartPattern?: string;
  volume24h?: string;
  startTime: number;
  closedTime?: number;
  exitPrice?: number;
  executionMode: 'AUTO_PILOT' | 'MANUAL_PUSH';
  leverage?: number;
  positionSizeUsd?: number;
  breakevenApplied?: boolean;
}

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  ema20?: number;
  ema50?: number;
  ema200?: number;
  rsi?: number;
  bbUpper?: number;
  bbMiddle?: number;
  bbLower?: number;
  macd?: {
    macd: number;
    signal: number;
    histogram: number;
  };
}

export interface MarketAsset {
  symbol: string;
  name: string;
  price: number;
  change24h: number;
  high24h: number;
  low24h: number;
  volume24h: string;
  rawVolume?: number;
  digits?: number;
  sparkline?: number[];
  rsi?: number;
  emaTrend?: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  macdCross?: 'BULLISH' | 'BEARISH' | 'NONE';
  confluenceScore?: number;
  lastScanned?: number;
}

export interface AutoPilotConfig {
  enabled: boolean;
  scanIntervalSec: number;
  minConfidenceScore: number;
  allowedDirections: 'BOTH' | 'LONG_ONLY' | 'SHORT_ONLY';
  maxOpenTrades: number;
  tradeSizeUsd: number;
  leverage: number;
  tp1Percent: number;
  tp2Percent: number;
  tp3Percent: number;
  slPercent: number;
  autoMoveBreakevenAtTp1: boolean;
  selectedPairs: string[];
}

export interface BinanceApiSettings {
  apiKey: string;
  apiSecret: string;
  isConfigured: boolean;
  network: 'DEMO_PAPER' | 'BINANCE_TESTNET' | 'BINANCE_LIVE';
  tradingType: 'SPOT' | 'FUTURES_USDM';
  usdtBalance: number;
  demoBalance: number;
}

export interface TradeAlert {
  id: string;
  type: 'SIGNAL_DETECTED' | 'PUSH_EXECUTED' | 'TP_HIT' | 'SL_HIT' | 'CUSTOM_PRICE' | 'INFO';
  title: string;
  message: string;
  symbol: string;
  timestamp: string;
  timeMs: number;
  read: boolean;
  level: 'success' | 'warning' | 'danger' | 'info';
}

export interface CustomAlertRule {
  id: string;
  symbol: string;
  condition: 'PRICE_ABOVE' | 'PRICE_BELOW' | 'RSI_OVERSOLD' | 'RSI_OVERBOUGHT' | 'CONFLUENCE_HIGH';
  targetValue: number;
  triggered: boolean;
  active: boolean;
  createdAt: number;
}

export interface PerformanceStats {
  winRate: number;
  totalSignals: number;
  winningSignals: number;
  losingSignals: number;
  profitFactor: number;
  averageRiskReward: string;
  netProfitPercentage: number;
  netProfitUsd: number;
  bestTradePercentage: number;
  maxDrawdownPercentage: number;
  averageDuration: string;
}

export interface ClosedSignal {
  id: string;
  symbol: string;
  direction: 'BUY (LONG)' | 'SELL (SHORT)';
  timeframe: Timeframe;
  entryPrice: number;
  exitPrice: number;
  pnlPercentage: number;
  pnlUsd: number;
  outcome: 'TP1' | 'TP2' | 'TP3' | 'SL' | 'MANUAL';
  closedAt: string;
  holdingTime: string;
  executionMode: 'AUTO_PILOT' | 'MANUAL_PUSH';
  leverage: number;
}

// ======================================================
// MULTI-AGENT AUTONOMOUS ENGINE TYPES (BINANCE DEMO)
// ======================================================

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
export type EngineRunMode = 'STOPPED' | 'SCAN_ONLY' | 'AUTO_TRADING' | 'PAUSED';
export type GeminiManagerStatus =
  | 'STANDBY'
  | 'ACTIVE'
  | 'FALLBACK_ACTIVE'
  | 'OVERLOADED'
  | 'RECOVERING'
  | 'DEGRADED'
  | 'QUOTA_EXHAUSTED';
export type GeminiPrimaryStatus =
  | 'STANDBY'
  | 'ACTIVE'
  | 'OVERLOADED'
  | 'RECOVERING'
  | 'DEGRADED';
export type GeminiFallbackStatus = 'STANDBY' | 'ACTIVE' | 'DEGRADED' | 'DISABLED';
export type GeminiErrorCategory =
  | 'NONE'
  | 'CAPACITY_503'
  | 'QUOTA_429'
  | 'RATE_LIMIT_429'
  | 'TIMEOUT_504'
  | 'INVALID_ARGUMENT_400'
  | 'AUTH_401_403'
  | 'NETWORK_ERROR'
  | 'CONFIG_ERROR'
  | 'SCHEMA_ERROR';
export type TradingPolicyMode = 'GEMINI_REQUIRED' | 'QUANT_ONLY_PAPER';

export interface AgentUnitStatus {
  id: AgentName;
  label: string;
  role: string;
  status: AgentHealthState;
  lastRunAt: number | null;
  detail: string;
}

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
}

export interface QuantAnalysisResult {
  symbol: string;
  direction: 'BUY' | 'SELL' | 'HOLD';
  heuristicScore: number;
  signalStrengthScore: number;
  minScoreRequired: number;
  price: number;
  change24h: number;
  quoteVolume: number;
  ema9_15m: number;
  ema21_15m: number;
  ema50_15m: number;
  ema9_5m: number;
  ema21_5m: number;
  ema50_5m: number;
  rsi14: number;
  rsi5m: number;
  macd: number;
  macdSignal: number;
  macdHistogram: number;
  atr14: number;
  volatilityPct: number;
  volumeRatio: number;
  trendStrength: number;
  supportLevel: number;
  resistanceLevel: number;
  breakout: 'BULLISH_BREAKOUT' | 'BEARISH_BREAKOUT' | 'NONE';
  mtfAligned: boolean;
  marketStructure: 'UPTREND_HH_HL' | 'DOWNTREND_LH_LL' | 'RANGING';
  unusualVolume: boolean;
  unusualVolatility: boolean;
  stopLoss: number | null;
  takeProfit: number | null;
  reasons: string[];
  latestClosedCandleTime: number;
  fetchedAt: number;
}

export interface GeminiAnalysisResult {
  symbol: string;
  available: boolean;
  degraded: boolean;
  quotaExhausted?: boolean;
  fromCache?: boolean;
  modelUsed?: string;
  usedFallback?: boolean;
  errorCategory?: GeminiErrorCategory;
  direction: 'BUY' | 'SELL' | 'HOLD';
  marketRegime: 'TRENDING' | 'SIDEWAYS' | 'VOLATILE' | 'CONFLICTED';
  confidence: number;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  riskFlags: string[];
  reasoning: string;
  error?: string;
  analyzedAt: number;
}

export interface GeminiQuotaStatusSnapshot {
  status: GeminiManagerStatus;
  model: string;
  primaryModel: string;
  primaryStatus: GeminiPrimaryStatus;
  fallbackModel: string | null;
  fallbackVerified: boolean;
  fallbackStatus: GeminiFallbackStatus;
  fallbackActive: boolean;
  lastRespondedModel: string | null;
  requestsUsedToday: number;
  maxDailyRequests: number;
  pendingRequests: number;
  cachedAnalysesCount: number;
  lastSuccessfulAnalysisAt: number | null;
  lastApiError: string | null;
  lastErrorCode: string | null;
  lastErrorCategory: GeminiErrorCategory;
  geminiBlockedUntil: number | null;
  primaryCircuitOpenUntil: number | null;
  consecutive503Cycles: number;
  nextRetryAt: number | null;
  candidatesAwaitingAnalysis: number;
  quotaMessage: string | null;
  promptVersion: string;
  featureVersion: string;
  dateUtc: string;
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

export interface OpportunitySnapshot {
  symbol: string;
  quant: QuantAnalysisResult;
  aiAnalysis: GeminiAnalysisResult | null;
  riskDecision: RiskDecision | null;
}

export interface AgentTradeRecord {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  positionMode: 'ONE_WAY' | 'HEDGE';
  positionSide: 'BOTH' | 'LONG' | 'SHORT';
  status: 'OPEN' | 'CLOSED' | 'EMERGENCY_CLOSED';
  executionStatus: string;
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
}

export interface AgentLogEntry {
  id: string;
  at: number;
  agent: string;
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

export interface AgentPerformanceSummary {
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
  walkForwardReport: {
    status: 'READY' | 'INSUFFICIENT_SAMPLES';
    minimumSamplesRequired: number;
    availableSamples: number;
    retrainPolicy: string;
    dynamicRiskMutation: false;
    folds: Array<{
      fold: number;
      trainCount: number;
      testCount: number;
      trainWinRate: number;
      testWinRate: number;
      testNetPnl: number;
      testProfitFactor: number | null;
    }>;
    summaryNote: string;
  };
}

export interface AgentStatusResponse {
  success: boolean;
  environment: 'USD_M_FUTURES_DEMO';
  liveTradingEnabled: false;
  mode: EngineRunMode;
  autoTradingEnabled: boolean;
  demoExplicitlyConfirmed: boolean;
  credentialsBound: boolean;
  permissionDiagnostics?: import('./utils/permissionDiagnostics').FuturesPermissionDiagnostics | null;
  config: AgentEngineConfig;
  riskLimits: {
    RISK_PER_TRADE_PCT: number;
    MAX_LEVERAGE: number;
    MAX_OPEN_POSITIONS: number;
    MAX_ORDER_NOTIONAL_USD: number;
    MAX_DAILY_LOSS_PCT: number;
    MIN_SIGNAL_SCORE: number;
    COOLDOWN_MINUTES: number;
  };
  lastScanAt: number | null;
  lastTradeAt: number | null;
  scanProgress: {
    scanning: boolean;
    totalTargets: number;
    completedTargets: number;
    unusualMoversCount: number;
    stageLabel: string;
  };
  agents: AgentUnitStatus[];
  opportunities: {
    bestBuy: OpportunitySnapshot | null;
    bestSell: OpportunitySnapshot | null;
    scannedTopCount: number;
    candidates: QuantAnalysisResult[];
  };
  aiAnalysis: { symbol: string; result: GeminiAnalysisResult } | null;
  geminiStatus?: GeminiQuotaStatusSnapshot;
  riskDecision: RiskDecision | null;
  activeTrade: AgentTradeRecord | null;
  exchangePositions: Array<{
    symbol: string;
    positionSide: string;
    positionAmt: number;
    entryPrice: number;
    markPrice: number;
    unRealizedProfit: number;
    leverage: number;
  }>;
  exchangeOpenOrdersCount: number;
  recentTrades: AgentTradeRecord[];
  criticalErrors: AgentCriticalError[];
  todayRealizedPnl: number;
  unrealizedPnl: number;
  performance: AgentPerformanceSummary;
  lastError: string | null;
  updatedAt: number;
}
