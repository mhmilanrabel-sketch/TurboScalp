// server/agent/quantAnalyst.ts
// Agent 2 – Quantitative Analysis Agent
// Calculates EMA 9/21/50, RSI 14, MACD + signal, ATR 14, volume ratio,
// volatility %, trend strength, support/resistance, breakout confirmation,
// and multi-timeframe trend alignment on closed candles only.
// Heuristic scores are NEVER represented as statistically validated win probabilities.

import { calculateRSI, clampValue, ema, type RawKline } from '../quantRoutes.js';
import type { DiscoveredMarket } from './marketDiscovery.js';

export interface QuantAnalysisResult {
  symbol: string;
  direction: 'BUY' | 'SELL' | 'HOLD';
  heuristicScore: number; // -100 to +100 (magnitude = 0..100 heuristic score, never win probability)
  signalStrengthScore: number; // 0 to 100
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

export function computeAtr14(candles: RawKline[], period = 14): number {
  if (candles.length < 2) return 0;
  const trueRanges: number[] = [candles[0].high - candles[0].low];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    trueRanges.push(
      Math.max(
        c.high - c.low,
        Math.abs(c.high - prevClose),
        Math.abs(c.low - prevClose)
      )
    );
  }
  const series = ema(trueRanges, period);
  return series[series.length - 1] ?? 0;
}

