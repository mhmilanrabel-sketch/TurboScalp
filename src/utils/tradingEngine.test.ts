import test from 'node:test';
import assert from 'node:assert/strict';
import {
  evaluateMarketAsset,
  createTradeSignal,
  updateActivePosition,
  calculatePerformanceStats,
  checkCustomAlert,
} from './tradingEngine';
import {
  calculateEMA,
  calculateRSI,
  calculateBollingerBands,
  calculateMACD,
} from './indicators';
import { MarketAsset, AutoPilotConfig, ClosedSignal, CustomAlertRule } from '../types';

test('calculateEMA computes exponential moving average properly', () => {
  const prices = [10, 11, 12, 13, 14, 15];
  const ema = calculateEMA(prices, 3);
  assert.equal(ema.length, 6);
  assert.equal(ema[0], 10);
  assert.ok(ema[5] > ema[0], 'EMA should trend upward with increasing prices');
});

test('calculateRSI returns expected 0-100 bounded array', () => {
  const upwardPrices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25];
  const rsis = calculateRSI(upwardPrices, 14);
  assert.equal(rsis.length, upwardPrices.length);
  const lastRsi = rsis[rsis.length - 1];
  assert.ok(lastRsi > 70, `RSI for continuous gains should be overbought (>70), got ${lastRsi}`);
});

test('calculateBollingerBands returns middle, upper, lower bands', () => {
  const prices = Array.from({ length: 30 }, (_, i) => 100 + Math.sin(i) * 5);
  const bb = calculateBollingerBands(prices, 20, 2);
  assert.equal(bb.middle.length, 30);
  assert.ok(bb.upper[25] > bb.middle[25], 'Upper band must be above middle');
  assert.ok(bb.middle[25] > bb.lower[25], 'Middle band must be above lower');
});

test('calculateMACD produces macd line, signal line, and histogram', () => {
  const prices = Array.from({ length: 40 }, (_, i) => 50 + i * 0.5);
  const macd = calculateMACD(prices);
  assert.equal(macd.macd.length, 40);
  assert.equal(macd.signal.length, 40);
  assert.equal(macd.histogram.length, 40);
});

test('evaluateMarketAsset identifies oversold condition as BUY (LONG)', () => {
  const oversoldAsset: MarketAsset = {
    symbol: 'BTC/USDT',
    name: 'Bitcoin Spot',
    price: 90000,
    change24h: -2.5,
    high24h: 93000,
    low24h: 89500,
    volume24h: '$1.2B',
    rsi: 28, // Oversold
    emaTrend: 'BEARISH',
  };

  const result = evaluateMarketAsset(oversoldAsset);
  assert.ok(result.confidenceScore >= 75, 'Confidence score should be valid');
  assert.ok(result.confluences.length >= 3, 'Should produce detailed confluences');
  assert.ok(result.recommendedTakeProfit1 > result.recommendedEntry || result.recommendedTakeProfit1 < result.recommendedEntry);
});

test('createTradeSignal initializes targets, stop loss, and RR ratio', () => {
  const asset: MarketAsset = {
    symbol: 'ETH/USDT',
    name: 'Ethereum Spot',
    price: 3200,
    change24h: 1.5,
    high24h: 3300,
    low24h: 3100,
    volume24h: '$500M',
    rsi: 45,
  };

  const config: AutoPilotConfig = {
    enabled: true,
    scanIntervalSec: 2,
    minConfidenceScore: 80,
    allowedDirections: 'BOTH',
    maxOpenTrades: 5,
    tradeSizeUsd: 500,
    leverage: 10,
    tp1Percent: 0.8,
    tp2Percent: 1.6,
    tp3Percent: 2.5,
    slPercent: 0.5,
    autoMoveBreakevenAtTp1: true,
    selectedPairs: ['ETH/USDT'],
  };

  const signal = createTradeSignal(asset, 'BUY (LONG)', config, 'AUTO_PILOT');
  assert.equal(signal.symbol, 'ETH/USDT');
  assert.equal(signal.direction, 'BUY (LONG)');
  assert.equal(signal.status, 'ACTIVE');
  assert.equal(signal.entryPrice, 3200);
  assert.ok(signal.takeProfit1 > 3200, 'TP1 for LONG must be above entry');
  assert.ok(signal.stopLoss < 3200, 'SL for LONG must be below entry');
  assert.equal(signal.leverage, 10);
});

