import React, { useState, useEffect } from 'react';
import { MarketAsset, TradeSignal, AutoPilotConfig, BinanceApiSettings } from '../types';
import {
  X,
  Zap,
  ArrowUpRight,
  ArrowDownRight,
  Shield,
  Target,
  DollarSign,
  Layers,
  Flame,
} from 'lucide-react';

interface PushTradeModalProps {
  isOpen: boolean;
  onClose: () => void;
  assets: MarketAsset[];
  initialSymbol?: string;
  onExecutePushTrade: (params: {
    symbol: string;
    direction: 'BUY (LONG)' | 'SELL (SHORT)';
    entryPrice: number;
    stopLoss: number;
    takeProfit1: number;
    takeProfit2: number;
    leverage: number;
    sizeUsd: number;
  }) => void;
  apiSettings: BinanceApiSettings;
}

export const PushTradeModal: React.FC<PushTradeModalProps> = ({
  isOpen,
  onClose,
  assets,
  initialSymbol,
  onExecutePushTrade,
  apiSettings,
}) => {
  const [selectedSymbol, setSelectedSymbol] = useState(initialSymbol || 'BTC/USDT');
  const [direction, setDirection] = useState<'BUY (LONG)' | 'SELL (SHORT)'>('BUY (LONG)');
  const [leverage, setLeverage] = useState<number>(10);
  const [sizeUsd, setSizeUsd] = useState<number>(500);
  const [tp1Pct, setTp1Pct] = useState<number>(0.8);
  const [tp2Pct, setTp2Pct] = useState<number>(1.6);
  const [slPct, setSlPct] = useState<number>(0.5);

  useEffect(() => {
    if (initialSymbol) setSelectedSymbol(initialSymbol);
  }, [initialSymbol]);

  if (!isOpen) return null;

  const currentAsset = assets.find((a) => a.symbol === selectedSymbol) || assets[0];
  const entryPrice = currentAsset ? currentAsset.price : 90000;
  const isLong = direction === 'BUY (LONG)';

  const precision = entryPrice > 500 ? 2 : entryPrice > 1 ? 4 : 6;
  const stopLoss = isLong
    ? Number((entryPrice * (1 - slPct / 100)).toFixed(precision))
    : Number((entryPrice * (1 + slPct / 100)).toFixed(precision));

  const takeProfit1 = isLong
    ? Number((entryPrice * (1 + tp1Pct / 100)).toFixed(precision))
    : Number((entryPrice * (1 - tp1Pct / 100)).toFixed(precision));

  const takeProfit2 = isLong
    ? Number((entryPrice * (1 + tp2Pct / 100)).toFixed(precision))
    : Number((entryPrice * (1 - tp2Pct / 100)).toFixed(precision));

  const riskReward = (tp1Pct / slPct).toFixed(2);
  const estProfit = ((sizeUsd * leverage * tp1Pct) / 100).toFixed(2);
  const estLoss = ((sizeUsd * leverage * slPct) / 100).toFixed(2);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onExecutePushTrade({
      symbol: selectedSymbol,
      direction,
      entryPrice,
      stopLoss,
      takeProfit1,
      takeProfit2,
      leverage,
      sizeUsd,
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-slate-950/80 backdrop-blur-md">
      <div className="bg-slate-900 border border-slate-700/80 rounded-2xl w-full max-w-lg overflow-hidden shadow-2xl animate-in fade-in zoom-in-95 duration-150">
        {/* Header */}
        <div className="p-4 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-emerald-500/20 text-emerald-400 flex items-center justify-center font-bold">
              <Zap className="w-4 h-4 fill-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Binance Instant Push Order</h2>
              <span className="text-[10px] text-slate-400">
                Mode: {apiSettings.network.replace('_', ' ')} • Real-time Fill
              </span>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form Body */}
        <form onSubmit={handleSubmit} className="p-4 space-y-4 text-xs">
          {/* Pair & Direction */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-slate-300 block mb-1">
                Select Pair
              </label>
              <select
                value={selectedSymbol}
                onChange={(e) => setSelectedSymbol(e.target.value)}
                className="w-full bg-slate-950 text-white font-bold p-2.5 rounded-xl border border-slate-700 focus:outline-none focus:border-amber-500"
              >
                {assets.map((a) => (
                  <option key={a.symbol} value={a.symbol}>
                    {a.symbol} (${a.price < 1 ? a.price.toFixed(4) : a.price.toFixed(2)})
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-slate-300 block mb-1">
                Direction
              </label>
              <div className="grid grid-cols-2 gap-1.5 bg-slate-950 p-1 rounded-xl border border-slate-800">
                <button
                  type="button"
                  onClick={() => setDirection('BUY (LONG)')}
                  className={`py-1.5 rounded-lg font-bold flex items-center justify-center gap-1 transition-all ${
                    isLong
                      ? 'bg-emerald-600 text-slate-950 shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <ArrowUpRight className="w-3.5 h-3.5" />
                  <span>LONG</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDirection('SELL (SHORT)')}
                  className={`py-1.5 rounded-lg font-bold flex items-center justify-center gap-1 transition-all ${
                    !isLong
                      ? 'bg-rose-600 text-white shadow-md'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  <ArrowDownRight className="w-3.5 h-3.5" />
                  <span>SHORT</span>
                </button>
              </div>
            </div>
          </div>

          {/* Size & Leverage */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-semibold text-slate-300 block mb-1">
                Position Size (USDT)
              </label>
              <div className="relative">
                <DollarSign className="w-4 h-4 text-slate-500 absolute left-2.5 top-2.5" />
                <input
                  type="number"
                  min="50"
                  step="50"
                  value={sizeUsd}
                  onChange={(e) => setSizeUsd(Math.max(50, Number(e.target.value)))}
                  className="w-full bg-slate-950 text-white font-mono font-bold pl-8 pr-3 py-2 rounded-xl border border-slate-700 focus:outline-none focus:border-amber-500"
                />
              </div>
            </div>

            <div>
              <label className="text-[11px] font-semibold text-slate-300 block mb-1">
                Leverage ({leverage}x)
              </label>
              <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-xl border border-slate-800">
                {[1, 5, 10, 20].map((lev) => (
                  <button
                    type="button"
                    key={lev}
                    onClick={() => setLeverage(lev)}
                    className={`flex-1 py-1 rounded-lg font-bold text-center text-xs transition-all ${
                      leverage === lev
                        ? 'bg-amber-500 text-slate-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {lev}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* TP & SL Percentages */}
          <div className="bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 space-y-2">
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-slate-300">Target 1 (+{tp1Pct}%):</span>
              <span className="font-mono font-bold text-emerald-400">${takeProfit1}</span>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-slate-300">Target 2 (+{tp2Pct}%):</span>
              <span className="font-mono font-bold text-emerald-300">${takeProfit2}</span>
            </div>
            <div className="flex items-center justify-between text-[11px]">
              <span className="font-semibold text-slate-300">Stop Loss (-{slPct}%):</span>
              <span className="font-mono font-bold text-rose-400">${stopLoss}</span>
            </div>
          </div>

          {/* Risk Preview Card */}
          <div className="grid grid-cols-3 gap-2 bg-slate-950/40 p-2.5 rounded-xl border border-slate-800 text-center">
            <div>
              <span className="text-[10px] text-slate-500 block">Est Profit (TP1)</span>
              <span className="font-mono font-bold text-emerald-400">+${estProfit}</span>
            </div>
            <div>
              <span className="text-[10px] text-slate-500 block">Est Loss (SL)</span>
              <span className="font-mono font-bold text-rose-400">-${estLoss}</span>
            </div>
            <div>
              <span className="text-[10px] text-slate-500 block">Risk : Reward</span>
              <span className="font-mono font-bold text-amber-400">{riskReward}:1</span>
            </div>
          </div>

          {/* Submit Push Trade Button */}
          <button
            type="submit"
            className="w-full py-3 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 hover:brightness-110 active:scale-98 text-slate-950 font-extrabold text-sm shadow-lg shadow-emerald-500/25 flex items-center justify-center gap-2 transition-all"
          >
            <Zap className="w-4 h-4 fill-slate-950" />
            <span>PUSH TRADE TO BINANCE NOW</span>
          </button>
        </form>
      </div>
    </div>
  );
};
