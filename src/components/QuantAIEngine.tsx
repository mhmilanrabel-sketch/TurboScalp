import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Bot,
  CheckCircle2,
  Clock3,
  Download,
  Pause,
  Play,
  RefreshCw,
  ShieldCheck,
  Wallet,
} from 'lucide-react';

type AccountSummary = {
  availableBalance: string;
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  canTrade: boolean;
};

type TradeRecord = {
  id: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  status: 'OPEN' | 'CLOSED';
  notionalUsd: number;
  quantity: string;
  leverage: number;
  entryPrice: number;
  markPrice: number;
  stopPrice: number;
  targetPrice: number;
  unrealizedPnl: number;
  realizedPnl: number | null;
  entryOrderId: number | string | null;
  stopAlgoId: number | string | null;
  targetAlgoId: number | string | null;
  openedAt: number;
  closedAt: number | null;
  closeReason: string | null;
};

type BotEvent = { at: number; level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE'; message: string };
type BotSnapshot = {
  success: boolean;
  environment: string;
  liveTradingEnabled: false;
  status: 'STOPPED' | 'RUNNING' | 'PAUSED' | 'ERROR';
  message: string;
  config: { riskPercent: number; maxNotionalUsd: number; leverage: number; minScore: number; minConfidence: number };
  activeTrade: TradeRecord | null;
  trades: TradeRecord[];
  logs: BotEvent[];
  stats: { closedTrades: number; wins: number; losses: number; winRate: number | null; netRealizedPnl: number };
  lastScanAt: number | null;
  lastScanCount: number;
  lastCandidate: { symbol: string; direction: string; score: number } | null;
  updatedAt: number;
};

type Props = {
  account: AccountSummary;
  apiConnected: boolean;
  accountLoading: boolean;
  accountError: string;
  positions: any[];
  openOrders: any[];
  onRefreshAccount: () => Promise<void>;
  onOpenApiSettings: () => void;
};

const blankSnapshot: BotSnapshot = {
  success: true,
  environment: 'USD_M_FUTURES_DEMO',
  liveTradingEnabled: false,
  status: 'STOPPED',
  message: 'Connect Binance Futures Demo to enable the autonomous bot.',
  config: { riskPercent: 0.5, maxNotionalUsd: 100, leverage: 1, minScore: 65, minConfidence: 78 },
  activeTrade: null,
  trades: [],
  logs: [],
  stats: { closedTrades: 0, wins: 0, losses: 0, winRate: null, netRealizedPnl: 0 },
  lastScanAt: null,
  lastScanCount: 0,
  lastCandidate: null,
  updatedAt: Date.now(),
};

function money(value: unknown, digits = 2): string {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '—';
  return amount.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function price(value: unknown): string {
  const amount = Number(value);
  if (!(amount > 0) || !Number.isFinite(amount)) return '—';
  return amount < 1 ? `$${amount.toPrecision(6)}` : `$${amount.toLocaleString('en-US', { maximumFractionDigits: 5 })}`;
}

function time(value: number | null | undefined): string {
  return value ? new Date(value).toLocaleString() : '—';
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.success === false) throw new Error(payload.message || payload.error || `Request failed (${response.status})`);
  return payload as T;
}

function StatCard({ label, value, hint, tone = 'text-white' }: { label: string; value: string; hint: string; tone?: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-[#0a1220] p-4">
      <p className="text-[8px] font-bold uppercase tracking-[0.16em] text-slate-500">{label}</p>
      <p className={`mt-2 text-xl font-black tracking-tight ${tone}`}>{value}</p>
      <p className="mt-1 text-[8px] text-slate-600">{hint}</p>
    </div>
  );
}

export function QuantAIEngine({ account, apiConnected, accountLoading, accountError, positions, openOrders, onRefreshAccount, onOpenApiSettings }: Props) {
  const [snapshot, setSnapshot] = useState<BotSnapshot>(blankSnapshot);
  const [loading, setLoading] = useState(false);
  const [actionError, setActionError] = useState('');
  const [riskPercent, setRiskPercent] = useState('0.5');
  const [maxNotionalUsd, setMaxNotionalUsd] = useState('100');
  const [lastSyncAt, setLastSyncAt] = useState(0);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const refreshBot = useCallback(async () => {
    if (!apiConnected) {
      setSnapshot(previous => ({
        ...previous,
        status: previous.activeTrade ? 'PAUSED' : 'STOPPED',
        message: previous.activeTrade
          ? 'The browser API session is disconnected. The existing Binance Demo position and exchange-side SL/TP orders remain on Binance; reconnect to view live bot reconciliation.'
          : 'Connect Binance Futures Demo to enable the autonomous bot.',
      }));
      return;
    }
    try {
      const data = await api<BotSnapshot>('/api/quant/bot/state');
      setSnapshot(data);
      if (!settingsLoaded) {
        setRiskPercent(String(data.config?.riskPercent ?? 0.5));
        setMaxNotionalUsd(String(data.config?.maxNotionalUsd ?? 100));
        setSettingsLoaded(true);
      }
      setLastSyncAt(Date.now());
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to load bot state.');
    }
  }, [apiConnected, settingsLoaded]);

  useEffect(() => {
    void refreshBot();
    if (!apiConnected) return;
    const timer = window.setInterval(() => void refreshBot(), 3_000);
    return () => window.clearInterval(timer);
  }, [apiConnected, refreshBot]);

  const startBot = async () => {
    setActionError('');
    if (!apiConnected) {
      onOpenApiSettings();
      return;
    }
    if (!account.canTrade || Number(account.availableBalance) <= 0) {
      setActionError('Binance Demo trading permission and positive available USDT margin must be verified before starting.');
      return;
    }
    const confirmed = window.confirm(
      'START AUTONOMOUS BINANCE FUTURES DEMO BOT?\n\nThis is not paper trading. After all checks pass, the server will submit actual MARKET entry orders to your Binance USD-M Futures DEMO account and install exchange-side stop-loss / take-profit algo orders.\n\nRisk sizing uses the Demo available balance, with a maximum 1% risk budget and a maximum notional cap of $100 at 1x leverage. Existing positions and open orders block new entries.\n\nLive Binance endpoints are not configured in this application. Continue?'
    );
    if (!confirmed) return;
    setLoading(true);
    try {
      const data = await api<BotSnapshot>('/api/quant/bot/start', {
        method: 'POST',
        body: JSON.stringify({ riskPercent: Number(riskPercent), maxNotionalUsd: Number(maxNotionalUsd) }),
      });
      setSnapshot(data);
      setActionError('');
      await onRefreshAccount();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Bot could not start.');
      await refreshBot();
      await onRefreshAccount();
    } finally {
      setLoading(false);
    }
  };

  const pauseBot = async () => {
    setLoading(true);
    setActionError('');
    try {
      const data = await api<BotSnapshot>('/api/quant/bot/stop', { method: 'POST' });
      setSnapshot(data);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Unable to pause new entries.');
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = async (kind: 'history' | 'logs') => {
    try {
      const response = await fetch(`/api/quant/bot/${kind}.csv`, { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.message || `Export failed (${response.status})`);
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = kind === 'history' ? 'turboscalp-binance-demo-trades.csv' : 'turboscalp-binance-demo-activity.csv';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Export failed.');
    }
  };

  const externalPositions = useMemo(() => positions.filter(position => Math.abs(Number(position.positionAmt || 0)) > 0), [positions]);
  const activeTrade = snapshot.activeTrade;
  const botOwnsSymbol = activeTrade?.symbol;
  const unmatchedPositions = externalPositions.filter(position => position.symbol !== botOwnsSymbol);
  const statusTone = snapshot.status === 'RUNNING'
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : snapshot.status === 'ERROR'
      ? 'border-rose-500/30 bg-rose-500/10 text-rose-300'
      : snapshot.status === 'PAUSED'
        ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
        : 'border-slate-700 bg-slate-900 text-slate-400';
  const pnl = activeTrade?.unrealizedPnl ?? 0;
  const protectionReady = Boolean(activeTrade?.stopAlgoId && activeTrade?.targetAlgoId);
  const winRate = snapshot.stats.winRate === null ? '—' : `${snapshot.stats.winRate.toFixed(1)}%`;

  return (
    <div className="space-y-5">
      <section className="overflow-hidden rounded-2xl border border-cyan-500/20 bg-[#0b1422] shadow-2xl shadow-black/20">
        <div className="flex flex-col justify-between gap-4 border-b border-slate-800 px-4 py-5 sm:flex-row sm:items-center sm:px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-cyan-400/20 bg-cyan-400/10 text-cyan-200"><Bot size={22} /></div>
            <div>
              <p className="text-[8px] font-black tracking-[0.22em] text-cyan-300">QUANT AUTONOMOUS EXECUTION</p>
              <h2 className="mt-1 text-sm font-black tracking-[0.1em] text-white">BINANCE DEMO AI BOT</h2>
              <p className="mt-1 text-[9px] text-slate-500">One exchange position maximum · server-side monitoring · no paper trades</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[9px] font-black ${statusTone}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${snapshot.status === 'RUNNING' ? 'animate-pulse bg-emerald-300' : snapshot.status === 'ERROR' ? 'bg-rose-300' : snapshot.status === 'PAUSED' ? 'bg-amber-300' : 'bg-slate-500'}`} />
              {snapshot.status}
            </span>
            <span className="rounded-full border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-[8px] font-bold text-amber-200">DEMO ONLY · LIVE DISABLED</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4 sm:p-5">
          <StatCard label="Demo wallet" value={money(account.totalWalletBalance)} hint="Binance USD-M Demo" />
          <StatCard label="Available capital" value={money(account.availableBalance)} hint="Used for risk sizing" tone="text-cyan-200" />
          <StatCard label="Exchange unrealized P&L" value={money(account.totalUnrealizedProfit)} hint="Actual Binance positions" tone={Number(account.totalUnrealizedProfit) >= 0 ? 'text-emerald-300' : 'text-rose-300'} />
          <StatCard label="Closed bot trades" value={String(snapshot.stats.closedTrades)} hint={`${snapshot.stats.wins} wins · ${snapshot.stats.losses} losses`} />
        </div>

        <div className="grid gap-0 border-t border-slate-800 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="space-y-4 p-4 sm:p-5 lg:border-r lg:border-slate-800">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[9px] font-black tracking-[0.14em] text-white">AUTONOMOUS BOT CONTROL</p>
                <p className="mt-1 text-[8px] text-slate-500">The server checks Demo positions and orders before every new entry.</p>
              </div>
              <ShieldCheck className="text-cyan-300" size={18} />
            </div>

            {!apiConnected ? (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.05] p-4">
                <p className="text-[10px] font-bold text-amber-200">Binance Futures Demo is not connected.</p>
                <p className="mt-1 text-[9px] text-slate-500">Connect your Demo API to load capital and allow the bot to place Demo exchange orders.</p>
                <button onClick={onOpenApiSettings} className="mt-3 rounded-lg bg-cyan-400 px-4 py-2 text-[9px] font-black text-slate-950">CONNECT DEMO API</button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
                    Risk budget (% available balance)
                    <input type="number" min="0.1" max="1" step="0.1" value={riskPercent} onChange={event => setRiskPercent(event.target.value)} disabled={snapshot.status === 'RUNNING'} className="mt-2 w-full rounded-lg border border-slate-700 bg-[#070e19] px-3 py-3 text-sm font-black text-white outline-none focus:border-cyan-400 disabled:opacity-50" />
                  </label>
                  <label className="text-[8px] font-bold uppercase tracking-wider text-slate-500">
                    Maximum trade notional (USDT)
                    <input type="number" min="5" max="100" step="5" value={maxNotionalUsd} onChange={event => setMaxNotionalUsd(event.target.value)} disabled={snapshot.status === 'RUNNING'} className="mt-2 w-full rounded-lg border border-slate-700 bg-[#070e19] px-3 py-3 text-sm font-black text-white outline-none focus:border-cyan-400 disabled:opacity-50" />
                  </label>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-800 bg-[#080f1b] p-3">
                  <div className="flex items-center gap-2">
                    <Wallet size={15} className="text-cyan-300" />
                    <div>
                      <p className="text-[8px] font-bold text-slate-400">CAPITAL SOURCE</p>
                      <p className="mt-1 text-[9px] font-black text-white">Binance Demo available balance · {money(account.availableBalance)}</p>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-[8px] font-bold text-slate-500">LEVERAGE</p>
                    <p className="mt-1 text-[9px] font-black text-cyan-200">1× fixed</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {snapshot.status === 'RUNNING' ? (
                    <button onClick={() => void pauseBot()} disabled={loading} className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-[9px] font-black text-amber-200 disabled:opacity-50">
                      <Pause size={14} /> {activeTrade ? 'PAUSE NEW ENTRIES · KEEP SL/TP' : 'PAUSE BOT'}
                    </button>
                  ) : (
                    <button onClick={() => void startBot()} disabled={loading || accountLoading || !account.canTrade || Number(account.availableBalance) <= 0} className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-cyan-400 px-4 py-3 text-[9px] font-black text-slate-950 transition hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-40">
                      {loading ? <RefreshCw className="animate-spin" size={14} /> : <Play size={14} />}
                      {snapshot.activeTrade || snapshot.status === 'PAUSED' ? 'RESUME / RECONCILE BOT' : 'START AUTONOMOUS DEMO BOT'}
                    </button>
                  )}
                  <button onClick={() => { void refreshBot(); void onRefreshAccount(); }} disabled={loading || accountLoading} className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-4 py-3 text-[9px] font-black text-slate-300 disabled:opacity-50">
                    <RefreshCw size={13} className={accountLoading ? 'animate-spin' : ''} /> SYNC
                  </button>
                </div>
              </>
            )}

            <div className="rounded-lg border border-slate-800/80 bg-[#080f1b] px-3 py-3">
              <p className="text-[9px] leading-relaxed text-slate-300">{snapshot.message}</p>
              <p className="mt-2 text-[8px] text-slate-600">{snapshot.lastScanAt ? `Last strategy scan: ${time(snapshot.lastScanAt)} · ${snapshot.lastScanCount} signals received` : 'Waiting for first automatic strategy scan.'}</p>
            </div>
            {actionError && <p className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] p-3 text-[9px] text-rose-300">{actionError}</p>}
            {accountError && <p className="rounded-lg border border-rose-500/20 bg-rose-500/[0.05] p-3 text-[9px] text-rose-300">Account sync: {accountError}</p>}
          </div>

          <div className="space-y-4 p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <p className="text-[9px] font-black tracking-[0.14em] text-white">RISK & PERFORMANCE</p>
              <Activity size={16} className="text-cyan-300" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <StatCard label="Win rate" value={winRate} hint="Closed bot trades only" tone={snapshot.stats.winRate !== null && snapshot.stats.winRate >= 50 ? 'text-emerald-300' : 'text-white'} />
              <StatCard label="Net realized P&L" value={money(snapshot.stats.netRealizedPnl)} hint="Exchange income records" tone={snapshot.stats.netRealizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'} />
            </div>
            <div className="space-y-2 rounded-xl border border-slate-800 bg-[#080f1b] p-3">
              <div className="flex items-center justify-between text-[8px]"><span className="text-slate-500">Strategy timeframe</span><b className="text-slate-200">15-minute candles</b></div>
              <div className="flex items-center justify-between text-[8px]"><span className="text-slate-500">Scan cycle</span><b className="text-slate-200">Every 30 seconds</b></div>
              <div className="flex items-center justify-between text-[8px]"><span className="text-slate-500">Exchange reconciliation</span><b className="text-slate-200">Every 5 seconds</b></div>
              <div className="flex items-center justify-between text-[8px]"><span className="text-slate-500">Duplicate protection</span><b className="text-emerald-300">One open position max</b></div>
              <div className="flex items-center justify-between text-[8px]"><span className="text-slate-500">SL / TP protection</span><b className="text-emerald-300">Exchange-side algo orders</b></div>
            </div>
            <p className="text-[8px] leading-relaxed text-slate-600">Signal score and confidence are rule-based heuristics, not statistically proven win probabilities. The bot does not guarantee returns. Keep the account in Demo mode and review results before considering any other environment.</p>
          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1422]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-4 sm:px-5">
          <div>
            <p className="text-[9px] font-black tracking-[0.14em] text-white">ACTIVE BINANCE DEMO POSITION</p>
            <p className="mt-1 text-[8px] text-slate-500">Exchange position risk and protective-order monitoring</p>
          </div>
          <span className="rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-[8px] font-bold text-slate-400">{externalPositions.length} EXCHANGE POSITION{externalPositions.length === 1 ? '' : 'S'} · {openOrders.length} OPEN ORDERS</span>
        </div>

        {activeTrade ? (
          <div className="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-lg font-black text-white">{activeTrade.symbol}</h3>
                  <span className={`rounded-md px-2 py-1 text-[8px] font-black ${activeTrade.side === 'BUY' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-rose-500/10 text-rose-300'}`}>{activeTrade.side === 'BUY' ? 'LONG / BUY' : 'SHORT / SELL'}</span>
                  <span className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.05] px-2 py-1 text-[8px] font-black text-emerald-300">ON BINANCE DEMO</span>
                </div>
                <p className="mt-1 text-[8px] text-slate-500">Order ID {activeTrade.entryOrderId ?? '—'} · opened {time(activeTrade.openedAt)}</p>
              </div>
              <div className="text-right">
                <p className="text-[8px] font-bold tracking-wider text-slate-500">EXCHANGE UNREALIZED P&L</p>
                <p className={`mt-1 text-xl font-black ${pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{money(pnl, 4)}</p>
              </div>
            </div>

            <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <StatCard label="Notional" value={money(activeTrade.notionalUsd)} hint={`${activeTrade.leverage}× leverage`} />
              <StatCard label="Entry fill" value={price(activeTrade.entryPrice)} hint={`${activeTrade.quantity} quantity`} />
              <StatCard label="Mark price" value={price(activeTrade.markPrice)} hint="From Binance positionRisk" tone="text-cyan-200" />
              <StatCard label="Stop / Target" value={protectionReady ? 'PROTECTED' : 'VERIFYING'} hint="Binance conditional algo orders" tone={protectionReady ? 'text-emerald-300' : 'text-amber-200'} />
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="rounded-xl border border-rose-500/20 bg-rose-500/[0.045] p-3">
                <div className="flex items-center justify-between"><span className="text-[8px] font-black tracking-wider text-rose-300">STOP LOSS</span><ArrowDownRight size={14} className="text-rose-300" /></div>
                <p className="mt-2 text-base font-black text-white">{price(activeTrade.stopPrice)}</p>
                <p className="mt-1 text-[8px] text-slate-500">Exchange-side STOP_MARKET protection</p>
              </div>
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.045] p-3">
                <div className="flex items-center justify-between"><span className="text-[8px] font-black tracking-wider text-emerald-300">TAKE PROFIT</span><ArrowUpRight size={14} className="text-emerald-300" /></div>
                <p className="mt-2 text-base font-black text-white">{price(activeTrade.targetPrice)}</p>
                <p className="mt-1 text-[8px] text-slate-500">Exchange-side TAKE_PROFIT_MARKET protection</p>
              </div>
            </div>
          </div>
        ) : externalPositions.length ? (
          <div className="space-y-2 p-4 sm:p-5">
            <div className="flex items-center gap-2 text-amber-200"><AlertTriangle size={16} /><p className="text-[9px] font-black">UNTRACKED EXCHANGE POSITION DETECTED</p></div>
            {externalPositions.map((position, index) => (
              <div key={`${position.symbol}-${index}`} className="flex flex-wrap justify-between gap-2 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] p-3 text-[9px]">
                <b className="text-white">{position.symbol} · {Number(position.positionAmt) > 0 ? 'LONG' : 'SHORT'}</b>
                <span className="text-slate-400">Qty {position.positionAmt} · Entry {price(position.entryPrice)} · Mark {price(position.markPrice)}</span>
              </div>
            ))}
            <p className="text-[8px] text-amber-200/80">The autonomous bot will not create another position while an untracked Binance position exists. Reconcile or close it on Binance Demo before starting.</p>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center px-5 py-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-full border border-slate-700 bg-slate-900 text-slate-500"><Clock3 size={19} /></div>
            <p className="mt-3 text-[10px] font-bold text-slate-300">No active Binance Demo bot position</p>
            <p className="mt-1 max-w-md text-[8px] leading-relaxed text-slate-500">When a setup passes the rules, the bot submits one Demo market order and confirms its exchange-side stop-loss and take-profit orders.</p>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1422]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-4 sm:px-5">
          <div>
            <p className="text-[9px] font-black tracking-[0.14em] text-white">BINANCE DEMO TRADE HISTORY</p>
            <p className="mt-1 text-[8px] text-slate-500">Actual bot exchange orders, fills and reconciled P&L · {snapshot.trades.length} recent records</p>
          </div>
          <button onClick={() => void exportCsv('history')} disabled={!apiConnected || !snapshot.trades.length} className="inline-flex items-center gap-2 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.06] px-3 py-2 text-[8px] font-black text-cyan-200 disabled:opacity-40"><Download size={13} /> EXPORT TRADES CSV</button>
        </div>
        {snapshot.trades.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[850px] text-left text-[8px]">
              <thead className="bg-[#080f1b] text-slate-500"><tr>{['OPENED','SYMBOL','SIDE','NOTIONAL','ENTRY','SL','TP','STATUS','REALIZED P&L'].map(title => <th key={title} className="px-4 py-3 font-bold">{title}</th>)}</tr></thead>
              <tbody>
                {snapshot.trades.map(trade => (
                  <tr key={trade.id} className="border-t border-slate-800/80 hover:bg-slate-800/20">
                    <td className="whitespace-nowrap px-4 py-3 text-slate-500">{time(trade.openedAt)}</td>
                    <td className="px-4 py-3 font-black text-white">{trade.symbol}</td>
                    <td className={`px-4 py-3 font-bold ${trade.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}`}>{trade.side}</td>
                    <td className="px-4 py-3 text-slate-300">{money(trade.notionalUsd)}</td>
                    <td className="px-4 py-3 text-slate-300">{price(trade.entryPrice)}</td>
                    <td className="px-4 py-3 text-rose-300">{price(trade.stopPrice)}</td>
                    <td className="px-4 py-3 text-emerald-300">{price(trade.targetPrice)}</td>
                    <td className="px-4 py-3"><span className={`rounded px-2 py-1 font-black ${trade.status === 'OPEN' ? 'bg-cyan-500/10 text-cyan-200' : 'bg-slate-800 text-slate-400'}`}>{trade.status}</span></td>
                    <td className={`px-4 py-3 font-bold ${trade.realizedPnl === null ? 'text-slate-500' : trade.realizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{trade.realizedPnl === null ? (trade.status === 'OPEN' ? '—' : 'Not reconciled') : money(trade.realizedPnl, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="px-5 py-8 text-center text-[9px] text-slate-500">No Binance Demo bot trades have been recorded yet.</p>}
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1422]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-4 sm:px-5">
          <div>
            <p className="text-[9px] font-black tracking-[0.14em] text-white">AUTOMATION ACTIVITY LOG</p>
            <p className="mt-1 text-[8px] text-slate-500">Pre-flight checks, scanner decisions, exchange orders and position reconciliation</p>
          </div>
          <button onClick={() => void exportCsv('logs')} disabled={!apiConnected || !snapshot.logs.length} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-[8px] font-black text-slate-300 disabled:opacity-40"><Download size={13} /> EXPORT LOG CSV</button>
        </div>
        <div className="max-h-80 divide-y divide-slate-800/70 overflow-y-auto">
          {snapshot.logs.length ? snapshot.logs.map((event, index) => (
            <div key={`${event.at}-${index}`} className="grid grid-cols-[105px_52px_1fr] gap-3 px-4 py-3 text-[8px] sm:grid-cols-[145px_60px_1fr]">
              <span className="text-slate-600">{time(event.at)}</span>
              <span className={`font-black ${event.level === 'ERROR' ? 'text-rose-300' : event.level === 'WARN' ? 'text-amber-300' : event.level === 'TRADE' ? 'text-emerald-300' : 'text-cyan-300'}`}>{event.level}</span>
              <span className="leading-relaxed text-slate-300">{event.message}</span>
            </div>
          )) : <p className="px-5 py-8 text-center text-[9px] text-slate-500">Activity will appear here when the bot connects and starts checking exchange data.</p>}
        </div>
      </section>

      <section className="rounded-xl border border-amber-500/20 bg-amber-500/[0.045] px-4 py-3">
        <div className="flex items-start gap-2"><CheckCircle2 size={15} className="mt-0.5 shrink-0 text-amber-300" /><div>
          <p className="text-[9px] font-black text-amber-200">IMPORTANT EXECUTION SAFETY</p>
          <p className="mt-1 text-[8px] leading-relaxed text-slate-400">This bot submits actual orders to Binance USD-M Futures DEMO only. It requires One-way Position Mode, checks positions and both regular / conditional open orders before entering, and allows one open position at a time. Pausing stops new entries; an existing position remains protected by Binance-side SL/TP orders. Do not manually trade the same Demo account while the bot is managing a position. The AI score is a heuristic and is not a guaranteed win rate.</p>
        </div></div>
        {unmatchedPositions.length > 0 && <p className="mt-2 text-[8px] font-bold text-amber-200">Untracked exchange positions: {unmatchedPositions.map(position => position.symbol).join(', ')}</p>}
        <p className="mt-2 text-[8px] text-slate-600">Bot state sync {lastSyncAt ? time(lastSyncAt) : 'pending'} · Account refresh {accountLoading ? 'in progress' : 'every 30 seconds'} · Open-order panel includes regular and conditional orders when server integration is installed.</p>
      </section>
    </div>
  );
}
