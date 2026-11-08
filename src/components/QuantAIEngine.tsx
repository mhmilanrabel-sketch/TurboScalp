
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
  Wallet
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

type BotEvent = {
  at: number;
  level: 'INFO' | 'WARN' | 'ERROR' | 'TRADE';
  message: string;
};

type BotSnapshot = {
  success: boolean;
  environment: string;
  liveTradingEnabled: false;
  status: 'STOPPED' | 'RUNNING' | 'PAUSED' | 'ERROR';
  message: string;
  config: {
    riskPercent: number;
    maxNotionalUsd: number;
    leverage: number;
    minScore: number;
    minConfidence: number;
  };
  activeTrade: TradeRecord | null;
  trades: TradeRecord[];
  logs: BotEvent[];
  stats: {
    closedTrades: number;
    wins: number;
    losses: number;
    winRate: number | null;
    netRealizedPnl: number;
  };
  lastScanAt: number | null;
  lastScanCount: number;
  lastCandidate: {
    symbol: string;
    direction: string;
    score: number;
  } | null;
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

const INITIAL: BotSnapshot = {
  success: true,
  environment: 'USD_M_FUTURES_DEMO',
  liveTradingEnabled: false,
  status: 'STOPPED',
  message: 'Connect Binance Futures Demo to enable the autonomous bot.',
  config: {
    riskPercent: 0.5,
    maxNotionalUsd: 100,
    leverage: 1,
    minScore: 65,
    minConfidence: 78
  },
  activeTrade: null,
  trades: [],
  logs: [],
  stats: {
    closedTrades: 0,
    wins: 0,
    losses: 0,
    winRate: null,
    netRealizedPnl: 0
  },
  lastScanAt: null,
  lastScanCount: 0,
  lastCandidate: null,
  updatedAt: Date.now()
};

function money(value: unknown, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';

  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });
}

function price(value: unknown) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';

  return n < 1
    ? `$${n.toPrecision(6)}`
    : `$${n.toLocaleString('en-US', { maximumFractionDigits: 5 })}`;
}

function date(value: number | null | undefined) {
  return value ? new Date(value).toLocaleString() : '—';
}

async function request<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });

  const result = await response.json().catch(() => ({}));

  if (!response.ok || result.success === false) {
    throw new Error(
      result.message ||
      result.error ||
      `Request failed (${response.status})`
    );
  }

  return result as T;
}

