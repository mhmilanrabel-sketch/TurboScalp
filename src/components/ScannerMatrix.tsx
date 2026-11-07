import React from 'react';
import { MarketAsset, AutoPilotConfig } from '../types';
import { evaluateMarketAsset } from '../utils/tradingEngine';
import { Zap, TrendingUp, TrendingDown, Activity, Play } from 'lucide-react';

interface ScannerMatrixProps {
  assets: MarketAsset[];
  onSelectSymbol: (symbol: string) => void;
  onPushTrade: (asset: MarketAsset, direction: 'BUY (LONG)' | 'SELL (SHORT)') => void;
  config: AutoPilotConfig;
  isScanning: boolean;
}

const safeNum = (val: number | undefined | null, decimals: number = 2): string => {
  if (val === undefined || val === null || isNaN(val)) {
    return (0).toFixed(decimals);
  }
  return Number(val).toFixed(decimals);
};

export function ScannerMatrix({
  assets,
  onSelectSymbol,
  onPushTrade,
  config,
  isScanning,
}: ScannerMatrixProps) {
  if (!assets || assets.length === 0) {
    return (
      <div className="bg-[#111827] border border-slate-800 rounded-2xl p-6 text-center text-slate-400 font-mono text-xs">
        Scanner Matrix initializing... Waiting for Binance Futures asset data.
      </div>
    );
  }

  return (
    <div className="bg-[#111827] border border-slate-800 rounded-2xl p-4 sm:p-6 space-y-4 shadow-xl font-mono text-slate-100">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
        <div>
          <h2 className="text-base font-bold text-white flex items-center space-x-2">
            <Zap className="w-5 h-5 text-amber-500 animate-pulse" />
            <span>15M Confluence Scanner Matrix</span>
          </h2>
          <p className="text-xs text-slate-400">
            Real-time multi-indicator confluence evaluation scanning active Binance Futures pairs.
          </p>
        </div>

        <div className="flex items-center space-x-2 text-xs">
          <span className="px-3 py-1 bg-slate-900 border border-slate-800 rounded-xl text-slate-300">
            Min Confidence: <strong className="text-amber-400">{config.minConfidenceScore}%</strong>
          </span>
          {isScanning && (
            <span className="flex items-center space-x-1.5 px-3 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded-xl animate-pulse">
              <Activity className="w-3.5 h-3.5" />
              <span>Scanning...</span>
            </span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {assets.map((asset) => {
          const evalResult = evaluateMarketAsset(asset);
          const isSelected = config.selectedPairs.includes(asset.symbol);
          const isLong = evalResult.direction === 'BUY (LONG)';
          const meetsThreshold = evalResult.confidenceScore >= config.minConfidenceScore;

          return (
            <div
              key={asset.symbol}
              className={`p-4 rounded-2xl border transition flex flex-col justify-between space-y-4 ${
                meetsThreshold
                  ? 'bg-slate-900/90 border-amber-500/40 shadow-lg shadow-amber-500/5'
                  : 'bg-slate-900/40 border-slate-800/80 opacity-75'
              }`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <button
                    onClick={() => onSelectSymbol(asset.symbol)}
                    className="text-sm font-bold text-white hover:text-amber-400 transition text-left cursor-pointer flex items-center space-x-1.5"
                  >
                    <span>{asset.symbol}</span>
                  </button>
                  <span className="text-[10px] text-slate-400">{asset.name}</span>
                </div>

                <div className="text-right">
                  <span className="text-xs font-bold text-amber-400">
                    ${safeNum(asset.price, asset.price < 1 ? 4 : 2)}
                  </span>
                  <div className="text-[10px] text-slate-400">
                    RSI: <strong className="text-white">{safeNum(asset.rsi, 1)}</strong>
                  </div>
                </div>
              </div>

              {/* Signal Badge & Confidence */}
              <div className="flex items-center justify-between bg-slate-950/60 p-3 rounded-xl border border-slate-800/80">
                <div className="flex items-center space-x-2">
                  {isLong ? (
                    <TrendingUp className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <TrendingDown className="w-4 h-4 text-rose-400" />
                  )}
                  <span className={`text-xs font-bold ${isLong ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {evalResult.direction}
                  </span>
                </div>

                <div className="flex items-center space-x-1 text-xs font-bold">
                  <span className="text-slate-400">Score:</span>
                  <span className={meetsThreshold ? 'text-amber-400' : 'text-slate-400'}>
                    {safeNum(evalResult.confidenceScore, 0)}%
                  </span>
                </div>
              </div>

              {/* Safe Confluence Badges rendering */}
              <div className="flex flex-wrap gap-1.5">
                {Array.isArray(evalResult.confluences) &&
                  evalResult.confluences.map((conf: any, idx: number) => {
                    let label = '';
                    if (typeof conf === 'string') {
                      label = conf;
                    } else if (conf && typeof conf === 'object') {
                      label = conf.name || conf.description || conf.value || JSON.stringify(conf);
                    }

                    return (
                      <span
                        key={idx}
                        className="px-2 py-0.5 rounded-lg bg-slate-800/80 border border-slate-700/60 text-[10px] text-slate-300"
                      >
                        {label}
                      </span>
                    );
                  })}
              </div>

              {/* Action Button */}
              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between">
                <span className="text-[10px] text-slate-400">
                  {isSelected ? '🟢 Enabled in Auto-Pilot' : '⚪ Disabled in Scanner'}
                </span>
                <button
                  onClick={() => onPushTrade(asset, evalResult.direction)}
                  className="px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-black font-bold text-xs rounded-xl transition cursor-pointer shadow-md shadow-amber-500/20 flex items-center space-x-1"
                >
                  <Play className="w-3 h-3 fill-current" />
                  <span>Push Trade</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}