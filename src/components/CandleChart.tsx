import React, { useState, useEffect } from 'react';
import { MarketAsset, TradeSignal } from '../types';
import { fetchBinanceKlines } from '../services/binanceService';
import { BarChart3, TrendingUp, TrendingDown, Clock, Layers } from 'lucide-react';

interface CandleChartProps {
  assets: MarketAsset[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
  activePositions: TradeSignal[];
  onOpenPushTrade: (symbol: string) => void;
}

// Safe number formatting helper to prevent toFixed crashes
const safeNum = (val: number | undefined | null, decimals: number = 2): string => {
  if (val === undefined || val === null || isNaN(val)) {
    return (0).toFixed(decimals);
  }
  return Number(val).toFixed(decimals);
};

export function CandleChart({
  assets,
  selectedSymbol,
  onSelectSymbol,
  activePositions,
  onOpenPushTrade,
}: CandleChartProps) {
  const [timeframe, setTimeframe] = useState<'1m' | '5m' | '15m' | '1h'>('15m');
  const [klines, setKlines] = useState<Array<any>>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);

  const currentAsset = assets.find((a) => a.symbol === selectedSymbol) || assets[0] || {
    symbol: 'BTC/USDT',
    name: 'Bitcoin',
    price: 91400,
    high24h: 92500,
    low24h: 89800,
    rsi: 58,
  };

  const assetPositions = activePositions.filter((p) => p.symbol === currentAsset.symbol);

  useEffect(() => {
    let isMounted = true;
    setIsLoading(true);

    fetchBinanceKlines(currentAsset.symbol, timeframe, 40)
      .then((data) => {
        if (!isMounted) return;
        if (data && data.length > 0) {
          setKlines(data);
        } else {
          // Fallback mock klines if API is restricted
          const basePrice = currentAsset.price || 90000;
          const mock = Array.from({ length: 30 }).map((_, i) => {
            const variance = (Math.random() - 0.5) * (basePrice * 0.005);
            const p = basePrice + variance;
            return {
              open: p - variance * 0.5,
              high: p + Math.abs(variance),
              low: p - Math.abs(variance),
              close: p,
              volume: Math.random() * 100 + 10,
            };
          });
          setKlines(mock);
        }
        setIsLoading(false);
      })
      .catch(() => {
        if (!isMounted) return;
        setIsLoading(false);
      });

    return () => {
      isMounted = false;
    };
  }, [currentAsset.symbol, timeframe, currentAsset.price]);

  const maxPrice = klines.length > 0 ? Math.max(...klines.map((k) => k.high || currentAsset.price)) : (currentAsset.price * 1.02);
  const minPrice = klines.length > 0 ? Math.min(...klines.map((k) => k.low || currentAsset.price)) : (currentAsset.price * 0.98);
  const priceRange = maxPrice - minPrice || 1;

  return (
    <div className="bg-[#111827] border border-slate-800 rounded-2xl p-4 space-y-4 shadow-xl font-mono text-slate-100">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
        <div className="flex items-center space-x-3">
          <select
            value={selectedSymbol}
            onChange={(e) => onSelectSymbol(e.target.value)}
            className="bg-slate-900 border border-slate-700 text-white text-xs font-bold px-3 py-2 rounded-xl outline-none cursor-pointer"
          >
            {assets.map((a) => (
              <option key={a.symbol} value={a.symbol}>
                {a.symbol} ({a.name})
              </option>
            ))}
          </select>

          <div className="flex items-baseline space-x-2">
            <span className="text-lg font-bold text-amber-400">
              ${safeNum(currentAsset.price, currentAsset.price < 1 ? 4 : 2)}
            </span>
            <span className="text-xs text-slate-400">
              RSI: <strong className="text-white">{safeNum(currentAsset.rsi, 1)}</strong>
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <div className="flex bg-slate-900 p-1 rounded-xl border border-slate-800 text-xs">
            {(['1m', '5m', '15m', '1h'] as const).map((tf) => (
              <button
                key={tf}
                onClick={() => setTimeframe(tf)}
                className={`px-3 py-1 rounded-lg font-bold transition cursor-pointer ${
                  timeframe === tf ? 'bg-amber-500 text-black' : 'text-slate-400 hover:text-white'
                }`}
              >
                {tf}
              </button>
            ))}
          </div>

          <button
            onClick={() => onOpenPushTrade(currentAsset.symbol)}
            className="px-4 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-black font-bold text-xs rounded-xl shadow-lg shadow-amber-500/20 transition cursor-pointer flex items-center space-x-1.5"
          >
            <span>⚡ Push Trade</span>
          </button>
        </div>
      </div>

      {/* Candlestick Visualizer */}
      <div className="relative h-64 bg-slate-950/60 rounded-xl border border-slate-900 overflow-hidden p-3 flex flex-col justify-between">
        <div className="absolute top-3 left-3 flex items-center space-x-3 text-[10px] text-slate-400 z-10 bg-slate-900/80 px-2.5 py-1 rounded-lg border border-slate-800">
          <span>High: <strong className="text-emerald-400">${safeNum(currentAsset.high24h)}</strong></span>
          <span>Low: <strong className="text-rose-400">${safeNum(currentAsset.low24h)}</strong></span>
          <span>Active Trades: <strong className="text-amber-400">{assetPositions.length}</strong></span>
        </div>

        {isLoading ? (
          <div className="flex-1 flex items-center justify-center text-xs text-slate-400">
            Loading Binance Futures kline candles...
          </div>
        ) : (
          <div className="flex-1 flex items-end space-x-1 pt-8 pb-2 px-1">
            {klines.map((k, idx) => {
              const isGreen = k.close >= k.open;
              const candleHeight = Math.max(6, Math.abs(k.close - k.open) / priceRange * 160);
              const bottomOffset = Math.max(0, Math.min(180, (Math.min(k.open, k.close) - minPrice) / priceRange * 180));

              return (
                <div key={idx} className="flex-1 flex flex-col items-center relative group h-full justify-end">
                  {/* Wick */}
                  <div
                    className={`w-0.5 absolute ${isGreen ? 'bg-emerald-500/70' : 'bg-rose-500/70'}`}
                    style={{
                      height: `${Math.max(10, (k.high - k.low) / priceRange * 180)}px`,
                      bottom: `${Math.max(0, (k.low - minPrice) / priceRange * 180)}px`,
                    }}
                  />
                  {/* Body */}
                  <div
                    className={`w-full rounded-sm z-10 transition-all ${isGreen ? 'bg-emerald-500 hover:bg-emerald-400' : 'bg-rose-500 hover:bg-rose-400'}`}
                    style={{
                      height: `${candleHeight}px`,
                      bottom: `${bottomOffset}px`,
                    }}
                  />
                </div>
              );
            })}
          </div>
        )}

        {/* Active Trade Levels Overlay */}
        {assetPositions.map((pos) => {
          const posBottom = Math.max(0, Math.min(190, (pos.entryPrice - minPrice) / priceRange * 190));
          return (
            <div
              key={pos.id}
              className="absolute left-0 right-0 border-t border-dashed border-amber-400 z-20 flex items-center justify-between px-3 pointer-events-none"
              style={{ bottom: `${posBottom}px` }}
            >
              <span className="bg-amber-500 text-black text-[9px] font-bold px-1.5 py-0.5 rounded shadow">
                {pos.direction} Entry: ${safeNum(pos.entryPrice)} (PnL: {safeNum(pos.pnlPercentage)}%)
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}