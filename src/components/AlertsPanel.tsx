import React, { useState } from 'react';
import { TradeAlert, CustomAlertRule, MarketAsset } from '../types';
import {
  Bell,
  CheckCircle2,
  AlertTriangle,
  Zap,
  Trash2,
  Plus,
  ShieldAlert,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';

interface AlertsPanelProps {
  alerts: TradeAlert[];
  onClearAlerts: () => void;
  onMarkRead: (id: string) => void;
  customRules: CustomAlertRule[];
  onAddRule: (rule: Omit<CustomAlertRule, 'id' | 'triggered' | 'active' | 'createdAt'>) => void;
  onToggleRule: (id: string) => void;
  onDeleteRule: (id: string) => void;
  assets: MarketAsset[];
}

export const AlertsPanel: React.FC<AlertsPanelProps> = ({
  alerts,
  onClearAlerts,
  onMarkRead,
  customRules,
  onAddRule,
  onToggleRule,
  onDeleteRule,
  assets,
}) => {
  const [activeTab, setActiveTab] = useState<'feed' | 'custom'>('feed');
  const [symbol, setSymbol] = useState(assets[0]?.symbol || 'BTC/USDT');
  const [condition, setCondition] = useState<CustomAlertRule['condition']>('PRICE_ABOVE');
  const [targetValue, setTargetValue] = useState<number>(93000);

  const handleCreateRule = (e: React.FormEvent) => {
    e.preventDefault();
    onAddRule({
      symbol,
      condition,
      targetValue,
    });
    // Reset to sensible target
    const asset = assets.find((a) => a.symbol === symbol);
    if (asset) setTargetValue(Number((asset.price * 1.02).toFixed(2)));
  };

  return (
    <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-4 shadow-xl space-y-4">
      {/* Top Header & Sub-tabs */}
      <div className="flex items-center justify-between border-b border-slate-800 pb-3">
        <div className="flex items-center gap-2">
          <Bell className="w-4 h-4 text-amber-400" />
          <h2 className="text-sm font-bold text-white">Instant Alerts & Trigger Center</h2>
        </div>

        <div className="flex items-center gap-2">
          <div className="flex items-center bg-slate-950 p-1 rounded-xl border border-slate-800 text-xs">
            <button
              onClick={() => setActiveTab('feed')}
              className={`px-3 py-1 rounded-lg font-bold transition-all ${
                activeTab === 'feed'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Alert Feed ({alerts.length})
            </button>
            <button
              onClick={() => setActiveTab('custom')}
              className={`px-3 py-1 rounded-lg font-bold transition-all ${
                activeTab === 'custom'
                  ? 'bg-amber-500 text-slate-950'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Custom Triggers ({customRules.length})
            </button>
          </div>

          {activeTab === 'feed' && alerts.length > 0 && (
            <button
              onClick={onClearAlerts}
              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-800 transition-colors"
              title="Clear all alerts"
            >
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Tab: Real-Time Alerts Feed */}
      {activeTab === 'feed' ? (
        <div className="space-y-2 max-h-[460px] overflow-y-auto pr-1">
          {alerts.length === 0 ? (
            <div className="text-center py-10 text-slate-500">
              <Bell className="w-8 h-8 mx-auto text-slate-600 mb-2 opacity-50" />
              <p className="text-xs">No alerts triggered yet. Turn on Auto-Pilot to receive instant notifications.</p>
            </div>
          ) : (
            alerts.map((alert) => (
              <div
                key={alert.id}
                onClick={() => onMarkRead(alert.id)}
                className={`p-3 rounded-xl border text-xs transition-all flex items-start justify-between gap-3 ${
                  alert.level === 'success'
                    ? 'bg-emerald-950/30 border-emerald-500/30 text-emerald-200'
                    : alert.level === 'danger'
                    ? 'bg-rose-950/30 border-rose-500/30 text-rose-200'
                    : alert.level === 'warning'
                    ? 'bg-amber-950/30 border-amber-500/30 text-amber-200'
                    : 'bg-slate-950/50 border-slate-800 text-slate-300'
                }`}
              >
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5">
                    {alert.level === 'success' ? (
                      <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                    ) : alert.level === 'danger' ? (
                      <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
                    ) : (
                      <Zap className="w-4 h-4 text-amber-400 shrink-0" />
                    )}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-white text-xs">{alert.title}</span>
                      <span className="font-mono text-[10px] text-slate-400 font-bold px-1.5 py-0.2 rounded bg-slate-900 border border-slate-700">
                        {alert.symbol}
                      </span>
                    </div>
                    <p className="text-slate-300 text-xs mt-0.5 leading-relaxed">{alert.message}</p>
                  </div>
                </div>
                <span className="text-[10px] text-slate-500 font-mono shrink-0">
                  {alert.timestamp}
                </span>
              </div>
            ))
          )}
        </div>
      ) : (
        /* Tab: Custom Alert Builder */
        <div className="space-y-4">
          <form onSubmit={handleCreateRule} className="bg-slate-950/70 p-4 rounded-xl border border-slate-800 space-y-3 text-xs">
            <h3 className="font-bold text-slate-200 text-xs flex items-center gap-1.5">
              <Plus className="w-4 h-4 text-emerald-400" />
              <span>Create Instant Webhook / Audio Alert Rule</span>
            </h3>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="text-[10px] text-slate-400 font-medium block mb-1">Asset Symbol</label>
                <select
                  value={symbol}
                  onChange={(e) => {
                    setSymbol(e.target.value);
                    const a = assets.find((x) => x.symbol === e.target.value);
                    if (a) setTargetValue(Number((a.price * 1.01).toFixed(2)));
                  }}
                  className="w-full bg-slate-900 text-white font-bold p-2 rounded-lg border border-slate-700"
                >
                  {assets.map((a) => (
                    <option key={a.symbol} value={a.symbol}>
                      {a.symbol} (${a.price < 1 ? a.price.toFixed(4) : a.price.toFixed(2)})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 font-medium block mb-1">Trigger Condition</label>
                <select
                  value={condition}
                  onChange={(e) => setCondition(e.target.value as any)}
                  className="w-full bg-slate-900 text-white font-bold p-2 rounded-lg border border-slate-700"
                >
                  <option value="PRICE_ABOVE">Price Above (&gt;=)</option>
                  <option value="PRICE_BELOW">Price Below (&lt;=)</option>
                  <option value="RSI_OVERSOLD">RSI Oversold (&lt;= 30)</option>
                  <option value="RSI_OVERBOUGHT">RSI Overbought (&gt;= 70)</option>
                  <option value="CONFLUENCE_HIGH">Confluence Score &gt;= 90%</option>
                </select>
              </div>

              <div>
                <label className="text-[10px] text-slate-400 font-medium block mb-1">Target Value</label>
                <input
                  type="number"
                  step="any"
                  value={targetValue}
                  onChange={(e) => setTargetValue(Number(e.target.value))}
                  className="w-full bg-slate-900 text-white font-mono font-bold p-2 rounded-lg border border-slate-700"
                />
              </div>
            </div>

            <button
              type="submit"
              className="px-4 py-2 rounded-xl bg-amber-500 hover:bg-amber-400 active:scale-95 text-slate-950 font-bold transition-all shadow-md flex items-center gap-1.5"
            >
              <Plus className="w-4 h-4" />
              <span>Arm Alert Rule</span>
            </button>
          </form>

          {/* Rules List */}
          <div className="space-y-2">
            <h4 className="text-xs font-bold text-slate-400">Armed Alert Rules</h4>
            {customRules.length === 0 ? (
              <p className="text-xs text-slate-500 italic">No custom alert rules armed.</p>
            ) : (
              customRules.map((rule) => (
                <div
                  key={rule.id}
                  className="p-3 bg-slate-950/50 border border-slate-800 rounded-xl flex items-center justify-between text-xs"
                >
                  <div className="flex items-center gap-3">
                    <button
                      onClick={() => onToggleRule(rule.id)}
                      className={`w-3 h-3 rounded-full ${
                        rule.active ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600'
                      }`}
                      title={rule.active ? 'Rule Active' : 'Rule Paused'}
                    />
                    <div>
                      <span className="font-bold text-white mr-2">{rule.symbol}</span>
                      <span className="text-slate-400">
                        {rule.condition.replace('_', ' ')}: <span className="font-mono text-amber-400 font-bold">{rule.targetValue}</span>
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2">
                    {rule.triggered && (
                      <span className="px-2 py-0.5 rounded bg-rose-500/20 text-rose-300 text-[10px] font-bold">
                        TRIGGERED
                      </span>
                    )}
                    <button
                      onClick={() => onDeleteRule(rule.id)}
                      className="p-1 rounded text-slate-500 hover:text-rose-400 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};
