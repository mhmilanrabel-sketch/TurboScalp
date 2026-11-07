import React, { useEffect, useState } from 'react';
import { TradeSignal } from '../types';
import {
  ArrowUpRight,
  ArrowDownRight,
  ShieldCheck,
  CheckCircle2,
  XCircle,
  Clock,
  Zap,
  Flame,
  Percent,
} from 'lucide-react';

interface ActivePositionsProps {
  positions: TradeSignal[];
  onClosePosition: (id: string) => void;
  onMoveBreakeven: (id: string) => void;
  onPartialTakeProfit: (id: string) => void;
}

export const ActivePositions: React.FC<ActivePositionsProps> = ({
  positions,
  onClosePosition,
  onMoveBreakeven,
  onPartialTakeProfit,
}) => {
  const [, setTick] = useState(0);

  // Re-render every second to update elapsed holding durations
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  const formatElapsed = (startTime?: number): string => {
    if (!startTime) return '0m 00s';
    const elapsedSecs = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
    const mins = Math.floor(elapsedSecs / 60);
    const secs = elapsedSecs % 60;
    return `${mins}m ${secs < 10 ? '0' : ''}${secs}s`;
  };

  if (positions.length === 0) {
    return (
      <div className="bg-slate-900/60 border border-slate-800 rounded-2xl p-8 text-center">
        <div className="w-12 h-12 rounded-2xl bg-slate-800/80 border border-slate-700 mx-auto flex items-center justify-center text-slate-500 mb-3">
          <Zap className="w-6 h-6" />
        </div>
        <h3 className="text-sm font-bold text-slate-200">No Active Positions</h3>
        <p className="text-xs text-slate-400 mt-1 max-w-sm mx-auto">
          Start Auto-Pilot or click &apos;Push Trade&apos; on any pair from the Scanner Radar to execute instant automated trades.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-bold text-slate-200 flex items-center gap-1.5">
            <Flame className="w-4 h-4 text-amber-400" />
            <span>Active Binance Push Trades</span>
          </h3>
          <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
            {positions.length} Live
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {positions.map((pos) => {
          const isLong = pos.direction === 'BUY (LONG)';
          const isProfit = (pos.pnlPercentage ?? 0) >= 0;
          const leverage = pos.leverage || 10;
          const posSize = pos.positionSizeUsd || 500;
          const elapsed = formatElapsed(pos.startTime);

          return (
            <div
              key={pos.id}
              className={`bg-slate-900/90 border rounded-2xl p-4 transition-all relative overflow-hidden ${
                isProfit
                  ? 'border-emerald-500/40 shadow-lg shadow-emerald-950/20'
                  : 'border-rose-500/40 shadow-lg shadow-rose-950/20'
              }`}
            >
              {/* Top Row: Symbol, Direction, Elapsed */}
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-extrabold text-base text-white">{pos.symbol}</span>
                  <span
                    className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold flex items-center gap-1 ${
                      isLong
                        ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/20 text-rose-300 border border-rose-500/30'
                    }`}
                  >
                    {isLong ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                    <span>{pos.direction}</span>
                  </span>
                  <span className="px-1.5 py-0.5 rounded text-[10px] font-bold bg-slate-800 text-slate-400 border border-slate-700">
                    {leverage}x Lev
                  </span>
                </div>

                <div className="flex items-center gap-1 text-[11px] text-slate-400 font-mono">
                  <Clock className="w-3 h-3 text-slate-500" />
                  <span>{elapsed}</span>
                </div>
              </div>

              {/* Status & PnL Highlight Banner */}
              <div className="mt-3 bg-slate-950/70 p-3 rounded-xl border border-slate-800 flex items-center justify-between">
                <div>
                  <div className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">
                    Unrealized PnL
                  </div>
                  <div className="flex items-baseline gap-2">
                    <span
                      className={`text-xl font-black font-mono tracking-tight ${
                        isProfit ? 'text-emerald-400' : 'text-rose-400'
                      }`}
                    >
                      {isProfit ? '+' : ''}{pos.pnlPercentage.toFixed(2)}%
                    </span>
                    <span
                      className={`text-xs font-bold font-mono ${
                        isProfit ? 'text-emerald-500' : 'text-rose-500'
                      }`}
                    >
                      ({isProfit ? '+' : ''}${pos.pnlUsd?.toFixed(2) || '0.00'})
                    </span>
                  </div>
                </div>

                <div className="text-right">
                  <span className="text-[10px] text-slate-400 font-medium block">Position Size</span>
                  <span className="font-mono text-sm font-bold text-slate-200">
                    ${posSize} USDT
                  </span>
                </div>
              </div>

              {/* Price Targets Matrix */}
              <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                <div className="bg-slate-950/40 p-2 rounded-lg border border-slate-800/80">
                  <span className="text-[10px] text-slate-500 block">Entry Price</span>
                  <span className="font-mono font-bold text-slate-300">
                    ${pos.entryPrice < 1 ? pos.entryPrice.toFixed(4) : pos.entryPrice.toLocaleString()}
                  </span>
                </div>

                <div className="bg-slate-950/40 p-2 rounded-lg border border-slate-800/80">
                  <span className="text-[10px] text-slate-500 block">Current Price</span>
                  <span className="font-mono font-bold text-white">
                    ${pos.currentPrice < 1 ? pos.currentPrice.toFixed(4) : pos.currentPrice.toLocaleString()}
                  </span>
                </div>

                <div className="bg-slate-950/40 p-2 rounded-lg border border-slate-800/80">
                  <span className="text-[10px] text-emerald-400 block font-semibold">Target (TP1)</span>
                  <span className="font-mono font-bold text-emerald-300">
                    ${pos.takeProfit1 < 1 ? pos.takeProfit1.toFixed(4) : pos.takeProfit1.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* SL & Breakeven status */}
              <div className="flex items-center justify-between text-xs mt-2 px-1 text-slate-400">
                <div className="flex items-center gap-1.5">
                  <span className="text-rose-400 font-medium">SL:</span>
                  <span className="font-mono font-bold text-rose-300">
                    ${pos.stopLoss < 1 ? pos.stopLoss.toFixed(4) : pos.stopLoss.toLocaleString()}
                  </span>
                  {pos.breakevenApplied && (
                    <span className="px-1.5 py-0.2 rounded text-[9px] font-bold bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 flex items-center gap-0.5">
                      <ShieldCheck className="w-2.5 h-2.5" />
                      Breakeven Locked
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-1 text-[10px] text-amber-400 font-medium">
                  <span>Confidence: {pos.confidenceScore}%</span>
                </div>
              </div>

              {/* Action buttons: Breakeven, Partial TP, Close */}
              <div className="grid grid-cols-3 gap-2 mt-3 pt-3 border-t border-slate-800">
                <button
                  onClick={() => onMoveBreakeven(pos.id)}
                  disabled={pos.breakevenApplied}
                  className={`py-1.5 px-2 rounded-xl text-xs font-bold border transition-all flex items-center justify-center gap-1 ${
                    pos.breakevenApplied
                      ? 'bg-slate-800/40 text-slate-500 border-slate-800 cursor-not-allowed'
                      : 'bg-indigo-500/10 text-indigo-300 border-indigo-500/30 hover:bg-indigo-500/20 active:scale-95'
                  }`}
                  title="Move Stop Loss to Entry Price (Zero Risk)"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Breakeven</span>
                </button>

                <button
                  onClick={() => onPartialTakeProfit(pos.id)}
                  className="py-1.5 px-2 rounded-xl text-xs font-bold bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20 active:scale-95 transition-all flex items-center justify-center gap-1"
                  title="Close 50% of position size to secure profits"
                >
                  <Percent className="w-3.5 h-3.5 text-emerald-400" />
                  <span>Take 50%</span>
                </button>

                <button
                  onClick={() => onClosePosition(pos.id)}
                  className="py-1.5 px-2 rounded-xl text-xs font-bold bg-rose-500/15 text-rose-300 border border-rose-500/30 hover:bg-rose-500/25 active:scale-95 transition-all flex items-center justify-center gap-1"
                  title="Close entire trade now"
                >
                  <XCircle className="w-3.5 h-3.5 text-rose-400" />
                  <span>Close</span>
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
