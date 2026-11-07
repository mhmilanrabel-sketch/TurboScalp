import React from 'react';
import {
  Bot,
  Play,
  Square,
  Zap,
  RotateCw,
  ShieldAlert,
  Flame,
  CheckCircle2,
  Settings2,
} from 'lucide-react';
import { AutoPilotConfig } from '../types';

interface AutoPilotControlsProps {
  config: AutoPilotConfig;
  onUpdateConfig: (newConfig: Partial<AutoPilotConfig>) => void;
  isScanning: boolean;
  onManualScanNow: () => void;
  activeTradesCount: number;
  onCloseAllTrades: () => void;
}

export const AutoPilotControls: React.FC<AutoPilotControlsProps> = ({
  config,
  onUpdateConfig,
  isScanning,
  onManualScanNow,
  activeTradesCount,
  onCloseAllTrades,
}) => {
  return (
    <div className="bg-gradient-to-r from-slate-900 via-slate-900 to-indigo-950/70 border border-slate-800 rounded-2xl p-3.5 sm:p-4 shadow-xl">
      <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 sm:gap-4">
        {/* Left: Master Auto-Pilot Switch & State */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onUpdateConfig({ enabled: !config.enabled })}
            className={`relative flex items-center gap-2.5 px-4 py-2.5 rounded-xl font-extrabold text-xs sm:text-sm tracking-wide transition-all shadow-lg active:scale-95 ${
              config.enabled
                ? 'bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 shadow-emerald-500/25 ring-2 ring-emerald-400/50'
                : 'bg-slate-800 text-slate-300 border border-slate-700 hover:bg-slate-750'
            }`}
          >
            <Bot className={`w-5 h-5 ${config.enabled ? 'animate-bounce text-slate-950' : 'text-slate-400'}`} />
            <span>{config.enabled ? 'AUTO-PILOT ACTIVE' : 'START AUTO-PILOT'}</span>
            {config.enabled ? (
              <span className="w-2.5 h-2.5 rounded-full bg-slate-950 animate-ping" />
            ) : (
              <Play className="w-3.5 h-3.5 fill-current" />
            )}
          </button>

          {/* Quick 1-Click Scan Now Button */}
          <button
            onClick={onManualScanNow}
            disabled={isScanning}
            className={`px-3 py-2 rounded-xl text-xs font-bold border transition-all flex items-center gap-1.5 ${
              isScanning
                ? 'bg-amber-500/20 text-amber-300 border-amber-500/40 cursor-wait'
                : 'bg-slate-800/80 text-slate-200 border-slate-700 hover:bg-slate-700/80 hover:text-white'
            }`}
          >
            <RotateCw className={`w-3.5 h-3.5 text-amber-400 ${isScanning ? 'animate-spin' : ''}`} />
            <span>{isScanning ? 'Scanning...' : 'Scan Now'}</span>
          </button>

          {/* Emergency Close All button */}
          {activeTradesCount > 0 && (
            <button
              onClick={onCloseAllTrades}
              className="px-2.5 py-2 rounded-xl text-xs font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30 hover:bg-rose-500/25 transition-all flex items-center gap-1"
              title="Close all open trades immediately"
            >
              <Square className="w-3.5 h-3.5 fill-rose-400 stroke-rose-400" />
              <span className="hidden sm:inline">Close All ({activeTradesCount})</span>
            </button>
          )}
        </div>

        {/* Center / Right: Engine Parameters */}
        <div className="flex flex-wrap items-center gap-2 sm:gap-3 text-xs">
          {/* Scan Frequency */}
          <div className="flex items-center gap-1 bg-slate-950/70 p-1 rounded-xl border border-slate-800">
            <span className="text-[10px] text-slate-400 font-medium px-1.5 hidden sm:inline">Scan Rate:</span>
            {[
              { label: '1s Ultra', sec: 1 },
              { label: '2s Scalp', sec: 2 },
              { label: '5s Swing', sec: 5 },
            ].map((rate) => (
              <button
                key={rate.sec}
                onClick={() => onUpdateConfig({ scanIntervalSec: rate.sec })}
                className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-all ${
                  config.scanIntervalSec === rate.sec
                    ? 'bg-amber-500 text-slate-950 shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {rate.label}
              </button>
            ))}
          </div>

          {/* Direction Filter */}
          <div className="flex items-center gap-1 bg-slate-950/70 p-1 rounded-xl border border-slate-800">
            {[
              { label: 'BOTH', val: 'BOTH' as const },
              { label: 'LONG', val: 'LONG_ONLY' as const },
              { label: 'SHORT', val: 'SHORT_ONLY' as const },
            ].map((dir) => (
              <button
                key={dir.val}
                onClick={() => onUpdateConfig({ allowedDirections: dir.val })}
                className={`px-2 py-1 rounded-lg text-[11px] font-bold transition-all ${
                  config.allowedDirections === dir.val
                    ? 'bg-indigo-600 text-white shadow-sm'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {dir.label}
              </button>
            ))}
          </div>

          {/* Minimum Confluence */}
          <div className="flex items-center gap-1.5 bg-slate-950/70 px-2.5 py-1.5 rounded-xl border border-slate-800">
            <span className="text-[10px] text-slate-400 font-medium">Min Conf:</span>
            <select
              value={config.minConfidenceScore}
              onChange={(e) => onUpdateConfig({ minConfidenceScore: Number(e.target.value) })}
              className="bg-transparent text-amber-400 font-bold text-xs focus:outline-none cursor-pointer"
            >
              <option value="80" className="bg-slate-900 text-slate-100">80% Conf</option>
              <option value="85" className="bg-slate-900 text-slate-100">85% High</option>
              <option value="90" className="bg-slate-900 text-slate-100">90% Ultra</option>
              <option value="95" className="bg-slate-900 text-slate-100">95% Elite</option>
            </select>
          </div>

          {/* Leverage & Size */}
          <div className="flex items-center gap-1.5 bg-slate-950/70 px-2.5 py-1.5 rounded-xl border border-slate-800">
            <span className="text-[10px] text-slate-400 font-medium">Lev:</span>
            <select
              value={config.leverage}
              onChange={(e) => onUpdateConfig({ leverage: Number(e.target.value) })}
              className="bg-transparent text-emerald-400 font-bold text-xs focus:outline-none cursor-pointer"
            >
              <option value="5" className="bg-slate-900 text-slate-100">5x</option>
              <option value="10" className="bg-slate-900 text-slate-100">10x</option>
              <option value="20" className="bg-slate-900 text-slate-100">20x</option>
              <option value="25" className="bg-slate-900 text-slate-100">25x</option>
            </select>
            <span className="text-slate-600">|</span>
            <span className="text-[10px] text-slate-400 font-medium">Size:</span>
            <select
              value={config.tradeSizeUsd}
              onChange={(e) => onUpdateConfig({ tradeSizeUsd: Number(e.target.value) })}
              className="bg-transparent text-amber-300 font-bold text-xs focus:outline-none cursor-pointer"
            >
              <option value="250" className="bg-slate-900 text-slate-100">$250</option>
              <option value="500" className="bg-slate-900 text-slate-100">$500</option>
              <option value="1000" className="bg-slate-900 text-slate-100">$1,000</option>
              <option value="2500" className="bg-slate-900 text-slate-100">$2,500</option>
            </select>
          </div>

          {/* Auto Breakeven Toggle */}
          <button
            onClick={() => onUpdateConfig({ autoMoveBreakevenAtTp1: !config.autoMoveBreakevenAtTp1 })}
            className={`px-2.5 py-1.5 rounded-xl border text-[11px] font-medium flex items-center gap-1 transition-all ${
              config.autoMoveBreakevenAtTp1
                ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30'
                : 'bg-slate-900 text-slate-400 border-slate-800'
            }`}
            title="Automatically move Stop Loss to Entry once Take Profit 1 is reached"
          >
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
            <span className="hidden xl:inline">Auto Breakeven SL</span>
          </button>
        </div>
      </div>
    </div>
  );
};
