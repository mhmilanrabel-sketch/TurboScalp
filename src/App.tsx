import React, { useCallback, useEffect, useState } from 'react';
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

  useEffect(() => { void loadConnection(); }, [loadConnection]);

  useEffect(() => {
    if (!credentialsConfigured) return;
    const timer = window.setInterval(() => void refreshAccount(), 30_000);
    return () => window.clearInterval(timer);
  }, [credentialsConfigured, refreshAccount]);

  // Public Binance Futures Demo market stream. It reports feed health only;
  // the autonomous bot uses the authenticated server-side Demo REST routes.
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

  const handleConnectionChange = useCallback((connection: BinanceConnectionState) => {
    setCredentialsConfigured(connection.connected);
    if (connection.connected) {
      setApiStatus('CHECKING');
      void refreshAccount();
    } else {
      setApiStatus('DISCONNECTED');
      setAccount(EMPTY_ACCOUNT);
      setPositions([]);
      setOpenOrders([]);
      setAccountError('Binance Futures Demo account disconnected.');
    }
  }, [refreshAccount]);

  const marketFresh = marketStatus === 'LIVE' && lastMarketTick > 0 && clock - lastMarketTick < 30_000;
  const apiVerified = credentialsConfigured && apiStatus === 'CONNECTED';

  return (
    <div className="min-h-screen bg-[#070d17] text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#080f1b]/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] flex-col justify-between gap-4 px-4 py-4 sm:flex-row sm:items-center lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-300 to-blue-500 text-lg font-black text-[#06101b] shadow-lg shadow-cyan-500/10">T</div>
            <div>
              <h1 className="text-base font-black tracking-[0.12em] text-white">TURBOSCALP <span className="text-cyan-300">AI</span></h1>
              <p className="mt-1 text-[8px] font-semibold tracking-[0.2em] text-slate-500">SINGLE AUTONOMOUS BINANCE DEMO ENGINE</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`rounded-full border px-3 py-2 text-[9px] font-bold ${marketFresh ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>
              {marketFresh ? 'DEMO MARKET FEED LIVE' : `MARKET FEED ${marketStatus}`}
            </span>
            <span className={`rounded-full border px-3 py-2 text-[9px] font-bold ${apiVerified ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-amber-500/30 bg-amber-500/10 text-amber-200'}`}>
              {apiVerified ? 'DEMO ACCOUNT VERIFIED' : apiStatus === 'CHECKING' ? 'VERIFYING ACCOUNT' : 'DEMO API NOT VERIFIED'}
            </span>
            <button onClick={() => setShowSettings(true)} className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-4 py-2 text-[9px] font-black tracking-wide text-cyan-200 transition hover:bg-cyan-400/20">
              {credentialsConfigured ? 'DEMO API SETTINGS' : 'CONNECT DEMO API'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-5 lg:px-8 lg:py-7">
        <QuantAIEngine
          account={account}
          apiConnected={apiVerified}
          accountLoading={accountLoading}
          accountError={accountError}
          positions={positions}
          openOrders={openOrders}
          onRefreshAccount={refreshAccount}
          onOpenApiSettings={() => setShowSettings(true)}
        />
        <footer className="mt-6 flex flex-col justify-between gap-2 border-t border-slate-800/80 pt-4 text-[8px] leading-relaxed text-slate-600 sm:flex-row">
          <span>TURBOSCALP AI · BINANCE USD-M FUTURES DEMO</span>
          <span>Demo API only · exchange orders · no live endpoint configured</span>
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
      <span className="sr-only">Market data updated {lastMarketTick ? new Date(lastMarketTick).toLocaleTimeString() : 'waiting'}; environment {serverConfig?.environment || 'Demo'}.</span>
    </div>
  );
}
