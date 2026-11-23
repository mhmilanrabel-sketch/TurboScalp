import React, { useCallback, useEffect, useState } from 'react';
import {
  executeBinanceOrder,
  getBinanceAccount,
  getBinanceConfig,
  getBinanceOpenOrders,
  getBinancePositions,
  testBinanceConnection,
  validateBinanceOrder,
  type BinanceConnectionState,
  type BinanceConfig,
  type FuturesPermissionDiagnostics,
} from './services/binanceService';
import { ApiSettingsModal } from './components/ApiSettingsModal';
import { MultiAgentPanel } from './components/MultiAgentPanel';
import { QuantAIEngine } from './components/QuantAIEngine';

type ApiStatus = 'CHECKING' | 'CONNECTED' | 'DISCONNECTED' | 'ERROR';
type MarketStatus = 'CONNECTING' | 'LIVE' | 'RECONNECTING' | 'OFFLINE';
type WorkspaceTab = 'MULTI_AGENT' | 'CLASSIC_BOT' | 'MANUAL_TRADE';

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

const MANUAL_SYMBOLS = [
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT',
  'DOGEUSDT',
  'ADAUSDT',
  'AVAXUSDT',
];

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
  const [permissionDiagnostics, setPermissionDiagnostics] =
    useState<FuturesPermissionDiagnostics | null>(null);
  const [checkingPermission, setCheckingPermission] = useState(false);
  const [marketStatus, setMarketStatus] = useState<MarketStatus>('CONNECTING');
  const [lastMarketTick, setLastMarketTick] = useState(0);
  const [clock, setClock] = useState(Date.now());
  const [activeTab, setActiveTab] = useState<WorkspaceTab>('MULTI_AGENT');

  // Manual Binance Demo order state (preserves manual trading capability)
  const [manualSymbol, setManualSymbol] = useState('BTCUSDT');
  const [manualSide, setManualSide] = useState<'BUY' | 'SELL'>('BUY');
  const [manualNotional, setManualNotional] = useState(50);
  const [manualLeverage, setManualLeverage] = useState(2);
  const [manualBusy, setManualBusy] = useState(false);
  const [manualMessage, setManualMessage] = useState<{
    type: 'ok' | 'err';
    text: string;
  } | null>(null);

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
      if (accountData.diagnostics) {
        setPermissionDiagnostics(accountData.diagnostics);
      }
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

  const handleCheckPermission = useCallback(async () => {
    setCheckingPermission(true);
    try {
      const result = await testBinanceConnection();
      setPermissionDiagnostics(result);
      setCredentialsConfigured(result.apiAuthenticated);
      if (result.apiAuthenticated) {
        setApiStatus('CONNECTED');
        setAccount((prev) => ({
          ...prev,
          canTrade: result.canTrade,
          totalWalletBalance:
            result.walletBalance !== undefined
              ? String(result.walletBalance)
              : prev.totalWalletBalance,
          availableBalance:
            result.availableBalance !== undefined
              ? String(result.availableBalance)
              : prev.availableBalance,
        }));
      } else {
        setApiStatus('DISCONNECTED');
        setAccount(EMPTY_ACCOUNT);
        setPositions([]);
        setOpenOrders([]);
      }
    } finally {
      setCheckingPermission(false);
    }
  }, []);

  const loadConnection = useCallback(async () => {
    setApiStatus('CHECKING');
    try {
      const config = await getBinanceConfig();
      setServerConfig(config);
      if (config.diagnostics !== undefined) {
        setPermissionDiagnostics(config.diagnostics ?? null);
      }
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
  // the autonomous engine uses authenticated server-side Demo REST routes.
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
    if (connection.diagnostics !== undefined) {
      setPermissionDiagnostics(connection.diagnostics ?? null);
    }
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

  const handleManualOrder = async (dryRun: boolean) => {
    setManualBusy(true);
    setManualMessage(null);
    try {
      const payload = {
        symbol: manualSymbol,
        side: manualSide,
        quantityUsd: Math.max(10, Math.min(100, manualNotional)),
        leverage: Math.max(1, Math.min(2, manualLeverage)),
      };
      const res = dryRun
        ? await validateBinanceOrder(payload)
        : await executeBinanceOrder(payload);
      setManualMessage({
        type: 'ok',
        text: dryRun
          ? `Order validated cleanly on Demo exchange: ${manualSide} ${manualSymbol} ($${payload.quantityUsd} @ ${payload.leverage}x).`
          : `Demo order executed (#${res?.orderId ?? 'confirmed'}): ${manualSide} ${res?.executedQty ?? ''} ${manualSymbol}.`,
      });
      if (!dryRun) {
        await refreshAccount();
      }
    } catch (error) {
      setManualMessage({
        type: 'err',
        text: error instanceof Error ? error.message : 'Manual order request failed.',
      });
    } finally {
      setManualBusy(false);
    }
  };

  const marketFresh = marketStatus === 'LIVE' && lastMarketTick > 0 && clock - lastMarketTick < 30_000;
  const apiVerified = credentialsConfigured && apiStatus === 'CONNECTED';
  const walletNum = Number(account.totalWalletBalance) || 0;
  const availNum = Number(account.availableBalance) || 0;
  const upnlNum = Number(account.totalUnrealizedProfit) || 0;

  return (
    <div className="min-h-screen bg-[#070d17] text-slate-100">
      <header className="sticky top-0 z-30 border-b border-slate-800/90 bg-[#080f1b]/95 backdrop-blur-xl">
        <div className="mx-auto flex max-w-[1500px] flex-col justify-between gap-3 px-4 py-3.5 sm:flex-row sm:items-center lg:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-300 to-blue-500 text-lg font-black text-[#06101b] shadow-lg shadow-cyan-500/10">T</div>
            <div>
              <h1 className="text-base font-black tracking-[0.12em] text-white">TURBOSCALP <span className="text-cyan-300">AI</span></h1>
              <p className="mt-0.5 text-[9px] font-semibold tracking-[0.18em] text-slate-400">6-AGENT AUTONOMOUS BINANCE DEMO ENGINE</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {apiVerified && (
              <div className="hidden lg:flex items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/80 px-3.5 py-1.5 text-xs tabular-nums">
                <div>
                  <span className="text-[10px] text-slate-400 mr-1.5">Demo Wallet:</span>
                  <span className="font-semibold text-white">${walletNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 mr-1.5">Available:</span>
                  <span className="font-semibold text-cyan-300">${availNum.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
                </div>
                <div>
                  <span className="text-[10px] text-slate-400 mr-1.5">uPnL:</span>
                  <span className={`font-semibold ${upnlNum >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {upnlNum >= 0 ? '+' : ''}${upnlNum.toFixed(2)}
                  </span>
                </div>
              </div>
            )}
            <span className={`rounded-md border px-2.5 py-1.5 text-[10px] font-bold ${marketFresh ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-slate-700 bg-slate-900 text-slate-400'}`}>
              {marketFresh ? 'DEMO MARKET FEED LIVE' : `MARKET FEED ${marketStatus}`}
            </span>
            <span
              className={`rounded-md border px-2.5 py-1.5 text-[10px] font-bold ${
                apiVerified && account.canTrade && permissionDiagnostics?.orderTestPassed
                  ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              }`}
            >
              {apiVerified
                ? account.canTrade && permissionDiagnostics?.orderTestPassed
                  ? 'DEMO TRADING READY'
                  : 'API AUTH · TRADING DISABLED'
                : apiStatus === 'CHECKING'
                  ? 'VERIFYING ACCOUNT'
                  : 'DEMO API NOT VERIFIED'}
            </span>
            <button onClick={() => setShowSettings(true)} className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3.5 py-1.5 text-[10px] font-bold tracking-wide text-cyan-200 transition hover:bg-cyan-400/20">
              {credentialsConfigured ? 'DEMO API SETTINGS' : 'CONNECT DEMO API'}
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-[1500px] px-4 py-5 lg:px-8 lg:py-6 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => setActiveTab('MULTI_AGENT')}
              className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition ${
                activeTab === 'MULTI_AGENT'
                  ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
                  : 'text-slate-400 hover:text-slate-200 border border-transparent hover:border-slate-800'
              }`}
            >
              Multi-Agent Control Panel
            </button>
            <button
              onClick={() => setActiveTab('CLASSIC_BOT')}
              className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition ${
                activeTab === 'CLASSIC_BOT'
                  ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
                  : 'text-slate-400 hover:text-slate-200 border border-transparent hover:border-slate-800'
              }`}
            >
              Classic Quant Engine &amp; Wallet
            </button>
            <button
              onClick={() => setActiveTab('MANUAL_TRADE')}
              className={`rounded-lg px-3.5 py-2 text-xs font-semibold transition ${
                activeTab === 'MANUAL_TRADE'
                  ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/40'
                  : 'text-slate-400 hover:text-slate-200 border border-transparent hover:border-slate-800'
              }`}
            >
              Manual Demo Order
            </button>
          </div>

          <div className="text-[11px] text-slate-400 tabular-nums">
            Wallet: <span className="font-semibold text-white">${walletNum.toFixed(2)}</span>
            <span className="mx-2 text-slate-700">|</span>
            Available: <span className="font-semibold text-cyan-300">${availNum.toFixed(2)}</span>
            <span className="mx-2 text-slate-700">|</span>
            Open Positions: <span className="font-semibold text-white">{positions.filter((p) => Math.abs(Number(p.positionAmt)) > 0).length}</span>
          </div>
        </div>

        {activeTab === 'MULTI_AGENT' && (
          <MultiAgentPanel
            apiConnected={apiVerified}
            canTrade={account.canTrade}
            availableBalance={account.availableBalance}
            exchangePositions={positions}
            openOrders={openOrders}
            permissionDiagnostics={permissionDiagnostics}
            checkingPermission={checkingPermission}
            onCheckPermission={handleCheckPermission}
            onOpenApiSettings={() => setShowSettings(true)}
            onRefreshAccount={refreshAccount}
          />
        )}

        {activeTab === 'CLASSIC_BOT' && (
          <QuantAIEngine
            account={account}
            apiConnected={apiVerified}
            accountLoading={accountLoading}
            accountError={accountError}
            positions={positions}
            openOrders={openOrders}
            permissionDiagnostics={permissionDiagnostics}
            checkingPermission={checkingPermission}
            onCheckPermission={handleCheckPermission}
            onRefreshAccount={refreshAccount}
            onOpenApiSettings={() => setShowSettings(true)}
          />
        )}

        {activeTab === 'MANUAL_TRADE' && (
          <section className="rounded-2xl border border-slate-800 bg-[#0b1322] p-5 space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 pb-4">
              <div>
                <h2 className="text-base font-bold text-white">Manual Binance Futures Demo Order</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Places direct orders via authenticated HttpOnly session on <span className="font-mono text-cyan-300">demo-fapi.binance.com</span> (capped at 100 USDT / 2x).
                </p>
              </div>
              {!apiVerified && (
                <button
                  onClick={() => setShowSettings(true)}
                  className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-500/20"
                >
                  Connect Demo API
                </button>
              )}
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <label className="space-y-1.5 text-xs">
                <span className="text-slate-400 font-medium">USD-M Perpetual Pair</span>
                <select
                  value={manualSymbol}
                  onChange={(e) => setManualSymbol(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-[#070d17] px-3 py-2 text-sm font-semibold text-white"
                >
                  {MANUAL_SYMBOLS.map((sym) => (
                    <option key={sym} value={sym}>{sym}</option>
                  ))}
                </select>
              </label>

              <div className="space-y-1.5 text-xs">
                <span className="text-slate-400 font-medium block">Direction</span>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setManualSide('BUY')}
                    className={`rounded-lg py-2 text-xs font-bold border transition ${
                      manualSide === 'BUY'
                        ? 'border-emerald-500/60 bg-emerald-500/20 text-emerald-300'
                        : 'border-slate-700 bg-[#070d17] text-slate-400'
                    }`}
                  >
                    BUY / LONG
                  </button>
                  <button
                    type="button"
                    onClick={() => setManualSide('SELL')}
                    className={`rounded-lg py-2 text-xs font-bold border transition ${
                      manualSide === 'SELL'
                        ? 'border-rose-500/60 bg-rose-500/20 text-rose-300'
                        : 'border-slate-700 bg-[#070d17] text-slate-400'
                    }`}
                  >
                    SELL / SHORT
                  </button>
                </div>
              </div>

              <label className="space-y-1.5 text-xs">
                <span className="text-slate-400 font-medium">Order Notional (10–100 USDT)</span>
                <input
                  type="number"
                  min={10}
                  max={100}
                  step={5}
                  value={manualNotional}
                  onChange={(e) => setManualNotional(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-[#070d17] px-3 py-2 text-sm font-semibold text-white tabular-nums"
                />
              </label>

              <label className="space-y-1.5 text-xs">
                <span className="text-slate-400 font-medium">Leverage (1x–2x Demo Cap)</span>
                <select
                  value={manualLeverage}
                  onChange={(e) => setManualLeverage(Number(e.target.value))}
                  className="w-full rounded-lg border border-slate-700 bg-[#070d17] px-3 py-2 text-sm font-semibold text-white tabular-nums"
                >
                  <option value={1}>1x</option>
                  <option value={2}>2x</option>
                </select>
              </label>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={!apiVerified || manualBusy}
                onClick={() => void handleManualOrder(true)}
                className="rounded-lg border border-slate-700 bg-slate-900 px-4 py-2 text-xs font-bold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
              >
                {manualBusy ? 'Working...' : 'Validate Demo Order'}
              </button>
              <button
                type="button"
                disabled={
                  !apiVerified ||
                  !account.canTrade ||
                  permissionDiagnostics?.orderTestPassed !== true ||
                  manualBusy
                }
                onClick={() => void handleManualOrder(false)}
                className={`rounded-lg px-4 py-2 text-xs font-bold text-slate-950 transition disabled:opacity-40 ${
                  manualSide === 'BUY' ? 'bg-emerald-400 hover:bg-emerald-300' : 'bg-rose-400 hover:bg-rose-300'
                }`}
              >
                {manualBusy ? 'Executing...' : `Execute Demo ${manualSide}`}
              </button>
            </div>

            {manualMessage && (
              <div
                className={`rounded-lg border px-4 py-3 text-xs ${
                  manualMessage.type === 'ok'
                    ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
                    : 'border-rose-500/40 bg-rose-500/10 text-rose-200'
                }`}
              >
                {manualMessage.text}
              </div>
            )}
          </section>
        )}

        <footer className="mt-6 flex flex-col justify-between gap-2 border-t border-slate-800/80 pt-4 text-[10px] leading-relaxed text-slate-500 sm:flex-row">
          <span>TURBOSCALP AI · BINANCE USD-M FUTURES DEMO (6-AGENT ENGINE)</span>
          <span>Demo API only (demo-fapi.binance.com) · HttpOnly session auth · Risk-gated execution</span>
        </footer>
      </main>

      <ApiSettingsModal
        isOpen={showSettings}
        onClose={() => setShowSettings(false)}
        connected={credentialsConfigured}
        walletBalance={walletNum}
        availableBalance={availNum}
        canTrade={account.canTrade}
        permissionDiagnostics={permissionDiagnostics}
        onDiagnosticsUpdate={setPermissionDiagnostics}
        onConnectionChange={handleConnectionChange}
      />
      <span className="sr-only">Market data updated {lastMarketTick ? new Date(lastMarketTick).toLocaleTimeString() : 'waiting'}; environment {serverConfig?.environment || 'Demo'}.</span>
    </div>
  );
}