function Stat({
  label,
  value,
  hint,
  color = 'text-white'
}: {
  label: string;
  value: string;
  hint: string;
  color?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-[#0a1220] p-4">
      <p className="text-[8px] font-bold uppercase tracking-widest text-slate-500">
        {label}
      </p>
      <p className={`mt-2 text-xl font-black ${color}`}>{value}</p>
      <p className="mt-1 text-[8px] text-slate-600">{hint}</p>
    </div>
  );
}

export function QuantAIEngine({
  account,
  apiConnected,
  accountLoading,
  accountError,
  positions,
  openOrders,
  onRefreshAccount,
  onOpenApiSettings
}: Props) {
  const [bot, setBot] = useState<BotSnapshot>(INITIAL);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [risk, setRisk] = useState('0.5');
  const [notional, setNotional] = useState('100');
  const [lastSync, setLastSync] = useState(0);
  const [settingsLoaded, setSettingsLoaded] = useState(false);

  const refreshBot = useCallback(async () => {
    if (!apiConnected) {
      setBot(previous => ({
        ...previous,
        status: previous.activeTrade ? 'PAUSED' : 'STOPPED',
        message: 'Binance Demo API disconnected. Reconnect to reconcile the account.'
      }));
      return;
    }

    try {
      const data = await request<BotSnapshot>(
        '/api/quant/bot/state'
      );

      setBot(data);

      if (!settingsLoaded && data.config) {
        setRisk(String(data.config.riskPercent));
        setNotional(String(data.config.maxNotionalUsd));
        setSettingsLoaded(true);
      }

      setLastSync(Date.now());
      setError('');
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Bot status unavailable.'
      );
    }
  }, [apiConnected, settingsLoaded]);

  useEffect(() => {
    let active = true;
    let busy = false;

    const sync = async () => {
      if (!active || busy) return;

      busy = true;

      try {
        await refreshBot();
      } finally {
        busy = false;
      }
    };

    void sync();

    if (apiConnected) {
      const timer = window.setInterval(() => {
        void sync();
      }, 3000);

      return () => {
        active = false;
        window.clearInterval(timer);
      };
    }

    return () => {
      active = false;
    };
  }, [apiConnected, refreshBot]);

  const startBot = async () => {
    if (loading) return;

    setError('');

    if (!apiConnected) {
      setError('Binance Demo is not connected. Connect your Demo API first.');
      onOpenApiSettings();
      return;
    }

    if (accountLoading) {
      setError('Account information is still loading. Please try again.');
      return;
    }

    if (!account.canTrade) {
      setError(
        'Binance Demo reports that trading is disabled. Check API permissions.'
      );
      return;
    }

    if (Number(account.availableBalance) <= 0) {
      setError(
        'No available Binance Demo margin. Check your Demo Futures wallet.'
      );
      return;
    }

    const riskValue = Number(risk);
    const notionalValue = Number(notional);

    if (!Number.isFinite(riskValue) || riskValue < 0.1 || riskValue > 1) {
      setError('Risk must be between 0.1% and 1%.');
      return;
    }

    if (
      !Number.isFinite(notionalValue) ||
      notionalValue < 5 ||
      notionalValue > 100
    ) {
      setError('Maximum notional must be between 5 and 100 USDT.');
      return;
    }

    const confirmed = window.confirm(
      'START BINANCE USD-M FUTURES DEMO BOT?\n\n' +
      'This bot may submit actual Binance Demo orders.\n' +
      'It does not use the Live Trading account.\n\n' +
      'Maximum notional: ' + notionalValue + ' USDT\n' +
      'Risk budget: ' + riskValue + '%\n' +
      'Leverage: 1x\n\n' +
      'Do you want to continue?'
    );

    if (!confirmed) return;

    setLoading(true);

    try {
      const data = await request<BotSnapshot>(
        '/api/quant/bot/start',
        {
          method: 'POST',
          body: JSON.stringify({
            riskPercent: riskValue,
            maxNotionalUsd: notionalValue
          })
        }
      );

      setBot(data);
      setError('');

      await onRefreshAccount();
      await refreshBot();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Unable to start bot.'
      );

      await refreshBot();
      await onRefreshAccount();
    } finally {
      setLoading(false);
    }
  };

  const pauseBot = async () => {
    if (loading) return;

    setLoading(true);
    setError('');

    try {
      const data = await request<BotSnapshot>(
        '/api/quant/bot/stop',
        { method: 'POST' }
      );

      setBot(data);
      await onRefreshAccount();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'Unable to pause bot.'
      );
    } finally {
      setLoading(false);
    }
  };

  const exportCsv = async (kind: 'history' | 'logs') => {
    try {
      const response = await fetch(
        `/api/quant/bot/${kind}.csv`,
        {
          credentials: 'same-origin',
          cache: 'no-store'
        }
      );

      if (!response.ok) {
        throw new Error(`CSV export failed (${response.status})`);
      }

      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');

      link.href = url;
      link.download = kind === 'history'
        ? 'turboscalp-demo-trades.csv'
        : 'turboscalp-demo-activity.csv';

      document.body.appendChild(link);
      link.click();
      link.remove();

      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Export failed.');
    }
  };

  const exchangePositions = useMemo(
    () => positions.filter(
      p => Math.abs(Number(p.positionAmt || 0)) > 0
    ),
    [positions]
  );

  const activeTrade = bot.activeTrade;

  const untrackedPositions = exchangePositions.filter(
    p => p.symbol !== activeTrade?.symbol
  );

  const protectedTrade = Boolean(
    activeTrade?.stopAlgoId && activeTrade?.targetAlgoId
  );

  const statusColor =
    bot.status === 'RUNNING'
      ? 'text-emerald-300 border-emerald-500/30 bg-emerald-500/10'
      : bot.status === 'ERROR'
        ? 'text-rose-300 border-rose-500/30 bg-rose-500/10'
        : bot.status === 'PAUSED'
          ? 'text-amber-300 border-amber-500/30 bg-amber-500/10'
          : 'text-slate-400 border-slate-700 bg-slate-900';

  return (
    <div className="space-y-5">

      <section className="overflow-hidden rounded-2xl border border-cyan-500/20 bg-[#0b1422]">

        <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 p-5">
          <div className="flex items-center gap-3">
            <div className="rounded-xl border border-cyan-400/20 bg-cyan-400/10 p-3 text-cyan-300">
              <Bot size={24} />
            </div>

            <div>
              <p className="text-[9px] font-black tracking-widest text-cyan-300">
                QUANT AUTONOMOUS ENGINE
              </p>
              <h2 className="mt-1 text-sm font-black text-white">
                BINANCE DEMO AI BOT
              </h2>
              <p className="mt-1 text-[8px] text-slate-500">
                One position maximum · automatic reconciliation
              </p>
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-2 text-[9px] font-black ${statusColor}`}>
              {bot.status}
            </span>
            <span className="rounded-full border border-amber-500/20 bg-amber-500/10 px-3 py-2 text-[9px] font-black text-amber-200">
              DEMO ONLY
            </span>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat
            label="Demo wallet"
            value={money(account.totalWalletBalance)}
            hint="Binance USD-M Futures"
          />
          <Stat
            label="Available capital"
            value={money(account.availableBalance)}
            hint="Exchange available margin"
            color="text-cyan-300"
          />
          <Stat
            label="Exchange unrealized P&L"
            value={money(account.totalUnrealizedProfit)}
            hint="Actual Binance account"
            color={Number(account.totalUnrealizedProfit) >= 0 ? 'text-emerald-300' : 'text-rose-300'}
          />
          <Stat
            label="Closed trades"
            value={String(bot.stats.closedTrades)}
            hint={`${bot.stats.wins} wins · ${bot.stats.losses} losses`}
          />
        </div>

        <div className="grid gap-5 border-t border-slate-800 p-5 lg:grid-cols-2">

          <div className="space-y-4">

            <div className="flex items-center justify-between">
              <p className="text-[10px] font-black tracking-widest text-white">
                ENGINE CONTROL
              </p>
              <ShieldCheck size={19} className="text-cyan-300" />
            </div>

            {!apiConnected ? (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
                <p className="text-sm font-bold text-amber-200">
                  Binance Demo not connected
                </p>

                <button
                  type="button"
                  onClick={onOpenApiSettings}
                  className="mt-3 cursor-pointer rounded-lg bg-cyan-400 px-4 py-3 text-[9px] font-black text-slate-950"
                >
                  CONNECT DEMO API
                </button>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-3">

                  <label className="text-[9px] text-slate-400">
                    RISK (%)
                    <input
                      type="number"
                      min="0.1"
                      max="1"
                      step="0.1"
                      value={risk}
                      disabled={bot.status === 'RUNNING' || loading}
                      onChange={e => setRisk(e.target.value)}
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-[#070e19] p-3 text-sm font-bold text-white"
                    />
                  </label>

                  <label className="text-[9px] text-slate-400">
                    MAX NOTIONAL (USDT)
                    <input
                      type="number"
                      min="5"
                      max="100"
                      step="5"
                      value={notional}
                      disabled={bot.status === 'RUNNING' || loading}
                      onChange={e => setNotional(e.target.value)}
                      className="mt-2 w-full rounded-lg border border-slate-700 bg-[#070e19] p-3 text-sm font-bold text-white"
                    />
                  </label>

                </div>

                <div className="flex items-center justify-between rounded-xl border border-slate-800 bg-[#080f1b] p-4">
                  <div className="flex items-center gap-2">
                    <Wallet size={17} className="text-cyan-300" />
                    <div>
                      <p className="text-[8px] text-slate-500">CAPITAL SOURCE</p>
                      <p className="text-[10px] font-bold text-white">
                        Binance Demo
                      </p>
                    </div>
                  </div>

                  <div className="text-right">
                    <p className="text-[8px] text-slate-500">LEVERAGE</p>
                    <p className="text-sm font-black text-cyan-300">1x</p>
                  </div>
                </div>

                <div className="flex gap-2">

                  {bot.status === 'RUNNING' ? (
                    <button
                      type="button"
                      onClick={() => void pauseBot()}
                      disabled={loading}
                      className="relative z-10 flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-[9px] font-black text-amber-200 disabled:opacity-40"
                    >
                      {loading
                        ? <RefreshCw size={15} className="animate-spin" />
                        : <Pause size={15} />
                      }
                      PAUSE NEW ENTRIES
                    </button>
                  ) : (
                    <button
                      type="button"
                      aria-label="Start or resume Binance Demo autonomous bot"
                      onClick={() => void startBot()}
                      disabled={loading || accountLoading}
                      title={
                        !account.canTrade
                          ? 'Click to check Binance Demo trading permissions.'
                          : Number(account.availableBalance) <= 0
                            ? 'Click to check available Demo margin.'
                            : 'Start or resume the Binance Demo autonomous bot.'
                      }
                      className="relative z-10 flex flex-1 cursor-pointer touch-manipulation items-center justify-center gap-2 rounded-lg bg-cyan-400 p-4 text-[9px] font-black text-slate-950 hover:bg-cyan-300 disabled:cursor-wait disabled:opacity-40"
                    >
                      {loading
                        ? <RefreshCw size={15} className="animate-spin" />
                        : <Play size={15} />
                      }

                      {loading
                        ? 'STARTING...'
                        : bot.status === 'PAUSED'
                          ? 'RESUME / RECONCILE'
                          : 'START AUTONOMOUS BOT'
                      }
                    </button>
                  )}

                  <button
                    type="button"
                    aria-label="Refresh bot and account"
                    onClick={() => {
                      void refreshBot();
                      void onRefreshAccount();
                    }}
                    disabled={loading || accountLoading}
                    className="cursor-pointer rounded-lg border border-slate-700 bg-slate-900 px-4 text-slate-300 disabled:opacity-40"
                  >
                    <RefreshCw size={15} />
                  </button>

                </div>
              </>
            )}

            <div className="rounded-xl border border-slate-800 bg-[#080f1b] p-4">
              <p className="text-[9px] leading-relaxed text-slate-300">
                {bot.message}
              </p>

              <p className="mt-2 text-[8px] text-slate-500">
                Last scan: {date(bot.lastScanAt)} · {bot.lastScanCount} signals
              </p>
            </div>

            {error && (
              <div
                role="alert"
                className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[9px] text-rose-300"
              >
                <b>BOT ERROR</b>
                <p className="mt-1">{error}</p>
              </div>
            )}

            {accountError && (
              <p className="rounded-lg border border-rose-500/20 bg-rose-500/10 p-3 text-[9px] text-rose-300">
                Account: {accountError}
              </p>
            )}

          </div>

          <div className="space-y-4">

            <div className="flex items-center justify-between">
              <p className="text-[10px] font-black tracking-widest text-white">
                PERFORMANCE
              </p>
              <Activity size={18} className="text-cyan-300" />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <Stat
                label="Win rate"
                value={bot.stats.winRate === null ? '—' : `${bot.stats.winRate.toFixed(1)}%`}
                hint="Closed trades"
                color="text-emerald-300"
              />

              <Stat
                label="Realized P&L"
                value={money(bot.stats.netRealizedPnl, 4)}
                hint="Bot trade history"
                color={bot.stats.netRealizedPnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}
              />
            </div>

            <div className="space-y-3 rounded-xl border border-slate-800 bg-[#080f1b] p-4 text-[9px]">

              <div className="flex justify-between">
                <span className="text-slate-500">Timeframe</span>
                <b className="text-white">15 minutes</b>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-500">Automatic scan</span>
                <b className="text-white">30 seconds*</b>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-500">Position reconciliation</span>
                <b className="text-white">Server managed</b>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-500">Duplicate protection</span>
                <b className="text-emerald-300">One position maximum</b>
              </div>

              <div className="flex justify-between">
                <span className="text-slate-500">SL / TP</span>
                <b className="text-emerald-300">Exchange-side protection</b>
              </div>

            </div>

            <p className="text-[8px] leading-relaxed text-slate-500">
              *Server-side intervals must be verified against the running backend.
              Signal scores are technical heuristics, not proven win probabilities.
            </p>

          </div>
        </div>
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1422]">

        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
          <div>
            <p className="text-[10px] font-black text-white">
              ACTIVE BINANCE DEMO POSITION
            </p>
            <p className="mt-1 text-[8px] text-slate-500">
              Live exchange position reconciliation
            </p>
          </div>

          <span className="text-[9px] text-slate-400">
            {exchangePositions.length} positions · {openOrders.length} orders
          </span>
        </header>

        {activeTrade ? (
          <div className="space-y-4 p-5">

            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-xl font-black text-white">
                    {activeTrade.symbol}
                  </h3>

                  <span className={`rounded px-2 py-1 text-[9px] font-black ${
                    activeTrade.side === 'BUY'
                      ? 'bg-emerald-500/10 text-emerald-300'
                      : 'bg-rose-500/10 text-rose-300'
                  }`}>
                    {activeTrade.side === 'BUY' ? 'LONG' : 'SHORT'}
                  </span>
                </div>

                <p className="mt-2 text-[8px] text-slate-500">
                  Order {activeTrade.entryOrderId ?? '—'} · {date(activeTrade.openedAt)}
                </p>
              </div>

              <div className="text-right">
                <p className="text-[8px] text-slate-500">UNREALIZED P&L</p>
                <p className={`mt-1 text-xl font-black ${
                  activeTrade.unrealizedPnl >= 0
                    ? 'text-emerald-300'
                    : 'text-rose-300'
                }`}>
                  {money(activeTrade.unrealizedPnl, 4)}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Stat
                label="Notional"
                value={money(activeTrade.notionalUsd)}
                hint={`${activeTrade.leverage}x leverage`}
              />

              <Stat
                label="Entry"
                value={price(activeTrade.entryPrice)}
                hint={`Quantity ${activeTrade.quantity}`}
              />

              <Stat
                label="Current mark"
                value={price(activeTrade.markPrice)}
                hint="Binance position data"
                color="text-cyan-300"
              />

              <Stat
                label="Protection"
                value={protectedTrade ? 'READY' : 'VERIFY'}
                hint="Exchange SL / TP"
                color={protectedTrade ? 'text-emerald-300' : 'text-amber-300'}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">

              <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] font-black text-rose-300">STOP LOSS</p>
                  <ArrowDownRight size={16} className="text-rose-300" />
                </div>

                <p className="mt-3 text-lg font-black text-white">
                  {price(activeTrade.stopPrice)}
                </p>
              </div>

              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-4">
                <div className="flex items-center justify-between">
                  <p className="text-[9px] font-black text-emerald-300">TAKE PROFIT</p>
                  <ArrowUpRight size={16} className="text-emerald-300" />
                </div>

                <p className="mt-3 text-lg font-black text-white">
                  {price(activeTrade.targetPrice)}
                </p>
              </div>

            </div>

            {!protectedTrade && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-[9px] text-amber-200">
                Protective orders are not confirmed by the bot snapshot.
                Verify Binance Demo open and conditional orders immediately.
              </div>
            )}

          </div>
        ) : exchangePositions.length > 0 ? (
          <div className="space-y-3 p-5">

            <div className="flex items-center gap-2 text-amber-300">
              <AlertTriangle size={16} />
              <b className="text-[9px]">UNTRACKED EXCHANGE POSITION</b>
            </div>

            {exchangePositions.map((p, i) => (
              <div
                key={`${p.symbol}-${i}`}
                className="rounded-lg border border-amber-500/20 p-3 text-[9px]"
              >
                <b className="text-white">{p.symbol}</b>
                <p className="mt-1 text-slate-400">
                  Amount: {p.positionAmt} · Entry: {price(p.entryPrice)}
                  {' '}· Mark: {price(p.markPrice)}
                </p>
              </div>
            ))}

            <p className="text-[8px] text-amber-200">
              Do not allow a new bot entry until existing exchange positions
              have been reconciled.
            </p>

          </div>
        ) : (
          <div className="flex flex-col items-center p-10 text-center">
            <Clock3 size={28} className="text-slate-600" />
            <p className="mt-3 text-[10px] font-bold text-slate-300">
              No active bot position
            </p>
            <p className="mt-1 text-[8px] text-slate-500">
              Waiting for a qualified strategy setup.
            </p>
          </div>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1422]">

        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
          <div>
            <p className="text-[10px] font-black text-white">
              BINANCE DEMO TRADE HISTORY
            </p>
            <p className="mt-1 text-[8px] text-slate-500">
              {bot.trades.length} records
            </p>
          </div>

          <button
            type="button"
            onClick={() => void exportCsv('history')}
            disabled={!apiConnected || !bot.trades.length}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-cyan-400/20 px-3 py-2 text-[8px] font-black text-cyan-300 disabled:opacity-30"
          >
            <Download size={13} /> EXPORT CSV
          </button>
        </header>

        {bot.trades.length ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[750px] text-left text-[9px]">
              <thead className="bg-[#080f1b] text-slate-500">
                <tr>
                  {['DATE', 'SYMBOL', 'SIDE', 'ENTRY', 'STOP', 'TARGET', 'STATUS', 'P&L'].map(x => (
                    <th key={x} className="p-3">{x}</th>
                  ))}
                </tr>
              </thead>

              <tbody>
                {bot.trades.map(trade => (
                  <tr key={trade.id} className="border-t border-slate-800">
                    <td className="p-3 text-slate-500">{date(trade.openedAt)}</td>
                    <td className="p-3 font-bold text-white">{trade.symbol}</td>
                    <td className={`p-3 font-bold ${trade.side === 'BUY' ? 'text-emerald-300' : 'text-rose-300'}`}>
                      {trade.side}
                    </td>
                    <td className="p-3 text-slate-300">{price(trade.entryPrice)}</td>
                    <td className="p-3 text-rose-300">{price(trade.stopPrice)}</td>
                    <td className="p-3 text-emerald-300">{price(trade.targetPrice)}</td>
                    <td className="p-3 text-slate-300">{trade.status}</td>
                    <td className="p-3 font-bold text-white">
                      {trade.realizedPnl === null ? '—' : money(trade.realizedPnl, 4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="p-8 text-center text-[9px] text-slate-500">
            No recorded trades.
          </p>
        )}
      </section>

      <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1422]">

        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 p-4">
          <div>
            <p className="text-[10px] font-black text-white">
              AUTOMATION ACTIVITY LOG
            </p>
            <p className="mt-1 text-[8px] text-slate-500">
              Scanner decisions · execution · reconciliation
            </p>
          </div>

          <button
            type="button"
            onClick={() => void exportCsv('logs')}
            disabled={!apiConnected || !bot.logs.length}
            className="flex cursor-pointer items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-[8px] font-black text-slate-300 disabled:opacity-30"
          >
            <Download size={13} /> EXPORT LOG
          </button>
        </header>

        <div className="max-h-80 divide-y divide-slate-800 overflow-y-auto">
          {bot.logs.length ? bot.logs.map((event, i) => (
            <div
              key={`${event.at}-${i}`}
              className="grid grid-cols-[105px_55px_1fr] gap-3 p-3 text-[8px]"
            >
              <span className="text-slate-600">{date(event.at)}</span>

              <b className={
                event.level === 'ERROR' ? 'text-rose-300' :
                event.level === 'WARN' ? 'text-amber-300' :
                event.level === 'TRADE' ? 'text-emerald-300' :
                'text-cyan-300'
              }>
                {event.level}
              </b>

              <span className="leading-relaxed text-slate-300">
                {event.message}
              </span>
            </div>
          )) : (
            <p className="p-8 text-center text-[9px] text-slate-500">
              Waiting for automation events.
            </p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4">
        <div className="flex items-start gap-2">
          <CheckCircle2 size={16} className="mt-0.5 text-amber-300" />

          <div>
            <p className="text-[9px] font-black text-amber-200">
              DEMO EXECUTION SAFETY
            </p>

            <p className="mt-2 text-[8px] leading-relaxed text-slate-400">
              This interface is configured for Binance USD-M Futures Demo.
              Pausing the bot should stop new entries, not automatically close
              an existing position. Existing positions must retain verified
              exchange-side protection. One position maximum and duplicate
              prevention must be enforced by the backend. Signal scores are
              not guaranteed win rates.
            </p>
          </div>
        </div>

        {untrackedPositions.length > 0 && (
          <p className="mt-3 text-[8px] font-bold text-amber-200">
            Untracked symbols: {untrackedPositions.map(p => p.symbol).join(', ')}
          </p>
        )}

        <p className="mt-3 text-[8px] text-slate-600">
          Last bot sync: {date(lastSync)}
          {' · '}Account refresh: {accountLoading ? 'Updating' : '30-second parent refresh'}
        </p>
      </section>

    </div>
  );
}
