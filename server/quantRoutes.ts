import type { Express, Request, Response } from "express";
import axios from "axios";

const BINANCE_DEMO_API = "https://demo-fapi.binance.com";

type Market = {
  symbol: string;
  quoteVolume: number;
  priceChangePercent: number;
  lastPrice: number;
};

type Signal = {
  symbol: string;
  direction: "BUY" | "SELL" | "NEUTRAL";
  score: number;
  confidence: number;
  price: number;
  change24h: number;
  quoteVolume: number;
  rsi: number;
  volumeRatio: number;
  volatilityPct: number;
  stopLoss: number;
  takeProfit: number;
  reasons: string[];
};

let universeCache: {
  time: number;
  markets: Market[];
} | null = null;

const CACHE_DURATION = 15_000;

function number(value: unknown): number {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function ema(values: number[], period: number): number[] {
  if (!values.length) return [];

  const multiplier = 2 / (period + 1);
  const output: number[] = [];

  let previous = values[0];
  output.push(previous);

  for (let i = 1; i < values.length; i++) {
    previous =
      values[i] * multiplier +
      previous * (1 - multiplier);

    output.push(previous);
  }

  return output;
}

function calculateRSI(
  closes: number[],
  period = 14
): number {
  if (closes.length <= period) return 50;

  let gains = 0;
  let losses = 0;

  for (let i = closes.length - period; i < closes.length; i++) {
    const difference = closes[i] - closes[i - 1];

    if (difference > 0) gains += difference;
    else losses += Math.abs(difference);
  }

  if (losses === 0) return 100;

  const averageGain = gains / period;
  const averageLoss = losses / period;

  const rs = averageGain / averageLoss;

  return 100 - 100 / (1 + rs);
}

async function getUniverse(): Promise<Market[]> {
  if (
    universeCache &&
    Date.now() - universeCache.time < CACHE_DURATION
  ) {
    return universeCache.markets;
  }

  const [exchangeResponse, tickerResponse] =
    await Promise.all([
      axios.get(`${BINANCE_DEMO_API}/fapi/v1/exchangeInfo`, {
        timeout: 15_000,
      }),
      axios.get(`${BINANCE_DEMO_API}/fapi/v1/ticker/24hr`, {
        timeout: 15_000,
      }),
    ]);

  const exchangeSymbols =
    exchangeResponse.data?.symbols ?? [];

  const tickers = tickerResponse.data ?? [];

  const eligibleSymbols = new Set(
    exchangeSymbols
      .filter(
        (item: any) =>
          item.status === "TRADING" &&
          item.contractType === "PERPETUAL" &&
          item.quoteAsset === "USDT"
      )
      .map((item: any) => item.symbol)
  );

  const markets: Market[] = tickers
    .filter((item: any) => eligibleSymbols.has(item.symbol))
    .map((item: any) => ({
      symbol: item.symbol,
      quoteVolume: number(item.quoteVolume),
      priceChangePercent: number(item.priceChangePercent),
      lastPrice: number(item.lastPrice),
    }))
    .filter((item: Market) => item.lastPrice > 0)
    .sort((a: Market, b: Market) =>
      b.quoteVolume - a.quoteVolume
    );

  universeCache = {
    time: Date.now(),
    markets,
  };

  return markets;
}

async function getCandles(symbol: string): Promise<any[]> {
  if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) {
    throw new Error("Invalid trading symbol");
  }

  const response = await axios.get(
    `${BINANCE_DEMO_API}/fapi/v1/klines`,
    {
      params: {
        symbol,
        interval: "15m",
        limit: 120,
      },
      timeout: 15_000,
    }
  );

  if (!Array.isArray(response.data)) {
    throw new Error("Invalid candle response");
  }

  return response.data;
}

