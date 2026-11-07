import React from 'react';
import { MarketAsset } from '../types';
import { TrendingUp, TrendingDown, Activity } from 'lucide-react';

interface MarketTickerProps {
  assets: MarketAsset[];
  selectedSymbol: string;
  onSelectSymbol: (symbol: string) => void;
}

// Safe number formatter helper to prevent toFixed crashes on undefined/null values
const safeNum = (val: number | undefined | null, decimals: number = 2): string => {
  if (val === undefined || val === null || isNaN(val)) {
    return (0).toFixed(decimals);
  }
  return Number(val).toFixed(decimals);
};

export function MarketTicker({ assets, selectedSymbol, onSelectSymbol }: MarketTickerProps) {
  if (!assets || assets.length === 0) {
    return (
      <div className="bg-[#0e131f] border-b border-slate-800 px-4 py-2.5 flex items-center space-x-2 text-xs text-slate-400 font-mono">
        <Activity className="w-4 h-4 text-amber-500 animate-spin" />
        <span>Connecting to Binance Futures live ticker stream...</span>
      </div>
    );
  }

  return (
    <div className="bg-[#0e131f] border-b border-slate-800 overflow-x-auto scrollbar-none font-mono">
      <div className="flex items-center space-x-3 px-4 py-2.5 min-w-max">
        <div className="flex items-center space-x-1.5 text-xs text-amber-400 font-bold uppercase tracking-wider pr-2 border-r border-slate-800">
          <Activity className="w-3.5 h-3.5 animate-pulse" />
          <span>Live Tickers</span>
        </div>

        {assets.map((asset) => {
          const isSelected = selectedSymbol === asset.symbol;
          const isPositive = (asset.high24h ?? 0) >= (asset.low24h ?? 0);

          return (
            <button
              key={asset.symbol}
              onClick={() => onSelectSymbol(asset.symbol)}
              className={`flex items-center space-x-3 px-3 py-1.5 rounded-xl border transition cursor-pointer ${
                isSelected
                  ? 'bg-amber-500/10 border-amber-500/50 text-white shadow-lg shadow-amber-500/5'
                  : 'bg-slate-900/60 border-slate-800/80 text-slate-300 hover:bg-slate-800/80 hover:border-slate-700'
              }`}
            >
              <div className="flex flex-col text-left">
                <span className="text-xs font-bold text-white flex items-center space-x-1">
                  <span>{asset.symbol}</span>
                </span>
                <span className="text-[10px] text-slate-400">{asset.name}</span>
              </div>

              <div className="flex flex-col text-right">
                <span className="text-xs font-bold text-amber-400">
                  ${safeNum(asset.price, asset.price < 1 ? 4 : 2)}
                </span>
                <div className="flex items-center space-x-1 text-[10px]">
                  <span className="text-slate-400">RSI:</span>
                  <span className={isPositive ? 'text-emerald-400' : 'text-rose-400'}>
                    {safeNum(asset.rsi, 1)}
                  </span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}