import React from 'react';
import {
  Activity,
  Bot,
  Sliders,
  Bell,
  BarChart3,
  Key,
  ShieldCheck,
  Wifi,
  WifiOff,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import { BinanceApiSettings } from '../types';

export type NavTab = 'dashboard' | 'scanner' | 'positions' | 'analytics' | 'alerts';

interface HeaderProps {
  activeTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  connectionStatus: 'LIVE' | 'RECONNECTING' | 'OFFLINE';
  latencyMs: number;
  apiSettings: BinanceApiSettings;
  onOpenApiModal: () => void;
  onOpenPushTradeModal: () => void;
  isAutoPilotActive: boolean;
  activePositionsCount: number;
  unreadAlertsCount: number;
  isAudioMuted: boolean;
  onToggleAudio: () => void;
  totalPnlUsd: number;
}

export const Header: React.FC<HeaderProps> = ({
  activeTab,
  onTabChange,
  connectionStatus,
  latencyMs,
  apiSettings,
  onOpenApiModal,
  onOpenPushTradeModal,
  isAutoPilotActive,
  activePositionsCount,
  unreadAlertsCount,
  isAudioMuted,
  onToggleAudio,
  totalPnlUsd,
}) => {
  const isDemo = apiSettings.network === 'DEMO_PAPER';
  const balance = isDemo ? (apiSettings.demoBalance || 10000) : (apiSettings.usdtBalance || 0);

  return (
    <header className="bg-slate-900/90 border-b border-slate-800 backdrop-blur-md sticky top-0 z-40 select-none">
      <div className="max-w-7xl mx-auto px-3 sm:px-4 h-16 flex items-center justify-between gap-2 sm:gap-4">
        {/* Logo and Brand */}
        <div className="flex items-center gap-3">
          <div className="relative flex items-center justify-center w-10 h-10 rounded-xl bg-gradient-to-tr from-amber-500 via-orange-500 to-yellow-400 shadow-lg shadow-amber-500/20 text-slate-950 font-black">
            <Zap className="w-5 h-5 fill-slate-950 stroke-slate-950" />
            <span className="absolute -bottom-1 -right-1 w-3 h-3 bg-emerald-400 rounded-full border-2 border-slate-900 animate-pulse" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-base sm:text-lg tracking-tight bg-gradient-to-r from-amber-400 via-yellow-200 to-orange-400 bg-clip-text text-transparent">
                TurboScalp
              </span>
              <span className="text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">
                Binance Pro
              </span>
            </div>
            <div className="hidden sm:flex items-center gap-2 text-xs text-slate-400">
              <span className="flex items-center gap-1">
                {connectionStatus === 'LIVE' ? (
                  <>
                    <Wifi className="w-3 h-3 text-emerald-400" />
                    <span className="text-emerald-400 font-medium">WS Live</span>
                    <span className="text-[10px] text-slate-500">({latencyMs}ms)</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="w-3 h-3 text-rose-400" />
                    <span className="text-rose-400 font-medium">Reconnecting...</span>
                  </>
                )}
              </span>
              <span className="text-slate-600">•</span>
              <span className="text-slate-400">{apiSettings.network.replace('_', ' ')}</span>
            </div>
          </div>
        </div>

        {/* Navigation Tabs */}
        <nav className="hidden md:flex items-center gap-1 bg-slate-950/60 p-1 rounded-xl border border-slate-800/80">
          <button
            onClick={() => onTabChange('dashboard')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'dashboard'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20 font-bold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Activity className="w-3.5 h-3.5" />
            <span>Terminal</span>
          </button>

          <button
            onClick={() => onTabChange('scanner')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 relative ${
              activeTab === 'scanner'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20 font-bold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Bot className="w-3.5 h-3.5" />
            <span>Auto-Radar</span>
            {isAutoPilotActive && (
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping" />
            )}
          </button>

          <button
            onClick={() => onTabChange('positions')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'positions'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20 font-bold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Sliders className="w-3.5 h-3.5" />
            <span>Positions</span>
            {activePositionsCount > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/30">
                {activePositionsCount}
              </span>
            )}
          </button>

          <button
            onClick={() => onTabChange('analytics')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
              activeTab === 'analytics'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20 font-bold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <BarChart3 className="w-3.5 h-3.5" />
            <span>Analytics</span>
          </button>

          <button
            onClick={() => onTabChange('alerts')}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 relative ${
              activeTab === 'alerts'
                ? 'bg-amber-500 text-slate-950 shadow-md shadow-amber-500/20 font-bold'
                : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
            }`}
          >
            <Bell className="w-3.5 h-3.5" />
            <span>Alerts</span>
            {unreadAlertsCount > 0 && (
              <span className="w-4 h-4 rounded-full bg-rose-500 text-white text-[10px] flex items-center justify-center font-bold">
                {unreadAlertsCount}
              </span>
            )}
          </button>
        </nav>

        {/* Right side stats & action controls */}
        <div className="flex items-center gap-2 sm:gap-3">
          {/* Quick Balance Display */}
          <div className="hidden sm:flex flex-col items-end">
            <span className="text-[10px] uppercase font-semibold text-slate-400">
              {isDemo ? 'Virtual Balance' : 'Binance USDT'}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="font-bold text-sm text-slate-100">
                ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              <span
                className={`text-xs font-semibold ${
                  totalPnlUsd >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                ({totalPnlUsd >= 0 ? '+' : ''}${totalPnlUsd.toFixed(2)})
              </span>
            </div>
          </div>

          {/* Quick Manual Push Trade Button */}
          <button
            onClick={onOpenPushTradeModal}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 text-slate-950 font-bold text-xs flex items-center gap-1.5 shadow-md shadow-emerald-500/20 hover:brightness-110 active:scale-95 transition-all"
            title="Instant Push Trade to Binance"
          >
            <Zap className="w-3.5 h-3.5 fill-slate-950" />
            <span className="hidden sm:inline">Push Trade</span>
          </button>

          {/* Audio Mute Toggle */}
          <button
            onClick={onToggleAudio}
            className={`p-2 rounded-xl border transition-all ${
              isAudioMuted
                ? 'bg-slate-800/60 text-slate-400 border-slate-700/80 hover:text-slate-200'
                : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
            }`}
            title={isAudioMuted ? 'Unmute alert sounds' : 'Mute alert sounds'}
            aria-label="Toggle Alert Sounds"
          >
            {isAudioMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
          </button>

          {/* API Setup Button */}
          <button
            onClick={onOpenApiModal}
            className={`p-2 rounded-xl border transition-all flex items-center gap-1.5 ${
              apiSettings.isConfigured
                ? 'bg-slate-800/80 text-emerald-400 border-emerald-500/30 hover:bg-slate-800'
                : 'bg-slate-800/80 text-amber-400 border-amber-500/30 hover:bg-slate-800'
            }`}
            title="Binance API & Network Settings"
            aria-label="Binance API Settings"
          >
            <Key className="w-4 h-4" />
            <span className="hidden xl:inline text-xs font-medium text-slate-300">
              {isDemo ? 'Demo Mode' : 'API Config'}
            </span>
            {apiSettings.isConfigured ? (
              <ShieldCheck className="w-3.5 h-3.5 text-emerald-400 hidden xl:inline" />
            ) : null}
          </button>
        </div>
      </div>

      {/* Mobile sub-tabs */}
      <div className="flex md:hidden items-center justify-around border-t border-slate-800/80 bg-slate-950/70 py-1.5 px-2">
        <button
          onClick={() => onTabChange('dashboard')}
          className={`px-2.5 py-1 text-xs font-medium rounded-lg ${
            activeTab === 'dashboard' ? 'bg-amber-500/20 text-amber-400 font-bold' : 'text-slate-400'
          }`}
        >
          Terminal
        </button>
        <button
          onClick={() => onTabChange('scanner')}
          className={`px-2.5 py-1 text-xs font-medium rounded-lg flex items-center gap-1 ${
            activeTab === 'scanner' ? 'bg-amber-500/20 text-amber-400 font-bold' : 'text-slate-400'
          }`}
        >
          <span>Auto-Radar</span>
          {isAutoPilotActive && <span className="w-1.5 h-1.5 bg-emerald-400 rounded-full animate-ping" />}
        </button>
        <button
          onClick={() => onTabChange('positions')}
          className={`px-2.5 py-1 text-xs font-medium rounded-lg flex items-center gap-1 ${
            activeTab === 'positions' ? 'bg-amber-500/20 text-amber-400 font-bold' : 'text-slate-400'
          }`}
        >
          <span>Positions</span>
          {activePositionsCount > 0 && (
            <span className="px-1 text-[10px] bg-amber-500/20 text-amber-300 rounded-full">
              {activePositionsCount}
            </span>
          )}
        </button>
        <button
          onClick={() => onTabChange('analytics')}
          className={`px-2.5 py-1 text-xs font-medium rounded-lg ${
            activeTab === 'analytics' ? 'bg-amber-500/20 text-amber-400 font-bold' : 'text-slate-400'
          }`}
        >
          Analytics
        </button>
        <button
          onClick={() => onTabChange('alerts')}
          className={`px-2.5 py-1 text-xs font-medium rounded-lg relative ${
            activeTab === 'alerts' ? 'bg-amber-500/20 text-amber-400 font-bold' : 'text-slate-400'
          }`}
        >
          Alerts
          {unreadAlertsCount > 0 && (
            <span className="absolute -top-0.5 -right-1 w-3.5 h-3.5 bg-rose-500 text-[9px] rounded-full text-white flex items-center justify-center">
              {unreadAlertsCount}
            </span>
          )}
        </button>
      </div>
    </header>
  );
};
