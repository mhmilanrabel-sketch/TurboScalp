import { CandleData } from '../types';

/**
 * Exponential Moving Average (EMA)
 */
export function calculateEMA(data: number[], period: number): number[] {
  if (data.length === 0 || period <= 0) return [];
  const k = 2 / (period + 1);
  const emaArray: number[] = new Array(data.length);
  
  let currentEma = data[0];
  emaArray[0] = currentEma;
  
  for (let i = 1; i < data.length; i++) {
    currentEma = data[i] * k + currentEma * (1 - k);
    emaArray[i] = currentEma;
  }
  return emaArray;
}

/**
 * Relative Strength Index (RSI) using Wilder's smoothing
 */
export function calculateRSI(closes: number[], period = 14): number[] {
  if (closes.length <= period) return new Array(closes.length).fill(50);
  
  const rsis: number[] = new Array(closes.length);
  for (let i = 0; i < period; i++) {
    rsis[i] = 50;
  }
  
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  
  let avgGain = gains / period;
  let avgLoss = losses / period;
  
  const firstRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  rsis[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + firstRs);
  
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff >= 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    
    if (avgLoss === 0) {
      rsis[i] = 100;
    } else {
      const rs = avgGain / avgLoss;
      rsis[i] = 100 - 100 / (1 + rs);
    }
  }
  
  return rsis;
}

/**
 * Bollinger Bands
 */
export function calculateBollingerBands(
  closes: number[],
  period = 20,
  stdDevMultiplier = 2
): { middle: number[]; upper: number[]; lower: number[] } {
  const middle: number[] = [];
  const upper: number[] = [];
  const lower: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      middle.push(closes[i]);
      upper.push(closes[i] * 1.01);
      lower.push(closes[i] * 0.99);
      continue;
    }

    const slice = closes.slice(i - period + 1, i + 1);
    const mean = slice.reduce((acc, val) => acc + val, 0) / period;
    const variance = slice.reduce((acc, val) => acc + Math.pow(val - mean, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    middle.push(mean);
    upper.push(mean + stdDevMultiplier * stdDev);
    lower.push(mean - stdDevMultiplier * stdDev);
  }

  return { middle, upper, lower };
}

/**
 * Moving Average Convergence Divergence (MACD)
 */
export function calculateMACD(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9
): { macd: number[]; signal: number[]; histogram: number[] } {
  const fastEMA = calculateEMA(closes, fastPeriod);
  const slowEMA = calculateEMA(closes, slowPeriod);
  
  const macdLine = fastEMA.map((fast, i) => fast - slowEMA[i]);
  const signalLine = calculateEMA(macdLine, signalPeriod);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);

  return { macd: macdLine, signal: signalLine, histogram };
}

/**
 * Average True Range (ATR)
 */
export function calculateATR(
  highs: number[],
  lows: number[],
  closes: number[],
  period = 14
): number[] {
  const length = highs.length;
  if (length === 0) return [];
  
  const trueRanges: number[] = [highs[0] - lows[0]];
  for (let i = 1; i < length; i++) {
    const hl = highs[i] - lows[i];
    const hc = Math.abs(highs[i] - closes[i - 1]);
    const lc = Math.abs(lows[i] - closes[i - 1]);
    trueRanges.push(Math.max(hl, hc, lc));
  }

  return calculateEMA(trueRanges, period);
}

/**
 * Generate synthetic realistic candle history ending at target price
 */
export function generateCandleHistory(
  basePrice: number,
  barsCount = 60,
  timeframeMinutes = 15,
  volatility = 0.003
): CandleData[] {
  const candles: CandleData[] = [];
  const now = Date.now();
  const stepMs = timeframeMinutes * 60 * 1000;

  let currentPrice = basePrice * (1 - (Math.random() - 0.5) * volatility * 8);
  const closes: number[] = [];

  for (let i = 0; i < barsCount; i++) {
    const time = now - (barsCount - 1 - i) * stepMs;
    const change = (Math.random() - 0.49) * currentPrice * volatility;
    const open = currentPrice;
    const close = i === barsCount - 1 ? basePrice : open + change;
    const high = Math.max(open, close) + Math.random() * Math.abs(change || basePrice * 0.001) * 0.8;
    const low = Math.min(open, close) - Math.random() * Math.abs(change || basePrice * 0.001) * 0.8;
    const volume = Math.floor(Math.random() * 8000 + 2000);

    currentPrice = close;
    closes.push(close);
    candles.push({
      time,
      open,
      high,
      low,
      close,
      volume,
    });
  }

  // Calculate indicators and enrich
  const ema20 = calculateEMA(closes, 20);
  const ema50 = calculateEMA(closes, 50);
  const ema200 = calculateEMA(closes, 200);
  const rsi = calculateRSI(closes, 14);
  const bb = calculateBollingerBands(closes, 20, 2);
  const macdData = calculateMACD(closes);

  return candles.map((c, i) => ({
    ...c,
    ema20: ema20[i],
    ema50: ema50[i],
    ema200: ema200[i],
    rsi: rsi[i] || 50,
    bbUpper: bb.upper[i],
    bbMiddle: bb.middle[i],
    bbLower: bb.lower[i],
    macd: {
      macd: macdData.macd[i] || 0,
      signal: macdData.signal[i] || 0,
      histogram: macdData.histogram[i] || 0,
    },
  }));
}