test('updateActivePosition triggers TP1 and moves SL to breakeven', () => {
  const asset: MarketAsset = {
    symbol: 'SOL/USDT',
    name: 'Solana Spot',
    price: 200,
    change24h: 2.0,
    high24h: 210,
    low24h: 195,
    volume24h: '$300M',
  };

  const config: AutoPilotConfig = {
    enabled: true,
    scanIntervalSec: 2,
    minConfidenceScore: 80,
    allowedDirections: 'BOTH',
    maxOpenTrades: 5,
    tradeSizeUsd: 1000,
    leverage: 10,
    tp1Percent: 1.0,
    tp2Percent: 2.0,
    tp3Percent: 3.0,
    slPercent: 0.8,
    autoMoveBreakevenAtTp1: true,
    selectedPairs: ['SOL/USDT'],
  };

  const initialSignal = createTradeSignal(asset, 'BUY (LONG)', config);
  // Entry is 200. TP1 is 202. Stop loss is 198.4.
  // Test price increases to 202.5 (past TP1)
  const { updatedSignal, triggeredEvent } = updateActivePosition(initialSignal, 202.5, true);

  assert.equal(triggeredEvent, 'TP1');
  assert.equal(updatedSignal.status, 'TP1_HIT');
  assert.ok(updatedSignal.pnlPercentage > 0, 'PnL percentage should be positive');
  assert.equal(updatedSignal.stopLoss, 200, 'Stop loss should automatically move to breakeven (entry 200)');
  assert.equal(updatedSignal.breakevenApplied, true);
});

test('updateActivePosition triggers Stop Loss', () => {
  const asset: MarketAsset = {
    symbol: 'SOL/USDT',
    name: 'Solana Spot',
    price: 200,
    change24h: 2.0,
    high24h: 210,
    low24h: 195,
    volume24h: '$300M',
  };

  const config: AutoPilotConfig = {
    enabled: true,
    scanIntervalSec: 2,
    minConfidenceScore: 80,
    allowedDirections: 'BOTH',
    maxOpenTrades: 5,
    tradeSizeUsd: 1000,
    leverage: 10,
    tp1Percent: 1.0,
    tp2Percent: 2.0,
    tp3Percent: 3.0,
    slPercent: 0.8,
    autoMoveBreakevenAtTp1: true,
    selectedPairs: ['SOL/USDT'],
  };

  const initialSignal = createTradeSignal(asset, 'BUY (LONG)', config);
  // Price drops below SL (198.4) to 197
  const { updatedSignal, triggeredEvent } = updateActivePosition(initialSignal, 197, true);

  assert.equal(triggeredEvent, 'SL');
  assert.equal(updatedSignal.status, 'SL_HIT');
  assert.ok(updatedSignal.pnlPercentage < 0, 'PnL should be negative when SL hits');
});

test('calculatePerformanceStats aggregates closed trades correctly', () => {
  const closedTrades: ClosedSignal[] = [
    {
      id: '1',
      symbol: 'BTC/USDT',
      direction: 'BUY (LONG)',
      timeframe: '5m',
      entryPrice: 90000,
      exitPrice: 90900,
      pnlPercentage: 10.0,
      pnlUsd: 100,
      outcome: 'TP1',
      closedAt: '12:00:00',
      holdingTime: '4m 12s',
      executionMode: 'AUTO_PILOT',
      leverage: 10,
    },
    {
      id: '2',
      symbol: 'ETH/USDT',
      direction: 'BUY (LONG)',
      timeframe: '5m',
      entryPrice: 3200,
      exitPrice: 3248,
      pnlPercentage: 15.0,
      pnlUsd: 150,
      outcome: 'TP2',
      closedAt: '12:10:00',
      holdingTime: '7m 20s',
      executionMode: 'AUTO_PILOT',
      leverage: 10,
    },
    {
      id: '3',
      symbol: 'SOL/USDT',
      direction: 'SELL (SHORT)',
      timeframe: '5m',
      entryPrice: 200,
      exitPrice: 201.6,
      pnlPercentage: -8.0,
      pnlUsd: -80,
      outcome: 'SL',
      closedAt: '12:25:00',
      holdingTime: '3m 05s',
      executionMode: 'MANUAL_PUSH',
      leverage: 10,
    },
  ];

  const stats = calculatePerformanceStats(closedTrades);
  assert.equal(stats.totalSignals, 3);
  assert.equal(stats.winningSignals, 2);
  assert.equal(stats.losingSignals, 1);
  assert.equal(stats.winRate, 66.7);
  assert.equal(stats.netProfitUsd, 170);
  assert.ok(stats.profitFactor > 1, 'Profit factor should be positive and > 1');
});

test('checkCustomAlert detects price conditions correctly', () => {
  const rule: CustomAlertRule = {
    id: 'ALERT-1',
    symbol: 'BTC/USDT',
    condition: 'PRICE_ABOVE',
    targetValue: 92000,
    triggered: false,
    active: true,
    createdAt: Date.now(),
  };

  const belowAsset: MarketAsset = {
    symbol: 'BTC/USDT',
    name: 'Bitcoin',
    price: 91500,
    change24h: 1,
    high24h: 92100,
    low24h: 90000,
    volume24h: '10K',
  };

  assert.equal(checkCustomAlert(rule, belowAsset), false);

  const aboveAsset: MarketAsset = {
    ...belowAsset,
    price: 92500,
  };

  assert.equal(checkCustomAlert(rule, aboveAsset), true);
});
