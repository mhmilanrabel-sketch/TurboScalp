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