function calculateSignal(
  symbol: string,
  candles: any[],
  market: Market
): Signal {
  const opens = candles.map((c) => number(c[1]));
  const highs = candles.map((c) => number(c[2]));
  const lows = candles.map((c) => number(c[3]));
  const closes = candles.map((c) => number(c[4]));
  const volumes = candles.map((c) => number(c[5]));

  if (closes.length < 60) {
    throw new Error("Not enough candle data");
  }

  const currentPrice = closes[closes.length - 1];

  const ema9 = ema(closes, 9);
  const ema21 = ema(closes, 21);
  const ema50 = ema(closes, 50);

  const currentEma9 = ema9[ema9.length - 1];
  const currentEma21 = ema21[ema21.length - 1];
  const currentEma50 = ema50[ema50.length - 1];

  const rsi = calculateRSI(closes);

  const macdFast = ema(closes, 12);
  const macdSlow = ema(closes, 26);

  const macdValues = closes.map(
    (_, index) => macdFast[index] - macdSlow[index]
  );

  const macdSignal = ema(macdValues, 9);

  const currentMACD =
    macdValues[macdValues.length - 1];

  const currentMACDSignal =
    macdSignal[macdSignal.length - 1];

  const trueRanges: number[] = [];

  for (let i = 1; i < closes.length; i++) {
    trueRanges.push(
      Math.max(
        highs[i] - lows[i],
        Math.abs(highs[i] - closes[i - 1]),
        Math.abs(lows[i] - closes[i - 1])
      )
    );
  }

  const atrValues = ema(trueRanges, 14);
  const atr = atrValues[atrValues.length - 1];

  const volatilityPct =
    currentPrice > 0
      ? (atr / currentPrice) * 100
      : 0;

  const recentVolumes = volumes.slice(-20);
  const averageVolume =
    recentVolumes.reduce((sum, value) => sum + value, 0) /
    Math.max(recentVolumes.length, 1);

  const currentVolume = volumes[volumes.length - 1];

  const volumeRatio =
    averageVolume > 0
      ? currentVolume / averageVolume
      : 0;

  const previousHigh = Math.max(
    ...highs.slice(-21, -1)
  );

  const previousLow = Math.min(
    ...lows.slice(-21, -1)
  );

  let score = 0;
  const reasons: string[] = [];

  // Trend
  if (
    currentEma9 > currentEma21 &&
    currentEma21 > currentEma50
  ) {
    score += 35;
    reasons.push("Strong bullish EMA alignment");
  } else if (
    currentEma9 < currentEma21 &&
    currentEma21 < currentEma50
  ) {
    score -= 35;
    reasons.push("Strong bearish EMA alignment");
  }

  // MACD
  if (currentMACD > currentMACDSignal) {
    score += 20;
    reasons.push("Bullish MACD momentum");
  } else {
    score -= 20;
    reasons.push("Bearish MACD momentum");
  }

  // Breakout
  if (currentPrice > previousHigh) {
    score += 15;
    reasons.push("Price above recent resistance");
  } else if (currentPrice < previousLow) {
    score -= 15;
    reasons.push("Price below recent support");
  }

  // RSI
  if (rsi >= 50 && rsi < 70) {
    score += 15;
    reasons.push("Positive RSI momentum");
  } else if (rsi < 50 && rsi > 30) {
    score -= 15;
    reasons.push("Negative RSI momentum");
  } else if (rsi >= 70) {
    score -= 5;
    reasons.push("RSI potentially overbought");
  } else if (rsi <= 30) {
    score += 5;
    reasons.push("RSI potentially oversold");
  }

  // Volume
  if (volumeRatio > 1.5) {
    score += currentPrice > opens[opens.length - 1] ? 5 : -5;
    reasons.push("Above-average trading volume");
  }

  // 24-hour momentum
  const change24h = market.priceChangePercent;

  if (change24h > 2) {
    score += 10;
    reasons.push("Positive 24-hour momentum");
  } else if (change24h < -2) {
    score -= 10;
    reasons.push("Negative 24-hour momentum");
  }

  score = clamp(score, -100, 100);

  let direction: Signal["direction"] = "NEUTRAL";

  if (score >= 45) direction = "BUY";
  if (score <= -45) direction = "SELL";

  const stopDistance = Math.max(
    atr * 1.5,
    currentPrice * 0.002
  );

  const stopLoss =
    direction === "BUY"
      ? currentPrice - stopDistance
      : currentPrice + stopDistance;

  const takeProfit =
    direction === "BUY"
      ? currentPrice + stopDistance * 2
      : currentPrice - stopDistance * 2;

  // This is a heuristic score, NOT a statistically validated
  // probability of a successful trade.
  const confidence = Math.round(
    clamp(50 + Math.abs(score) * 0.45, 50, 95)
  );

  return {
    symbol,
    direction,
    score,
    confidence,
    price: currentPrice,
    change24h,
    quoteVolume: market.quoteVolume,
    rsi,
    volumeRatio,
    volatilityPct,
    stopLoss,
    takeProfit,
    reasons,
  };
}

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<R>
): Promise<{
  results: R[];
  failed: number;
}> {
  const results: R[] = [];
  let failed = 0;
  let index = 0;

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const currentIndex = index++;

        if (currentIndex >= items.length) return;

        try {
          results[currentIndex] = await worker(
            items[currentIndex]
          );
        } catch {
          failed++;
        }
      }
    }
  );

  await Promise.all(workers);

  return {
    results: results.filter(Boolean),
    failed,
  };
}

function sendError(
  res: Response,
  error: unknown,
  message: string
) {
  console.error(message, error);

  res.status(502).json({
    success: false,
    error: message,
  });
}

