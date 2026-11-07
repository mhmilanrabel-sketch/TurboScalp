import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  getBinanceAccount,
  getBinanceConfig,
  getBinanceOpenOrders,
  getBinancePositions,
  type BinanceConnectionState,
  type BinanceConfig,
} from './services/binanceService';
import { ApiSettingsModal } from './components/ApiSettingsModal';
import { QuantAIEngine } from './components/QuantAIEngine';

type ApiStatus = 'CHECKING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
type MarketStatus = 'CONNECTING' | 'LIVE' | 'RECONNECTING' | 'OFFLINE';

type AccountSummary = {
  availableBalance: string;
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  canTrade: boolean;
};

const EMPTY_ACCOUNT: AccountSummary = {
  availableBalance: '0',
  totalWalletBalance: '0',
  totalUnrealizedProfit: '0',
  canTrade: false,
};

const money = (value: unknown) => {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return '$0.00';
  return amount.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
};

function StatusPill({
  label,
  active,
  warning = false,
}: {
  label: string;
  active: boolean;
  warning?: boolean;
}) {
  const tone = active
    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
    : warning
      ? 'border-amber-500/30 bg-amber-500/10 text-amber-300'
      : 'border-slate-700 bg-slate-900 text-slate-400';

  return (
    <span className={`inline-flex items-center gap-2 rounded-full border px-3 py-2 text-[9px] font-bold tracking-wide ${tone}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${active ? 'animate-pulse bg-emerald-400' : warning ? 'bg-amber-400' : 'bg-slate-500'}`} />
      {label}
    </span>
  );
}