export function analyzeMarketQuantitatively(
  market: Pick<
    DiscoveredMarket,
    | 'symbol'
    | 'priceChangePercent'
    | 'quoteVolume'
    | 'candles5m'
    | 'candles15m'
    | 'unusualVolume'
    | 'unusualVolatility'
    | 'latestClosedCandleTime'
    | 'fetchedAt'
  >,
  minSignalScore = 65
): QuantAnalysisResult {
  const c15 = market.candles15m;
  const c5 = market.candles5m;
  if (c15.length < 55 || c5.length < 55) {
    throw new Error(`${market.symbol}: need at least 55 closed candles on 5m & 15m`);
  }

  const closes15 = c15.map((c) => c.close);
  const highs15 = c15.map((c) => c.high);
  const lows15 = c15.map((c) => c.low);
  const vols15 = c15.map((c) => c.volume);
  const last15 = c15[c15.length - 1];

  const closes5 = c5.map((c) => c.close);
  const last5 = c5[c5.length - 1];

  const ema9_15s = ema(closes15, 9);
  const ema21_15s = ema(closes15, 21);
  const ema50_15s = ema(closes15, 50);

  const ema9_5s = ema(closes5, 9);
  const ema21_5s = ema(closes5, 21);
  const ema50_5s = ema(closes5, 50);

  const ema9_15m = ema9_15s[ema9_15s.length - 1];
  const ema21_15m = ema21_15s[ema21_15s.length - 1];
  const ema50_15m = ema50_15s[ema50_15s.length - 1];
  const prevEma50_15m = ema50_15s[ema50_15s.length - 5];

  const ema9_5m = ema9_5s[ema9_5s.length - 1];
  const ema21_5m = ema21_5s[ema21_5s.length - 1];
  const ema50_5m = ema50_5s[ema50_5s.length - 1];

  const rsi14 = calculateRSI(closes15, 14);
  const rsi5m = calculateRSI(closes5, 14);

  const macdFast = ema(closes15, 12);
  const macdSlow = ema(closes15, 26);
  const macdLine = closes15.map((_, i) => macdFast[i] - macdSlow[i]);
  const macdSignalSeries = ema(macdLine, 9);
  const macd = macdLine[macdLine.length - 1];
  const macdSignal = macdSignalSeries[macdSignalSeries.length - 1];
  const macdHistogram = macd - macdSignal;

  const atr14 = computeAtr14(c15, 14);
  const price = last5.close;
  const volatilityPct = price > 0 ? (atr14 / price) * 100 : 0;

  const priorVols = vols15.slice(-21, -1);
  const avgVol =
    priorVols.reduce((s, v) => s + v, 0) / Math.max(priorVols.length, 1);
  const volumeRatio = avgVol > 0 ? last15.volume / avgVol : 1;

  // Support & resistance levels + Donchian breakout on prior 20 closed 15m bars
  const resistanceLevel = Math.max(...highs15.slice(-21, -1));
  const supportLevel = Math.min(...lows15.slice(-21, -1));
  let breakout: QuantAnalysisResult['breakout'] = 'NONE';
  if (last15.close > resistanceLevel) breakout = 'BULLISH_BREAKOUT';
  else if (last15.close < supportLevel) breakout = 'BEARISH_BREAKOUT';

  // Swing market structure
  const firstHalfHigh = Math.max(...highs15.slice(-24, -12));
  const secondHalfHigh = Math.max(...highs15.slice(-12));
  const firstHalfLow = Math.min(...lows15.slice(-24, -12));
  const secondHalfLow = Math.min(...lows15.slice(-12));

  let marketStructure: QuantAnalysisResult['marketStructure'] = 'RANGING';
  if (secondHalfHigh > firstHalfHigh && secondHalfLow > firstHalfLow) {
    marketStructure = 'UPTREND_HH_HL';
  } else if (secondHalfHigh < firstHalfHigh && secondHalfLow < firstHalfLow) {
    marketStructure = 'DOWNTREND_LH_LL';
  }

  const bull15 = ema9_15m > ema21_15m && ema21_15m > ema50_15m;
  const bear15 = ema9_15m < ema21_15m && ema21_15m < ema50_15m;
  const bull5 = ema9_5m > ema21_5m && ema21_5m > ema50_5m;
  const bear5 = ema9_5m < ema21_5m && ema21_5m < ema50_5m;
  const mtfAligned = (bull15 && bull5) || (bear15 && bear5);

  const emaSpreadPct =
    price > 0 ? (Math.abs(ema9_15m - ema50_15m) / price) * 100 : 0;
  const emaSlopePct =
    prevEma50_15m > 0
      ? (Math.abs(ema50_15m - prevEma50_15m) / prevEma50_15m) * 100
      : 0;

  const trendStrength = Math.round(
    clampValue(
      (bull15 || bear15 ? 35 : 10) +
        (mtfAligned ? 25 : 5) +
        Math.min(20, emaSpreadPct * 20) +
        Math.min(20, emaSlopePct * 40),
      0,
      100
    )
  );

  let score = 0;
  const reasons: string[] = [];

  if (bull15) {
    score += 30;
    reasons.push('15m closed EMA9 > EMA21 > EMA50 bullish trend');
  } else if (bear15) {
    score -= 30;
    reasons.push('15m closed EMA9 < EMA21 < EMA50 bearish trend');
  }

  if (bull5) {
    score += 20;
    reasons.push('5m closed EMA9 > EMA21 > EMA50 MTF alignment');
  } else if (bear5) {
    score -= 20;
    reasons.push('5m closed EMA9 < EMA21 < EMA50 MTF alignment');
  }

  if (macd > macdSignal && macdHistogram > 0) {
    score += 15;
    reasons.push('MACD above signal line with positive histogram');
  } else if (macd < macdSignal && macdHistogram < 0) {
    score -= 15;
    reasons.push('MACD below signal line with negative histogram');
  }

  if (breakout === 'BULLISH_BREAKOUT') {
    score += 15;
    reasons.push('Closed bar broke above 20-bar resistance');
  } else if (breakout === 'BEARISH_BREAKOUT') {
    score -= 15;
    reasons.push('Closed bar broke below 20-bar support');
  }

  if (marketStructure === 'UPTREND_HH_HL') {
    score += 10;
    reasons.push('Higher-High / Higher-Low market structure');
  } else if (marketStructure === 'DOWNTREND_LH_LL') {
    score -= 10;
    reasons.push('Lower-High / Lower-Low market structure');
  }

  if (rsi14 >= 52 && rsi14 < 70) {
    score += 10;
    reasons.push(`RSI14 (${rsi14.toFixed(1)}) bullish momentum`);
  } else if (rsi14 > 30 && rsi14 <= 48) {
    score -= 10;
    reasons.push(`RSI14 (${rsi14.toFixed(1)}) bearish momentum`);
  } else if (rsi14 >= 75) {
    score -= 8;
    reasons.push(`RSI14 (${rsi14.toFixed(1)}) overbought risk`);
  } else if (rsi14 <= 25) {
    score += 8;
    reasons.push(`RSI14 (${rsi14.toFixed(1)}) oversold bounce zone`);
  }

  if (volumeRatio >= 1.4) {
    const barBull = last15.close >= last15.open;
    score += barBull ? 8 : -8;
    reasons.push(
      `Volume surge (${volumeRatio.toFixed(2)}x avg) on ${barBull ? 'bullish' : 'bearish'} close`
    );
  }

  score = clampValue(Math.round(score), -100, 100);
  const absScore = Math.abs(score);

  let direction: QuantAnalysisResult['direction'] = 'HOLD';
  if (score >= minSignalScore) direction = 'BUY';
  else if (score <= -minSignalScore) direction = 'SELL';

  const rawStopDist = Math.max(atr14 * 1.5, price * 0.003);
  const boundedStopDist = Math.min(rawStopDist, price * 0.04);

  const stopLoss =
    direction === 'BUY'
      ? price - boundedStopDist
      : direction === 'SELL'
        ? price + boundedStopDist
        : null;
  const takeProfit =
    direction === 'BUY'
      ? price + boundedStopDist * 1.8
      : direction === 'SELL'
        ? price - boundedStopDist * 1.8
        : null;

  return {
    symbol: market.symbol,
    direction,
    heuristicScore: score,
    signalStrengthScore: absScore,
    minScoreRequired: minSignalScore,
    price,
    change24h: market.priceChangePercent,
    quoteVolume: market.quoteVolume,
    ema9_15m,
    ema21_15m,
    ema50_15m,
    ema9_5m,
    ema21_5m,
    ema50_5m,
    rsi14,
    rsi5m,
    macd,
    macdSignal,
    macdHistogram,
    atr14,
    volatilityPct,
    volumeRatio,
    trendStrength,
    supportLevel,
    resistanceLevel,
    breakout,
    mtfAligned,
    marketStructure,
    unusualVolume: market.unusualVolume,
    unusualVolatility: market.unusualVolatility,
    stopLoss,
    takeProfit,
    reasons,
    latestClosedCandleTime: market.latestClosedCandleTime,
    fetchedAt: market.fetchedAt,
  };
}