export function registerQuantRoutes(app: Express) {
  // Full eligible USDT perpetual market list.
  app.get("/api/quant/universe", async (_req, res) => {
    try {
      const markets = await getUniverse();

      res.json({
        success: true,
        count: markets.length,
        markets,
      });
    } catch (error) {
      sendError(res, error, "Unable to load market universe");
    }
  });

  // Scan a selected batch of high-volume markets.
  app.get("/api/quant/scan", async (req, res) => {
    try {
      const markets = await getUniverse();

      const requestedLimit = Number(req.query.limit ?? 40);
      const requestedOffset = Number(req.query.offset ?? 0);
      const requestedMinVolume = Number(
        req.query.minVolume ?? 250000
      );

      const limit = clamp(
        Number.isFinite(requestedLimit) ? requestedLimit : 40,
        1,
        100
      );

      const offset = clamp(
        Number.isFinite(requestedOffset) ? requestedOffset : 0,
        0,
        markets.length
      );

      const minVolume = clamp(
        Number.isFinite(requestedMinVolume)
          ? requestedMinVolume
          : 250000,
        0,
        1_000_000_000_000
      );

      const eligibleMarkets = markets.filter(
        (market) => market.quoteVolume >= minVolume
      );

      const batch = eligibleMarkets.slice(
        offset,
        offset + limit
      );

      const scanResult = await runWithConcurrency(
        batch,
        5,
        async (market) => {
          const candles = await getCandles(market.symbol);

          return calculateSignal(
            market.symbol,
            candles,
            market
          );
        }
      );

      const signals = scanResult.results.sort(
        (a, b) => Math.abs(b.score) - Math.abs(a.score)
      );

      res.json({
        success: true,
        signals,
        eligibleCount: eligibleMarkets.length,
        requestedCount: batch.length,
        scannedCount: signals.length,
        failedCount: scanResult.failed,
        offset,
        limit,
        nextOffset: offset + batch.length,
        hasMore: offset + batch.length < eligibleMarkets.length,
        interval: "15m",
        marketType: "USDT PERPETUAL",
      });
    } catch (error) {
      sendError(res, error, "Market scan failed");
    }
  });

  // Analyse one symbol.
  app.get(
    "/api/quant/analyze/:symbol",
    async (req, res) => {
      try {
        const symbol = String(req.params.symbol).toUpperCase();

        if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) {
          return res.status(400).json({
            success: false,
            error: "Invalid symbol",
          });
        }

        const markets = await getUniverse();

        const market = markets.find(
          (item) => item.symbol === symbol
        );

        if (!market) {
          return res.status(404).json({
            success: false,
            error: "Symbol not found in USDT perpetual markets",
          });
        }

        const candles = await getCandles(symbol);
        const signal = calculateSignal(
          symbol,
          candles,
          market
        );

        return res.json({
          success: true,
          signal,
        });
      } catch (error) {
        sendError(res, error, "Symbol analysis failed");
      }
    }
  );

  // Rule-based analyst. This endpoint does not call an external AI model.
  app.post("/api/quant/discuss", async (req, res) => {
    try {
      const symbol = String(req.body?.symbol ?? "").toUpperCase();

      if (!/^[A-Z0-9]{2,30}USDT$/.test(symbol)) {
        return res.status(400).json({
          success: false,
          error: "Please provide a valid USDT perpetual symbol",
        });
      }

      const markets = await getUniverse();
      const market = markets.find(
        (item) => item.symbol === symbol
      );

      if (!market) {
        return res.status(404).json({
          success: false,
          error: "Symbol not found",
        });
      }

      const candles = await getCandles(symbol);
      const signal = calculateSignal(
        symbol,
        candles,
        market
      );

      const recommendation =
        signal.direction === "BUY"
          ? "The indicators currently show a bullish setup."
          : signal.direction === "SELL"
            ? "The indicators currently show a bearish setup."
            : "The indicators do not currently show a strong directional setup.";

      const discussion = [
        `${symbol} analysis`,
        recommendation,
        `Signal score: ${signal.score}/100.`,
        `RSI: ${signal.rsi.toFixed(2)}.`,
        `24-hour change: ${signal.change24h.toFixed(2)}%.`,
        `Volume ratio: ${signal.volumeRatio.toFixed(2)}.`,
        `Estimated stop: ${signal.stopLoss}.`,
        `Estimated target: ${signal.takeProfit}.`,
        "These are technical indicator estimates, not guaranteed predictions.",
      ].join(" ");

      return res.json({
        success: true,
        mode: "RULE_BASED_ANALYST",
        discussion,
        signal,
      });
    } catch (error) {
      sendError(res, error, "Unable to analyse this symbol");
    }
  });
}