function AccountMetric({
  label,
  value,
  detail,
  tone = 'text-white',
}: {
  label: string;
  value: string;
  detail: string;
  tone?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-800 bg-[#0a1220] p-4">
      <p className="text-[9px] font-bold uppercase tracking-[0.15em] text-slate-500">{label}</p>
      <p className={`mt-2 text-xl font-black tracking-tight ${tone}`}>{value}</p>
      <p className="mt-1 text-[9px] text-slate-600">{detail}</p>
    </div>
  );
}

export default function App() {
  const [showSettings, setShowSettings] = useState(false);
  const [credentialsConfigured, setCredentialsConfigured] = useState(false);
  const [serverConfig, setServerConfig] = useState<BinanceConfig | null>(null);
  const [apiStatus, setApiStatus] = useState<ApiStatus>('CHECKING');
  const [account, setAccount] = useState<AccountSummary>(EMPTY_ACCOUNT);
  const [positions, setPositions] = useState<any[]>([]);
  const [openOrders, setOpenOrders] = useState<any[]>([]);
  const [accountError, setAccountError] = useState('');
  const [accountLoading, setAccountLoading] = useState(false);

  const [marketStatus, setMarketStatus] = useState<MarketStatus>('CONNECTING');
  const [lastMarketTick, setLastMarketTick] = useState(0);
  const [clock, setClock] = useState(Date.now());

  const refreshAccount = useCallback(async () => {
    setAccountLoading(true);
    setAccountError('');
    try {
      const [accountData, positionData, orderData] = await Promise.all([
        getBinanceAccount(),
        getBinancePositions(),
        getBinanceOpenOrders(),
      ]);

      setAccount({
        availableBalance: String(accountData.availableBalance ?? '0'),
        totalWalletBalance: String(accountData.totalWalletBalance ?? '0'),
        totalUnrealizedProfit: String(accountData.totalUnrealizedProfit ?? '0'),
        canTrade: Boolean(accountData.canTrade),
      });
      setPositions(Array.isArray(positionData.positions) ? positionData.positions : []);
      setOpenOrders(Array.isArray(orderData.orders) ? orderData.orders : []);
      setApiStatus('CONNECTED');
    } catch (error) {
      setApiStatus('ERROR');
      setAccountError(error instanceof Error ? error.message : 'Unable to verify Binance Demo account.');
    } finally {
      setAccountLoading(false);
    }
  }, []);

  const loadConnection = useCallback(async () => {
    setApiStatus('CHECKING');
    try {
      const config = await getBinanceConfig();
      setServerConfig(config);
      const configured = Boolean(config.credentialsConfigured);
      setCredentialsConfigured(configured);

      if (!configured) {
        setAccount(EMPTY_ACCOUNT);
        setPositions([]);
        setOpenOrders([]);
        setApiStatus('DISCONNECTED');
        return;
      }

      await refreshAccount();
    } catch (error) {
      setApiStatus('ERROR');
      setAccountError(error instanceof Error ? error.message : 'Unable to read Binance server configuration.');
    }
  }, [refreshAccount]);

  useEffect(() => {
    void loadConnection();
  }, [loadConnection]);

  // Binance Demo account information is refreshed automatically while linked.
  useEffect(() => {
    if (!credentialsConfigured) return;
    const timer = window.setInterval(() => void refreshAccount(), 30_000);
    return () => window.clearInterval(timer);
  }, [credentialsConfigured, refreshAccount]);

  // Public Binance USD-M Futures Demo market stream. This is market data,
  // not the private API-key/account connection shown separately above.
  useEffect(() => {
    let socket: WebSocket | null = null;
    let stopped = false;
    let retryTimer: number | undefined;
    let retryDelay = 1_000;

    const connect = () => {
      if (stopped) return;
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      try {
        socket = new WebSocket(`${protocol}//${window.location.host}/ws/market`);
        socket.onopen = () => setMarketStatus('CONNECTING');
        socket.onmessage = event => {
          try {
            const message = JSON.parse(event.data);
            if (message.type === 'connection') {
              setMarketStatus(message.upstream === 'LIVE'
                ? 'LIVE'
                : message.upstream === 'OFFLINE'
                  ? 'OFFLINE'
                  : 'RECONNECTING');
              return;
            }
            const ticker = message.data || message;
            if (ticker.s && Number(ticker.c) > 0) {
              setLastMarketTick(Date.now());
              retryDelay = 1_000;
            }
          } catch {
            // Ignore malformed or non-ticker stream messages.
          }
        };
        socket.onerror = () => {
          setMarketStatus('RECONNECTING');
          socket?.close();
        };
        socket.onclose = () => {
          if (stopped) return;
          setMarketStatus('RECONNECTING');
          retryTimer = window.setTimeout(connect, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 15_000);
        };
      } catch {
        setMarketStatus('OFFLINE');
        retryTimer = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 15_000);
      }
    };

    connect();
    return () => {
      stopped = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  const marketFresh = marketStatus === 'LIVE' && lastMarketTick > 0 && clock - lastMarketTick < 30_000;
  const apiVerified = apiStatus === 'CONNECTED';
  const positivePnl = Number(account.totalUnrealizedProfit) >= 0;

  const handleConnectionChange = useCallback((state: BinanceConnectionState) => {
    setCredentialsConfigured(state.connected);
    if (state.connected) {
      setApiStatus('CHECKING');
      setAccount(previous => ({
        ...previous,
        totalWalletBalance: String(state.walletBalance ?? previous.totalWalletBalance),
        availableBalance: String(state.availableBalance ?? previous.availableBalance),
        canTrade: Boolean(state.canTrade),
      }));
      void refreshAccount();
    } else {
      setApiStatus('DISCONNECTED');
      setAccount(EMPTY_ACCOUNT);
      setPositions([]);
      setOpenOrders([]);
      setAccountError('Binance Futures Demo account disconnected.');
    }
  }, [refreshAccount]);

  const accountStatusLabel = useMemo(() => {
    if (apiStatus === 'CONNECTED') return 'DEMO ACCOUNT VERIFIED';
    if (apiStatus === 'CHECKING') return 'VERIFYING DEMO ACCOUNT';
    if (apiStatus === 'ERROR') return 'ACCOUNT CHECK FAILED';
    return 'DEMO ACCOUNT NOT LINKED';
  }, [apiStatus]);

  return (
    <div className="min-h-screen bg-[#070d17] text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#080f1b]/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1600px] flex-col justify-between gap-4 px-4 py-4 sm:flex-row sm:items-center lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-300 to-blue-500 text-lg font-black text-[#06101b] shadow-lg shadow-cyan-500/10">T</div>
            <div>
              <h1 className="text-base font-black tracking-[0.12em] text-white">TURBOSCALP <span className="text-cyan-300">AI</span></h1>
              <p className="mt-1 text-[8px] font-semibold tracking-[0.2em] text-slate-500">BINANCE USD-M FUTURES DEMO TERMINAL</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <StatusPill
              label={marketFresh ? 'DEMO MARKET FEED LIVE' : `MARKET FEED ${marketStatus}`}
              active={marketFresh}
              warning={marketStatus === 'CONNECTING' || marketStatus === 'RECONNECTING'}
            />
            <StatusPill
              label={accountStatusLabel}
              active={apiVerified}
              warning={apiStatus === 'CHECKING' || apiStatus === 'ERROR'}
            />
            <button
              onClick={() => setShowSettings(true)}
              className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-[9px] font-black tracking-wide text-cyan-200 transition hover:bg-cyan-400/20"
            >
              {credentialsConfigured ? 'DEMO API SETTINGS' : 'CONNECT DEMO API'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1600px] space-y-5 px-4 py-5 lg:px-8 lg:py-7">
        <section className="rounded-2xl border border-amber-500/25 bg-amber-500/[0.055] px-4 py-3 sm:px-5">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-[10px] font-black tracking-[0.16em] text-amber-200">DEMO ENVIRONMENT · LIVE TRADING DISABLED</p>
              <p className="mt-1 text-[9px] leading-relaxed text-slate-400">
                Market data and account connection are restricted to Binance USD-M Futures Demo. The autonomous bot below creates browser-side paper simulations only; this dashboard has no manual order-entry terminal.
              </p>
            </div>
            <span className="mt-2 shrink-0 rounded-lg border border-amber-500/20 px-3 py-2 text-[8px] font-bold tracking-wider text-amber-200 sm:mt-0">NO LIVE ORDERS</span>
          </div>
        </section>

        <QuantAIEngine />

        <section className="overflow-hidden rounded-2xl border border-slate-800 bg-[#0b1422]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-4 sm:px-5">
            <div>
              <h2 className="text-[11px] font-black tracking-[0.14em] text-white">BINANCE DEMO ACCOUNT</h2>
              <p className="mt-1 text-[9px] text-slate-500">Authenticated account information · automatic refresh every 30 seconds · no order entry</p>
            </div>
            <div className="flex items-center gap-2 text-[9px]">
              <span className={apiVerified ? 'text-emerald-300' : 'text-slate-500'}>{apiVerified ? 'ACCOUNT VERIFIED' : accountLoading ? 'SYNCING…' : accountStatusLabel}</span>
              {accountLoading && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-cyan-300" />}
            </div>
          </div>

          {!credentialsConfigured ? (
            <div className="px-5 py-8 text-center">
              <p className="text-[11px] font-bold text-slate-300">Link your Binance Futures Demo API to view your account.</p>
              <p className="mt-2 text-[9px] text-slate-500">The public Demo market scanner and chart continue to work without private account credentials.</p>
              <button onClick={() => setShowSettings(true)} className="mt-4 rounded-lg bg-cyan-400 px-4 py-2.5 text-[9px] font-black text-slate-950">CONNECT DEMO ACCOUNT</button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3 sm:p-5">
                <AccountMetric label="Wallet balance" value={money(account.totalWalletBalance)} detail="USD-M Futures Demo wallet" tone="text-white" />
                <AccountMetric label="Available balance" value={money(account.availableBalance)} detail="Available demo margin" tone="text-cyan-200" />
                <AccountMetric label="Exchange unrealized P&L" value={money(account.totalUnrealizedProfit)} detail="From Binance Demo positions" tone={positivePnl ? 'text-emerald-300' : 'text-rose-300'} />
              </div>

              <div className="grid border-t border-slate-800 lg:grid-cols-2">
                <div className="p-4 sm:p-5 lg:border-r lg:border-slate-800">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-[9px] font-black tracking-[0.12em] text-white">EXCHANGE POSITIONS <span className="ml-1 text-slate-500">{positions.length}</span></h3>
                    <span className="text-[8px] text-slate-600">DEMO ACCOUNT</span>
                  </div>
                  {positions.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center text-[9px] text-slate-500">No open Binance Demo positions.</p>
                  ) : (
                    <div className="space-y-2">
                      {positions.map((position, index) => {
                        const amount = Number(position.positionAmt || 0);
                        const pnl = Number(position.unrealizedProfit ?? position.unRealizedProfit ?? 0);
                        return (
                          <div key={`${position.symbol}-${index}`} className="grid grid-cols-2 gap-3 rounded-lg border border-slate-800 bg-[#080f1b] p-3 sm:grid-cols-4">
                            <div><p className="text-[8px] text-slate-600">PAIR / SIDE</p><p className="mt-1 text-[10px] font-black text-white">{position.symbol}</p><p className={`mt-1 text-[8px] font-bold ${amount >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{amount >= 0 ? 'LONG' : 'SHORT'}</p></div>
                            <div><p className="text-[8px] text-slate-600">SIZE</p><p className="mt-1 text-[10px] text-slate-200">{position.positionAmt}</p></div>
                            <div><p className="text-[8px] text-slate-600">ENTRY / MARK</p><p className="mt-1 text-[10px] text-slate-200">{Number(position.entryPrice || 0).toPrecision(7)}</p><p className="mt-1 text-[8px] text-slate-500">Mark {Number(position.markPrice || 0).toPrecision(7)}</p></div>
                            <div><p className="text-[8px] text-slate-600">UNREALIZED P&L</p><p className={`mt-1 text-[10px] font-bold ${pnl >= 0 ? 'text-emerald-300' : 'text-rose-300'}`}>{money(pnl)}</p><p className="mt-1 text-[8px] text-slate-500">{position.leverage || 1}x leverage</p></div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                <div className="p-4 sm:p-5">
                  <div className="mb-3 flex items-center justify-between gap-2">
                    <h3 className="text-[9px] font-black tracking-[0.12em] text-white">EXCHANGE OPEN ORDERS <span className="ml-1 text-slate-500">{openOrders.length}</span></h3>
                    <span className="text-[8px] text-slate-600">READ ONLY</span>
                  </div>
                  {openOrders.length === 0 ? (
                    <p className="rounded-lg border border-dashed border-slate-800 px-3 py-5 text-center text-[9px] text-slate-500">No open Binance Demo orders.</p>
                  ) : (
                    <div className="space-y-2">
                      {openOrders.slice(0, 8).map((order, index) => (
                        <div key={order.orderId ?? index} className="flex items-center justify-between gap-3 rounded-lg border border-slate-800 bg-[#080f1b] p-3">
                          <div><p className="text-[10px] font-bold text-white">{order.symbol}</p><p className="mt-1 text-[8px] text-slate-500">{order.side} · {order.type}</p></div>
                          <div className="text-right"><p className="text-[9px] font-bold text-amber-300">{order.status}</p><p className="mt-1 text-[8px] text-slate-600">#{order.orderId}</p></div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
          {accountError && <p className="border-t border-rose-500/20 bg-rose-500/[0.04] px-5 py-3 text-[9px] text-rose-300">Account sync issue: {accountError}</p>}
        </section>

        <footer className="flex flex-col justify-between gap-2 border-t border-slate-800/80 pt-4 text-[8px] leading-relaxed text-slate-600 sm:flex-row">
          <span>TURBOSCALP AI · BINANCE USD-M FUTURES DEMO</span>
          <span>Public Demo market data · authenticated account view · browser-side paper trading only</span>
        </footer>
      </main>

      <ApiSettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        connected={credentialsConfigured}
        walletBalance={Number(account.totalWalletBalance) || 0}
        availableBalance={Number(account.availableBalance) || 0}
        canTrade={account.canTrade}
        onConnectionChange={handleConnectionChange}
      />

      <span className="sr-only">Market feed updated {lastMarketTick ? new Date(lastMarketTick).toLocaleTimeString() : 'waiting'}; app clock {clock}; environment {serverConfig?.environment || 'Demo'}.</span>
    </div>
  );
}
