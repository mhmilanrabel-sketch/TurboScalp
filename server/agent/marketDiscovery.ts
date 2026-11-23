// server/agent/marketDiscovery.ts
// Agent 1 – Market Discovery Agent
// Reuses quantRoutes.ts getUniverse(), getCandles(), filterClosedCandles(), and
// runWithConcurrency() without calling its own HTTP endpoints.
// Scans top 20 liquid USD-M USDT Perpetual pairs on Binance Demo using closed candles only.

import {
  filterClosedCandles,
  getCandles,
  getUniverse,
  runWithConcurrency,
  type Market,
  type RawKline,
} from '../quantRoutes.js';
import type { ExchangeSymbolFilter } from './riskManager.js';

export interface DiscoveredMarket {
  symbol: string;
  lastPrice: number;
  quoteVolume: number;
  priceChangePercent: number;
  unusualVolume: boolean;
  unusualVolatility: boolean;
  volumeSpikeRatio5m: number;
  volumeSpikeRatio15m: number;
  candles5m: RawKline[];
  candles15m: RawKline[];
  latestClosedCandleTime: number;
  fetchedAt: number;
  filter: ExchangeSymbolFilter;
}

export interface DiscoveryScanProgress {
  scanning: boolean;
  totalTargets: number;
  completedTargets: number;
  unusualMoversCount: number;
  stageLabel: string;
}

const TOP_LIQUID_PAIRS = 20;
const MIN_24H_QUOTE_VOLUME_USDT = 250_000;
const CONCURRENCY = 4;

export function detectUnusualActivity(
  candles5m: RawKline[],
  candles15m: RawKline[],
  priceChangePercent: number
): {
  volumeSpikeRatio5m: number;
  volumeSpikeRatio15m: number;
  unusualVolume: boolean;
  unusualVolatility: boolean;
} {
  const vols5 = candles5m.map((c) => c.volume);
  const lastVol5 = vols5[vols5.length - 1] ?? 0;
  const avgVol5 =
    vols5.slice(-21, -1).reduce((s, v) => s + v, 0) /
    Math.max(vols5.slice(-21, -1).length, 1);
  const volumeSpikeRatio5m = avgVol5 > 0 ? lastVol5 / avgVol5 : 1;

  const vols15 = candles15m.map((c) => c.volume);
  const lastVol15 = vols15[vols15.length - 1] ?? 0;
  const avgVol15 =
    vols15.slice(-21, -1).reduce((s, v) => s + v, 0) /
    Math.max(vols15.slice(-21, -1).length, 1);
  const volumeSpikeRatio15m = avgVol15 > 0 ? lastVol15 / avgVol15 : 1;

  const last15 = candles15m[candles15m.length - 1];
  const barRangePct15 =
    last15 && last15.open > 0
      ? ((last15.high - last15.low) / last15.open) * 100
      : 0;

  const unusualVolume = volumeSpikeRatio5m >= 1.8 || volumeSpikeRatio15m >= 1.6;
  const unusualVolatility =
    Math.abs(priceChangePercent) >= 3.5 || barRangePct15 >= 1.25;

  return {
    volumeSpikeRatio5m,
    volumeSpikeRatio15m,
    unusualVolume,
    unusualVolatility,
  };
}

function buildFilterFromMarket(m: Market): ExchangeSymbolFilter {
  return {
    symbol: m.symbol,
    status: 'TRADING',
    contractType: 'PERPETUAL',
    quoteAsset: 'USDT',
    tickSize: m.tickSize || 0.01,
    stepSize: m.stepSize || 0.001,
    minQty: m.minQty || 0.001,
    maxQty: m.maxQty || 1_000_000,
    minNotional: m.minNotional || 5,
  };
}

export async function discoverTopLiquidMarkets(
  onProgress?: (progress: DiscoveryScanProgress) => void
): Promise<{
  markets: DiscoveredMarket[];
  eligibleCount: number;
  failedCount: number;
}> {
  const universe = await getUniverse();
  const eligible = universe
    .filter((m) => m.quoteVolume >= MIN_24H_QUOTE_VOLUME_USDT && m.lastPrice > 0)
    .slice(0, TOP_LIQUID_PAIRS);

  let completed = 0;
  let unusualCount = 0;

  onProgress?.({
    scanning: true,
    totalTargets: eligible.length,
    completedTargets: 0,
    unusualMoversCount: 0,
    stageLabel: `Discovering closed 5m & 15m candles across top ${eligible.length} pairs`,
  });

  const now = Date.now();
  const { results, failed } = await runWithConcurrency(
    eligible,
    CONCURRENCY,
    async (market) => {
      const [raw5m, raw15m] = await Promise.all([
        getCandles(market.symbol, '5m', 100),
        getCandles(market.symbol, '15m', 120),
      ]);

      const fetchTime = Date.now();
      const candles5m = filterClosedCandles(raw5m, Math.max(now, fetchTime));
      const candles15m = filterClosedCandles(raw15m, Math.max(now, fetchTime));

      completed++;
      if (candles5m.length < 55 || candles15m.length < 55) {
        onProgress?.({
          scanning: true,
          totalTargets: eligible.length,
          completedTargets: completed,
          unusualMoversCount: unusualCount,
          stageLabel: `Scanned ${completed}/${eligible.length} pairs`,
        });
        throw new Error(`${market.symbol}: insufficient closed candles`);
      }

      const activity = detectUnusualActivity(
        candles5m,
        candles15m,
        market.priceChangePercent
      );
      if (activity.unusualVolume || activity.unusualVolatility) {
        unusualCount++;
      }

      const latestClosedCandleTime = Math.min(
        candles5m[candles5m.length - 1].closeTime,
        candles15m[candles15m.length - 1].closeTime
      );

      onProgress?.({
        scanning: true,
        totalTargets: eligible.length,
        completedTargets: completed,
        unusualMoversCount: unusualCount,
        stageLabel: `Scanned ${completed}/${eligible.length} pairs`,
      });

      const discovered: DiscoveredMarket = {
        symbol: market.symbol,
        lastPrice: market.lastPrice,
        quoteVolume: market.quoteVolume,
        priceChangePercent: market.priceChangePercent,
        unusualVolume: activity.unusualVolume,
        unusualVolatility: activity.unusualVolatility,
        volumeSpikeRatio5m: Number(activity.volumeSpikeRatio5m.toFixed(2)),
        volumeSpikeRatio15m: Number(activity.volumeSpikeRatio15m.toFixed(2)),
        candles5m,
        candles15m,
        latestClosedCandleTime,
        fetchedAt: fetchTime,
        filter: buildFilterFromMarket(market),
      };
      return discovered;
    }
  );

  onProgress?.({
    scanning: false,
    totalTargets: eligible.length,
    completedTargets: completed,
    unusualMoversCount: unusualCount,
    stageLabel: `Analyzed ${results.length}/${eligible.length} pairs`,
  });

  return {
    markets: results,
    eligibleCount: eligible.length,
    failedCount: failed,
  };
}
