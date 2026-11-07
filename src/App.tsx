
import React, {
  useState,
  useEffect,
  useMemo,
  useCallback,
  useRef
} from 'react';

import {
  apiRequest,
  getBinanceConfig,
  getBinanceAccount,
  getBinancePositions,
  getBinanceOpenOrders,
  fetchBinanceKlines,
  validateBinanceOrder,
  executeBinanceOrder,
  type BinanceConnectionState,
  type BinanceConfig
} from './services/binanceService';

import { ApiSettingsModal } from './components/ApiSettingsModal';
import { QuantAIEngine } from './components/QuantAIEngine';

// ======================================================
// TYPES
// ======================================================

type ConnectionStatus =
  | 'LIVE'
  | 'RECONNECTING'
  | 'OFFLINE';

type TradingMode =
  | 'PAPER'
  | 'BINANCE_DEMO';

type SignalType =
  | 'BUY'
  | 'SELL'
  | 'NEUTRAL';

interface MarketAsset {
  symbol: string;
  name: string;
  price: number;
  high24h: number;
  low24h: number;
  change24h: number;
  volume24h: number;
  rsi: number | null;
  ema9: number | null;
  ema21: number | null;
  signal: SignalType;
  updatedAt: number;
}

interface AccountData {
  availableBalance: string;
  totalWalletBalance: string;
  totalUnrealizedProfit: string;
  canTrade: boolean;
}

interface Position {
  symbol: string;
  positionAmt: string;
  entryPrice: string;
  markPrice: string;
  unrealizedProfit: string;
  leverage: string;
}

interface PaperOrder {
  id: number;
  symbol: string;
  side: string;
  quantityUsd: number;
  leverage: number;
  price: number;
  createdAt: string;
  status: string;
}

// ======================================================
// MARKET SYMBOLS
// ======================================================

const SYMBOLS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin' },
  { symbol: 'ETHUSDT', name: 'Ethereum' },
  { symbol: 'SOLUSDT', name: 'Solana' },
  { symbol: 'BNBUSDT', name: 'BNB' },
  { symbol: 'XRPUSDT', name: 'XRP' },
  { symbol: 'DOGEUSDT', name: 'Dogecoin' },
  { symbol: 'ADAUSDT', name: 'Cardano' },
  { symbol: 'AVAXUSDT', name: 'Avalanche' },
  { symbol: 'LINKUSDT', name: 'Chainlink' },
  { symbol: 'SUIUSDT', name: 'Sui' },
  { symbol: 'NEARUSDT', name: 'NEAR' },
  { symbol: 'PEPEUSDT', name: 'Pepe' }
];

const EMPTY_ACCOUNT: AccountData = {
  availableBalance: '0',
  totalWalletBalance: '0',
  totalUnrealizedProfit: '0',
  canTrade: false
};

// ======================================================
// INITIAL MARKET DATA
// ======================================================

function createInitialAssets(): MarketAsset[] {

  return SYMBOLS.map(item => ({

    symbol: item.symbol,

    name: item.name,

    price: 0,

    high24h: 0,

    low24h: 0,

    change24h: 0,

    volume24h: 0,

    rsi: null,

    ema9: null,

    ema21: null,

    signal: 'NEUTRAL',

    updatedAt: 0

  }));

}

// ======================================================
// FORMATTING
// ======================================================

function formatPrice(value: number): string {

  if (!Number.isFinite(value) || value <= 0) {
    return '—';
  }

  const decimals =
    value >= 1000 ? 2 :
    value >= 1 ? 4 : 7;

  return '$' + value.toLocaleString('en-US', {

    minimumFractionDigits: 2,

    maximumFractionDigits: decimals

  });

}

function formatMoney(value: number): string {

  if (!Number.isFinite(value)) {
    return '$0.00';
  }

  return '$' + value.toLocaleString('en-US', {

    minimumFractionDigits: 2,

    maximumFractionDigits: 4

  });

}

function formatVolume(value: number): string {

  if (!Number.isFinite(value)) return '—';

  if (value >= 1_000_000_000) {

    return '$' +
      (value / 1_000_000_000).toFixed(2) + 'B';

  }

  if (value >= 1_000_000) {

    return '$' +
      (value / 1_000_000).toFixed(2) + 'M';

  }

  if (value >= 1000) {

    return '$' +
      (value / 1000).toFixed(2) + 'K';

  }

  return '$' + value.toFixed(2);

}

// ======================================================
// EMA CALCULATION
// ======================================================

function calculateEMA(
  values: number[],
  period: number
): number | null {

  if (values.length < period) {
    return null;
  }

  const multiplier = 2 / (period + 1);

  let ema = values
    .slice(0, period)
    .reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < values.length; i++) {

    ema =
      (values[i] - ema) * multiplier + ema;

  }

  return ema;

}

// ======================================================
// RSI CALCULATION
// ======================================================

function calculateRSI(
  closes: number[],
  period = 14
): number | null {

  if (closes.length <= period) {
    return null;
  }

  let gains = 0;

  let losses = 0;

  const start = closes.length - period;

  for (let i = start; i < closes.length; i++) {

    const change = closes[i] - closes[i - 1];

    if (change > 0) {

      gains += change;

    } else {

      losses += Math.abs(change);

    }

  }

  const averageGain = gains / period;

  const averageLoss = losses / period;

  if (averageLoss === 0) return 100;

  if (averageGain === 0) return 0;

  const rs = averageGain / averageLoss;

  return 100 - (100 / (1 + rs));

}

// ======================================================
// TECHNICAL SIGNAL
// ======================================================

function calculateSignal(
  ema9: number,
  ema21: number,
  rsi: number,
  dailyChange: number
): SignalType {

  if (
    ema9 > ema21 &&
    rsi >= 50 &&
    rsi < 70 &&
    dailyChange > 0
  ) {

    return 'BUY';

  }

  if (
    ema9 < ema21 &&
    rsi <= 50 &&
    rsi > 30 &&
    dailyChange < 0
  ) {

    return 'SELL';

  }

  return 'NEUTRAL';

}

// ======================================================
// MAIN APPLICATION
// ======================================================

export default function App() {

  // ====================================================
  // MARKET DATA STATES
  // ====================================================

  const [assets, setAssets] =
    useState<MarketAsset[]>(createInitialAssets);

  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('RECONNECTING');

  const [search, setSearch] =
    useState('');

  const [selectedSymbol, setSelectedSymbol] =
    useState('BTCUSDT');

  // ====================================================
  // BINANCE API STATES
  // ====================================================

  const [isBinanceConnected, setIsBinanceConnected] =
    useState(false);

  const [serverConfig, setServerConfig] =
    useState<BinanceConfig | null>(null);

  const [showSettings, setShowSettings] =
    useState(false);

  const [tradingMode, setTradingMode] =
    useState<TradingMode>('PAPER');

  // ====================================================
  // ACCOUNT BALANCE STATES
  // ====================================================

  const [account, setAccount] =
    useState<AccountData>(EMPTY_ACCOUNT);

  const [positions, setPositions] =
    useState<Position[]>([]);

  const [openOrders, setOpenOrders] =
    useState<any[]>([]);

  const [accountLoading, setAccountLoading] =
    useState(false);

  const [accountError, setAccountError] =
    useState('');

  // ====================================================
  // SCANNER STATES
  // ====================================================

  const [scannerRunning, setScannerRunning] =
    useState(true);

  const [scannerLoading, setScannerLoading] =
    useState(false);

  const [scanError, setScanError] =
    useState('');

  const scannerBusyRef = useRef(false);

  // ====================================================
  // ORDER STATES
  // ====================================================

  const [orderSide, setOrderSide] =
    useState<'BUY' | 'SELL'>('BUY');

  const [quantityUsd, setQuantityUsd] =
    useState('25');

  const [leverage, setLeverage] =
    useState('2');

  const [orderLoading, setOrderLoading] =
    useState(false);

  const [orderMessage, setOrderMessage] =
    useState('');

  const [paperOrders, setPaperOrders] =
    useState<PaperOrder[]>([]);

  // ====================================================
  // ACTIVITY LOG
  // ====================================================

  const [alerts, setAlerts] =
    useState<string[]>([
      'TurboScalp started. Waiting for Binance market data.'
    ]);

  // ====================================================
  // ACTIVITY LOGGER
  // ====================================================

  const pushAlert = useCallback(
    (message: string) => {

      const timestamp =
        new Date().toLocaleTimeString();

      setAlerts(previous => [

        `[${timestamp}] ${message}`,

        ...previous

      ].slice(0, 40));

    },
    []
  );

  // ====================================================
  // APPLY ACCOUNT DATA
  // ====================================================

  const applyAccountData = useCallback(
    (data: any) => {

      setAccount({

        availableBalance: String(
          data.availableBalance ?? '0'
        ),

        totalWalletBalance: String(
          data.totalWalletBalance ?? '0'
        ),

        totalUnrealizedProfit: String(
          data.totalUnrealizedProfit ?? '0'
        ),

        canTrade: Boolean(data.canTrade)

      });

    },
    []
  );

  // ====================================================
  // LOAD SERVER CONFIGURATION AND ACCOUNT
  // ====================================================

  const loadServerConfig = useCallback(async () => {

    try {

      const config = await getBinanceConfig();

      setServerConfig(config);

      const connected = Boolean(
        config.credentialsConfigured
      );

      setIsBinanceConnected(connected);

      setTradingMode(
        connected
          ? 'BINANCE_DEMO'
          : 'PAPER'
      );

      if (connected) {

        try {

          // Restore real account balances after page reload.

          const accountData =
            await getBinanceAccount();

          applyAccountData(accountData);

        } catch (error) {

          console.error(
            'Connected account balance retrieval failed:',
            error
          );

          setAccountError(
            error instanceof Error
              ? error.message
              : 'Unable to load account balance.'
          );

        }

      } else {

        setAccount(EMPTY_ACCOUNT);

        setPositions([]);

        setOpenOrders([]);

      }

    } catch (error) {

      console.error(
        'Server configuration request failed:',
        error
      );

      setServerConfig(null);

    }

  }, [applyAccountData]);

  // ====================================================
  // RESTORE CONNECTION AFTER APP START
  // ====================================================

  useEffect(() => {

    void loadServerConfig();

  }, [loadServerConfig]);

  // ====================================================
  // BINANCE MARKET WEBSOCKET
  // ====================================================

  useEffect(() => {

    let socket: WebSocket | null = null;

    let reconnectTimer:
      ReturnType<typeof setTimeout> | null = null;

    let reconnectDelay = 1000;

    let stopped = false;

    function connect() {

      if (stopped) return;

      const protocol =
        window.location.protocol === 'https:'
          ? 'wss:'
          : 'ws:';

      // Dedicated market endpoint.
      // Vite HMR does not use this connection.

      const socketUrl =
        `${protocol}//${window.location.host}/ws/market`;

      try {

        socket = new WebSocket(socketUrl);

        socket.onopen = () => {

          // Socket connection alone is not market data.

          setConnectionStatus('RECONNECTING');

        };

        socket.onmessage = event => {

          try {

            const message = JSON.parse(event.data);

            // ------------------------------------------
            // UPSTREAM CONNECTION STATUS
            // ------------------------------------------

            if (message.type === 'connection') {

              if (message.upstream === 'LIVE') {

                setConnectionStatus('LIVE');

              } else if (
                message.upstream === 'OFFLINE'
              ) {

                setConnectionStatus('OFFLINE');

              } else {

                setConnectionStatus('RECONNECTING');

              }

              return;

            }

            // ------------------------------------------
            // BINANCE TICKER DATA
            // ------------------------------------------

            const ticker =
              message.data || message;

            if (
              !ticker.s ||
              ticker.c === undefined
            ) {
              return;
            }

            const symbol =
              String(ticker.s).toUpperCase();

            const price = Number(ticker.c);

            if (
              !Number.isFinite(price) ||
              price <= 0
            ) {
              return;
            }

            // Reset reconnect backoff after valid data.

            reconnectDelay = 1000;

            setAssets(previous =>
              previous.map(asset => {

                if (asset.symbol !== symbol) {
                  return asset;
                }

                return {

                  ...asset,

                  price,

                  high24h:
                    Number(ticker.h) ||
                    asset.high24h,

                  low24h:
                    Number(ticker.l) ||
                    asset.low24h,

                  change24h:
                    ticker.P !== undefined
                      ? Number(ticker.P)
                      : asset.change24h,

                  volume24h:
                    ticker.q !== undefined
                      ? Number(ticker.q)
                      : asset.volume24h,

                  updatedAt: Date.now()

                };

              })
            );

          } catch (error) {

            console.error(
              'Market data parsing error:',
              error
            );

          }

        };

        socket.onerror = () => {

          setConnectionStatus('RECONNECTING');

          socket?.close();

        };

        socket.onclose = () => {

          if (stopped) return;

          setConnectionStatus('RECONNECTING');

          const delay = reconnectDelay;

          reconnectDelay = Math.min(
            reconnectDelay * 2,
            15000
          );

          reconnectTimer = setTimeout(
            connect,
            delay
          );

        };

      } catch (error) {

        console.error(
          'Market WebSocket error:',
          error
        );

        setConnectionStatus('OFFLINE');

        const delay = reconnectDelay;

        reconnectDelay = Math.min(
          reconnectDelay * 2,
          15000
        );

        reconnectTimer = setTimeout(
          connect,
          delay
        );

      }

    }

    connect();

    return () => {

      stopped = true;

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }

      socket?.close();

    };

  }, []);

  // ====================================================
  // TECHNICAL SCANNER
  // ====================================================

  const runTechnicalScanner = useCallback(async () => {

    if (!scannerRunning) return;

    // Do not allow overlapping scans.

    if (scannerBusyRef.current) return;

    scannerBusyRef.current = true;

    setScannerLoading(true);

    setScanError('');

    try {

      const symbols = [
        'BTCUSDT',
        'ETHUSDT',
        'SOLUSDT',
        'BNBUSDT',
        'XRPUSDT',
        'DOGEUSDT'
      ];

      // ----------------------------------------------
      // FETCH CANDLES
      // ----------------------------------------------

      const results = await Promise.all(
        symbols.map(async symbol => {

          try {

            const candles = await fetchBinanceKlines(
              symbol,
              '15m',
              100
            );

            const closes = candles.map(
              candle => Number(candle[4])
            );

            if (closes.length < 25) {
              return null;
            }

            const rsi = calculateRSI(closes);

            const ema9 = calculateEMA(closes, 9);

            const ema21 = calculateEMA(closes, 21);

            if (
              rsi === null ||
              ema9 === null ||
              ema21 === null
            ) {
              return null;
            }

            return {

              symbol,

              rsi,

              ema9,

              ema21

            };

          } catch (error) {

            console.warn(
              `Scanner error ${symbol}:`,
              error
            );

            return null;

          }

        })
      );

      const validResults = results.filter(
        (
          item
        ): item is NonNullable<typeof item> =>
          item !== null
      );

      if (validResults.length === 0) {

        setScanError(
          'No candle data returned. Check Binance market connectivity.'
        );

        return;

      }

      const resultMap = new Map(
        validResults.map(result => [
          result.symbol,
          result
        ])
      );

      // ----------------------------------------------
      // UPDATE USING LATEST ASSET STATE
      // ----------------------------------------------

      setAssets(previous =>
        previous.map(asset => {

          const result = resultMap.get(
            asset.symbol
          );

          if (!result) return asset;

          const signal = calculateSignal(
            result.ema9,
            result.ema21,
            result.rsi,
            asset.change24h
          );

          return {

            ...asset,

            rsi: result.rsi,

            ema9: result.ema9,

            ema21: result.ema21,

            signal

          };

        })
      );

    } catch (error: any) {

      setScanError(
        error?.message ||
        'Technical scanner failed.'
      );

    } finally {

      scannerBusyRef.current = false;

      setScannerLoading(false);

    }

  // No assets dependency.
  // Latest price changes are read inside setAssets.

  }, [scannerRunning]);

  // ====================================================
  // AUTOMATIC SCANNER TIMER
  // ====================================================

  useEffect(() => {

    if (!scannerRunning) return;

    void runTechnicalScanner();

    const timer = setInterval(() => {

      void runTechnicalScanner();

    }, 60000);

    return () => {

      clearInterval(timer);

    };

  }, [scannerRunning, runTechnicalScanner]);

  // ====================================================
  // FILTER MARKETS
  // ====================================================

  const filteredAssets = useMemo(() => {

    const query = search.toLowerCase();

    return assets.filter(asset =>

      asset.symbol.toLowerCase().includes(query) ||

      asset.name.toLowerCase().includes(query)

    );

  }, [assets, search]);

  const selectedAsset = useMemo(

    () => assets.find(
      item => item.symbol === selectedSymbol
    ),

    [assets, selectedSymbol]

  );

  const buySignals = assets.filter(
    asset => asset.signal === 'BUY'
  ).length;

  const sellSignals = assets.filter(
    asset => asset.signal === 'SELL'
  ).length;

  const liveMarketCount = assets.filter(
    asset => asset.price > 0
  ).length;

  // ====================================================
  // BINANCE CONNECTION CHANGE
  // ====================================================

  const handleConnectionChange = useCallback(
    (state: BinanceConnectionState) => {

      setIsBinanceConnected(state.connected);

      setTradingMode(
        state.connected
          ? 'BINANCE_DEMO'
          : 'PAPER'
      );

      if (state.connected) {

        setAccount(previous => ({

          ...previous,

          walletBalance: undefined

        } as any));

        applyAccountData({

          totalWalletBalance:
            state.walletBalance ??
            '0',

          availableBalance:
            state.availableBalance ??
            '0',

          totalUnrealizedProfit:
            account.totalUnrealizedProfit,

          canTrade: Boolean(state.canTrade)

        });

        pushAlert(
          'Binance API KEY ACTIVE. Futures Demo authentication successful.'
        );

      } else {

        setAccount(EMPTY_ACCOUNT);

        setPositions([]);

        setOpenOrders([]);

        pushAlert(
          'Binance API disconnected. Paper mode selected.'
        );

      }

      // Re-read authoritative server session status.

      void loadServerConfig();

    },
    [
      account.totalUnrealizedProfit,
      applyAccountData,
      loadServerConfig,
      pushAlert
    ]
  );

  // ====================================================
  // REFRESH ACCOUNT DATA
  // ====================================================

  const refreshAccount = async () => {

    if (!isBinanceConnected) {

      setAccountError(
        'Connect your Binance Futures Demo API first.'
      );

      return;

    }

    setAccountLoading(true);

    setAccountError('');

    try {

      const [
        accountData,
        positionData,
        orderData
      ] = await Promise.all([

        getBinanceAccount(),

        getBinancePositions(),

        getBinanceOpenOrders()

      ]);

      applyAccountData(accountData);

      setPositions(
        positionData.positions || []
      );

      setOpenOrders(
        orderData.orders || []
      );

      pushAlert(
        'Binance Demo account balances and positions refreshed.'
      );

    } catch (error: any) {

      setAccountError(
        error?.message ||
        'Account refresh failed.'
      );

      pushAlert(
        'Binance account refresh failed.'
      );

    } finally {

      setAccountLoading(false);

    }

  };

  // ====================================================
  // VALIDATE ORDER
  // ====================================================

  const validateOrder = async () => {

    const amount = Number(quantityUsd);

    const selectedLeverage = Number(leverage);

    const maxOrder =
      serverConfig?.maxOrderUsd ?? 1000;

    const maxLeverage =
      serverConfig?.maxLeverage ?? 10;

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > maxOrder
    ) {

      setOrderMessage(
        `Order amount must be between $0 and $${maxOrder}.`
      );

      return;

    }

    if (
      !Number.isInteger(selectedLeverage) ||
      selectedLeverage < 1 ||
      selectedLeverage > maxLeverage
    ) {

      setOrderMessage(
        `Leverage must be between 1 and ${maxLeverage}x.`
      );

      return;

    }

    setOrderLoading(true);

    setOrderMessage('');

    try {

      if (tradingMode === 'PAPER') {

        setOrderMessage(
          'Paper order validation successful. No Binance order was sent.'
        );

        return;

      }

      if (!isBinanceConnected) {

        throw new Error(
          'Binance API is not connected.'
        );

      }

      const result = await validateBinanceOrder({

        symbol: selectedSymbol,

        side: orderSide,

        quantityUsd: amount,

        leverage: selectedLeverage

      });

      setOrderMessage(
        result.message ||
        'Binance Demo test order accepted. No order was executed.'
      );

    } catch (error: any) {

      setOrderMessage(
        error?.message ||
        'Order validation failed.'
      );

    } finally {

      setOrderLoading(false);

    }

  };

  // ====================================================
  // PLACE PAPER OR DEMO ORDER
  // ====================================================

  const placeOrder = async () => {

    const amount = Number(quantityUsd);

    const selectedLeverage = Number(leverage);

    const maxOrder =
      serverConfig?.maxOrderUsd ?? 1000;

    const maxLeverage =
      serverConfig?.maxLeverage ?? 10;

    if (
      !Number.isFinite(amount) ||
      amount <= 0 ||
      amount > maxOrder
    ) {

      setOrderMessage(
        `Enter an order amount between $0 and $${maxOrder}.`
      );

      return;

    }

    if (
      !Number.isInteger(selectedLeverage) ||
      selectedLeverage < 1 ||
      selectedLeverage > maxLeverage
    ) {

      setOrderMessage(
        `Leverage must be between 1 and ${maxLeverage}x.`
      );

      return;

    }

    // --------------------------------------------------
    // PAPER MODE
    // --------------------------------------------------

    if (tradingMode === 'PAPER') {

      const trade: PaperOrder = {

        id: Date.now(),

        symbol: selectedSymbol,

        side: orderSide,

        quantityUsd: amount,

        leverage: selectedLeverage,

        price: selectedAsset?.price || 0,

        createdAt: new Date().toLocaleString(),

        status: 'PAPER_SIMULATION'

      };

      setPaperOrders(previous => [
        trade,
        ...previous
      ]);

      setOrderMessage(
        'Paper simulation created successfully. No Binance order was executed.'
      );

      pushAlert(
        `Paper ${orderSide}: ${selectedSymbol}, ${amount} USDT`
      );

      return;

    }

    // --------------------------------------------------
    // BINANCE DEMO MODE
    // --------------------------------------------------

    if (!isBinanceConnected) {

      setOrderMessage(
        'Binance Demo API is not connected.'
      );

      return;

    }

    const confirmed = window.confirm(

      `Submit Binance Futures DEMO ${orderSide} MARKET order?\n\n` +

      `Symbol: ${selectedSymbol}\n` +

      `Notional: ${amount} USDT\n` +

      `Leverage: ${selectedLeverage}x\n\n` +

      'This submits an actual order to your Demo account.'

    );

    if (!confirmed) return;

    setOrderLoading(true);

    setOrderMessage('');

    try {

      const result = await executeBinanceOrder({

        symbol: selectedSymbol,

        side: orderSide,

        quantityUsd: amount,

        leverage: selectedLeverage

      });

      setOrderMessage(

        `${result.message} Order ID: ${result.orderId || 'N/A'}`

      );

      pushAlert(
        `Binance Demo order submitted: ${orderSide} ${selectedSymbol}.`
      );

      await refreshAccount();

    } catch (error: any) {

      setOrderMessage(
        error?.message ||
        'Binance Demo order failed.'
      );

      pushAlert(
        `Order failed: ${error?.message || 'Unknown error'}`
      );

    } finally {

      setOrderLoading(false);

    }

  };

  // ====================================================
  // UI STATUS
  // ====================================================

  const marketStatusColor =
    connectionStatus === 'LIVE'
      ? 'text-emerald-400'
      : connectionStatus === 'OFFLINE'
        ? 'text-rose-400'
        : 'text-amber-400';

  const marketStatusDot =
    connectionStatus === 'LIVE'
      ? 'bg-emerald-400'
      : connectionStatus === 'OFFLINE'
        ? 'bg-rose-400'
        : 'bg-amber-400';

  // ====================================================
  // DASHBOARD
  // ====================================================

  return (

    <div className="
      min-h-screen bg-[#080d18]
      text-slate-200 font-mono
    ">

      {/* ==================================================
          HEADER
      ================================================== */}

      <header className="
        sticky top-0 z-30
        bg-[#101725]/95
        backdrop-blur-xl
        border-b border-slate-800
      ">

        <div className="
          max-w-[1600px] mx-auto
          px-4 lg:px-8 py-4
          flex flex-wrap items-center
          justify-between gap-4
        ">

          <div className="flex items-center gap-3">

            <div className="
              w-11 h-11 rounded-xl
              bg-gradient-to-br from-amber-400 to-orange-600
              flex items-center justify-center
              text-black font-black text-xl
            ">
              T
            </div>

            <div>

              <h1 className="
                text-xl font-black text-white
              ">

                TURBOSCALP

                <span className="
                  ml-2 text-amber-400 text-xs
                ">
                  AI
                </span>

              </h1>

              <p className="
                text-[10px] tracking-[0.2em]
                text-slate-500
              ">
                REAL-TIME MARKET SCANNER
              </p>

            </div>

          </div>

          <div className="
            flex flex-wrap items-center gap-2
          ">

            {/* MARKET STATUS */}

            <div className="
              flex items-center gap-2
              bg-slate-900 px-3 py-2
              rounded-lg border border-slate-800
            ">

              <span className={`
                w-2 h-2 rounded-full
                ${marketStatusDot}
                ${connectionStatus === 'LIVE'
                  ? 'animate-pulse'
                  : ''}
              `}/>

              <span className={`
                text-[9px] font-bold
                ${marketStatusColor}
              `}>

                {connectionStatus === 'LIVE'
                  ? 'MARKET LIVE'
                  : connectionStatus === 'OFFLINE'
                    ? 'MARKET OFFLINE'
                    : 'MARKET CONNECTING'
                }

              </span>

            </div>

            {/* API KEY STATUS */}

            <div className={`
              flex items-center gap-2
              px-3 py-2 rounded-lg border
              ${
                isBinanceConnected
                  ? 'bg-emerald-950/40 border-emerald-500/30'
                  : 'bg-slate-900 border-slate-800'
              }
            `}>

              <span className={`
                w-2 h-2 rounded-full
                ${
                  isBinanceConnected
                    ? 'bg-emerald-400'
                    : 'bg-rose-400'
                }
              `}/>

              <span className={`
                text-[9px] font-bold
                ${
                  isBinanceConnected
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }
              `}>

                {isBinanceConnected
                  ? 'API KEY ACTIVE'
                  : 'API KEY INACTIVE'
                }

              </span>

            </div>

            {/* MODE */}

            <div className="
              bg-slate-900 border border-slate-800
              rounded-lg px-3 py-2 text-[9px]
            ">

              <span className="text-slate-500">
                MODE:
              </span>

              <span className="
                ml-2 font-bold text-amber-400
              ">

                {tradingMode === 'BINANCE_DEMO'
                  ? 'FUTURES DEMO'
                  : 'PAPER'
                }

              </span>

            </div>

            <button
              onClick={() => setShowSettings(true)}
              className="
                bg-amber-400 hover:bg-amber-300
                text-black font-bold
                rounded-lg px-4 py-2 text-xs
              "
            >
              API SETTINGS
            </button>

          </div>

        </div>

      </header>

      <main className="
        max-w-[1600px] mx-auto
        px-4 lg:px-8 py-6 space-y-6
      ">

        <QuantAIEngine />

        {/* ==================================================
            ENVIRONMENT NOTICE
        ================================================== */}

        <div className="
          border border-amber-500/30
          bg-amber-500/5
          rounded-xl p-3 flex items-start gap-3
        ">

          <span className="text-amber-400 text-lg">
            ⚠
          </span>

          <div>

            <p className="
              text-xs font-bold text-amber-300
            ">
              DEMO TRADING ENVIRONMENT
            </p>

            <p className="
              text-[10px] text-slate-400
              mt-1 leading-relaxed
            ">

              Binance USD-M Futures Demo only.
              Live trading is disabled. Technical signals
              are indicators and are not guaranteed predictions.

            </p>

          </div>

        </div>

        {/* ==================================================
            BALANCE SUMMARY
        ================================================== */}

        {isBinanceConnected && (

          <section className="
            bg-[#111a29]
            border border-emerald-500/30
            rounded-2xl p-5
          ">

            <div className="
              flex flex-wrap justify-between
              items-center gap-3
            ">

              <div>

                <div className="
                  flex items-center gap-2
                ">

                  <h2 className="
                    text-xs font-black text-white
                  ">
                    BINANCE FUTURES DEMO ACCOUNT
                  </h2>

                  <span className="
                    px-2 py-1 rounded-md
                    bg-emerald-500/10
                    border border-emerald-500/30
                    text-emerald-400 text-[9px] font-bold
                  ">
                    API KEY ACTIVE
                  </span>

                </div>

                <p className="
                  text-[10px] text-slate-500 mt-2
                ">
                  Authenticated account balance
                </p>

              </div>

              <button
                onClick={() => void refreshAccount()}
                disabled={accountLoading}
                className="
                  px-3 py-2 rounded-lg
                  bg-emerald-500/10
                  border border-emerald-500/30
                  text-emerald-400 text-[10px] font-bold
                  disabled:opacity-50
                "
              >
                {accountLoading
                  ? 'REFRESHING...'
                  : 'REFRESH BALANCE ↻'
                }
              </button>

            </div>

            <div className="
              grid grid-cols-1 sm:grid-cols-2
              lg:grid-cols-3 gap-3 mt-5
            ">

              <MetricCard
                title="WALLET BALANCE"
                value={formatMoney(
                  Number(account.totalWalletBalance)
                )}
                subtitle="Futures wallet USDT"
                color="text-emerald-400"
              />

              <MetricCard
                title="AVAILABLE BALANCE"
                value={formatMoney(
                  Number(account.availableBalance)
                )}
                subtitle="Available USDT for margin"
                color="text-cyan-400"
              />

              <MetricCard
                title="UNREALIZED PNL"
                value={formatMoney(
                  Number(account.totalUnrealizedProfit)
                )}
                subtitle="Open position PNL"
                color={
                  Number(account.totalUnrealizedProfit) >= 0
                    ? 'text-emerald-400'
                    : 'text-rose-400'
                }
              />

            </div>

            <div className="
              flex flex-wrap justify-between
              items-center gap-2 mt-4
              border-t border-slate-800 pt-3
            ">

              <span className="
                text-[10px] text-slate-400
              ">
                Futures trading permission
              </span>

              <span className={`
                text-[10px] font-bold
                ${
                  account.canTrade
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }
              `}>
                {account.canTrade
                  ? 'ENABLED'
                  : 'DISABLED / NOT CONFIRMED'
                }
              </span>

            </div>

            {accountError && (

              <p className="
                text-[10px] text-rose-400 mt-3
              ">
                {accountError}
              </p>

            )}

          </section>

        )}

        {/* ==================================================
            MAIN METRICS
        ================================================== */}

        <section className="
          grid grid-cols-2 lg:grid-cols-4 gap-3
        ">

          <MetricCard
            title="MARKETS TRACKED"
            value={`${liveMarketCount}/${assets.length}`}
            subtitle="Receiving market prices"
            color="text-cyan-400"
          />

          <MetricCard
            title="BUY SIGNALS"
            value={String(buySignals)}
            subtitle="EMA / RSI heuristic"
            color="text-emerald-400"
          />

          <MetricCard
            title="SELL SIGNALS"
            value={String(sellSignals)}
            subtitle="EMA / RSI heuristic"
            color="text-rose-400"
          />

          <MetricCard
            title="SCANNER STATUS"
            value={scannerRunning ? 'ACTIVE' : 'PAUSED'}
            subtitle="15-minute candle analysis"
            color={
              scannerRunning
                ? 'text-emerald-400'
                : 'text-amber-400'
            }
          />

        </section>

        {/* ==================================================
            MARKET SCANNER AND TRADE TERMINAL
        ================================================== */}

        <section className="
          grid grid-cols-1 xl:grid-cols-3 gap-5
        ">

          {/* MARKET SCANNER */}

          <div className="
            xl:col-span-2
            bg-[#111a29]
            border border-slate-800
            rounded-2xl overflow-hidden
          ">

            <div className="
              p-5 border-b border-slate-800
              flex flex-wrap justify-between
              items-center gap-3
            ">

              <div>

                <h2 className="
                  text-sm font-black text-white
                ">
                  MARKET SCANNER
                </h2>

                <p className="
                  text-[10px] text-slate-500 mt-1
                ">
                  Binance Futures Demo market feed
                </p>

              </div>

              <button
                onClick={() =>
                  setScannerRunning(value => !value)
                }
                className={`
                  px-3 py-2 rounded-lg
                  text-[10px] font-bold
                  ${
                    scannerRunning
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30'
                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/30'
                  }
                `}
              >

                {scannerRunning
                  ? 'PAUSE SCANNER'
                  : 'START SCANNER'
                }

              </button>

            </div>

            {/* SEARCH */}

            <div className="
              p-4 border-b border-slate-800
            ">

              <input
                value={search}
                onChange={event =>
                  setSearch(event.target.value)
                }
                placeholder="Search BTC, ETH, SOL..."
                className="
                  w-full bg-[#080d18]
                  border border-slate-700
                  rounded-lg px-4 py-3
                  text-xs text-white outline-none
                  focus:border-amber-400
                "
              />

            </div>

            {/* MARKET TABLE */}

            <div className="overflow-x-auto">

              <table className="
                w-full text-left whitespace-nowrap
              ">

                <thead className="
                  bg-[#0c1320]
                  text-[9px] text-slate-500 uppercase
                ">

                  <tr>

                    <th className="p-4">Asset</th>

                    <th className="p-4">Price</th>

                    <th className="p-4">24H %</th>

                    <th className="p-4">Volume</th>

                    <th className="p-4">RSI</th>

                    <th className="p-4">Signal</th>

                  </tr>

                </thead>

                <tbody>

                  {filteredAssets.map(asset => (

                    <tr
                      key={asset.symbol}
                      onClick={() =>
                        setSelectedSymbol(asset.symbol)
                      }
                      className={`
                        cursor-pointer
                        border-b border-slate-800/70
                        hover:bg-slate-800/40
                        ${
                          selectedSymbol === asset.symbol
                            ? 'bg-amber-500/5'
                            : ''
                        }
                      `}
                    >

                      <td className="p-4">

                        <div className="
                          text-xs font-bold text-white
                        ">
                          {asset.symbol.replace('USDT', '')}
                        </div>

                        <div className="
                          text-[9px] text-slate-500 mt-1
                        ">
                          {asset.name}
                        </div>

                      </td>

                      <td className="
                        p-4 text-xs font-bold text-white
                      ">
                        {formatPrice(asset.price)}
                      </td>

                      <td className="
                        p-4 text-xs font-bold
                      ">

                        <span className={
                          asset.change24h >= 0
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }>

                          {asset.price > 0
                            ? `${asset.change24h >= 0 ? '+' : ''}${asset.change24h.toFixed(2)}%`
                            : '—'
                          }

                        </span>

                      </td>

                      <td className="
                        p-4 text-[10px] text-slate-400
                      ">
                        {asset.volume24h > 0
                          ? formatVolume(asset.volume24h)
                          : '—'
                        }
                      </td>

                      <td className="
                        p-4 text-xs text-slate-300
                      ">
                        {asset.rsi !== null
                          ? asset.rsi.toFixed(1)
                          : '—'
                        }
                      </td>

                      <td className="p-4">

                        <SignalBadge
                          signal={asset.signal}
                        />

                      </td>

                    </tr>

                  ))}

                </tbody>

              </table>

              {filteredAssets.length === 0 && (

                <div className="
                  text-center p-8
                  text-xs text-slate-500
                ">
                  No matching market found.
                </div>

              )}

            </div>

            {scanError && (

              <div className="
                px-4 py-3
                text-[10px] text-rose-400
                border-t border-slate-800
              ">
                {scanError}
              </div>

            )}

            <div className="
              p-4 border-t border-slate-800
              flex justify-between items-center
            ">

              <span className="
                text-[10px] text-slate-500
              ">
                Technical scan: every 60 seconds
              </span>

              <button
                onClick={() => void runTechnicalScanner()}
                disabled={scannerLoading}
                className="
                  text-[10px] text-amber-400
                  disabled:opacity-50
                "
              >

                {scannerLoading
                  ? 'SCANNING...'
                  : 'REFRESH SCAN ↻'
                }

              </button>

            </div>

          </div>

          {/* TRADE TERMINAL */}

          <div className="
            bg-[#111a29]
            border border-slate-800
            rounded-2xl p-5 space-y-5
          ">

            <div>

              <h2 className="
                text-sm font-black text-white
              ">
                TRADE TERMINAL
              </h2>

              <p className="
                text-[10px] text-slate-500 mt-1
              ">
                Manual Demo execution
              </p>

            </div>

            {/* MARKET */}

            <div className="
              rounded-xl bg-[#080d18]
              p-4 border border-slate-800
            ">

              <label className="
                block mb-3 text-[9px]
                text-slate-500
              ">
                SELECT MARKET
              </label>

              <select
                value={selectedSymbol}
                onChange={event => {
                  setSelectedSymbol(event.target.value);
                  setOrderMessage('');
                }}
                className="
                  w-full bg-slate-900
                  border border-slate-700
                  text-white text-xs rounded-lg
                  px-3 py-3 outline-none
                "
              >

                {assets.map(asset => (

                  <option
                    key={asset.symbol}
                    value={asset.symbol}
                  >
                    {asset.symbol}
                  </option>

                ))}

              </select>

              <div className="
                mt-3 flex justify-between
              ">

                <span className="
                  text-[10px] text-slate-500
                ">
                  MARKET PRICE
                </span>

                <span className="
                  font-bold text-white text-sm
                ">
                  {formatPrice(
                    selectedAsset?.price || 0
                  )}
                </span>

              </div>

            </div>

            {/* BUY / SELL */}

            <div className="
              grid grid-cols-2 gap-2
            ">

              <button
                onClick={() => {
                  setOrderSide('BUY');
                  setOrderMessage('');
                }}
                className={`
                  py-3 rounded-lg
                  text-xs font-black border
                  ${
                    orderSide === 'BUY'
                      ? 'bg-emerald-500 text-black border-emerald-400'
                      : 'bg-slate-900 text-slate-400 border-slate-700'
                  }
                `}
              >
                BUY / LONG
              </button>

              <button
                onClick={() => {
                  setOrderSide('SELL');
                  setOrderMessage('');
                }}
                className={`
                  py-3 rounded-lg
                  text-xs font-black border
                  ${
                    orderSide === 'SELL'
                      ? 'bg-rose-500 text-white border-rose-400'
                      : 'bg-slate-900 text-slate-400 border-slate-700'
                  }
                `}
              >
                SELL / SHORT
              </button>

            </div>

            {/* ORDER NOTIONAL */}

            <div>

              <label className="
                text-[10px] text-slate-500
                block mb-2
              ">
                ORDER NOTIONAL (USDT)
              </label>

              <input
                type="number"
                min="1"
                value={quantityUsd}
                onChange={event =>
                  setQuantityUsd(event.target.value)
                }
                className="
                  w-full p-3 rounded-lg
                  bg-[#080d18]
                  border border-slate-700
                  text-white text-sm
                  outline-none focus:border-amber-400
                "
              />

            </div>

            {/* LEVERAGE */}

            <div>

              <label className="
                text-[10px] text-slate-500
                block mb-2
              ">
                LEVERAGE
              </label>

              <select
                value={leverage}
                onChange={event =>
                  setLeverage(event.target.value)
                }
                className="
                  w-full p-3 rounded-lg
                  bg-[#080d18]
                  border border-slate-700
                  text-white text-xs
                "
              >

                {[1, 2, 3, 5, 10, 15, 20].map(value => (

                  <option
                    key={value}
                    value={value}
                  >
                    {value}x
                  </option>

                ))}

              </select>

            </div>

            {/* SUMMARY */}

            <div className="
              bg-[#080d18]
              border border-slate-800
              rounded-lg p-3 space-y-2
            ">

              <div className="
                flex justify-between text-[10px]
              ">

                <span className="text-slate-500">
                  Notional
                </span>

                <span className="text-white">
                  {formatMoney(Number(quantityUsd))}
                </span>

              </div>

              <div className="
                flex justify-between text-[10px]
              ">

                <span className="text-slate-500">
                  Approx. margin
                </span>

                <span className="text-amber-400">
                  {formatMoney(
                    Number(quantityUsd) /
                    Math.max(Number(leverage), 1)
                  )}
                </span>

              </div>

              <div className="
                flex justify-between text-[10px]
              ">

                <span className="text-slate-500">
                  Execution
                </span>

                <span className="text-emerald-400">
                  MARKET
                </span>

              </div>

            </div>

            {/* VALIDATE ORDER */}

            <button
              onClick={() => void validateOrder()}
              disabled={orderLoading}
              className="
                w-full py-3 rounded-lg
                border border-slate-600
                bg-slate-800 hover:bg-slate-700
                text-white text-xs font-bold
                disabled:opacity-50
              ">
              VALIDATE ORDER (NO EXECUTION)
            </button>

            {/* PLACE ORDER */}

            <button
              onClick={() => void placeOrder()}
              disabled={orderLoading}
              className={`
                w-full py-4 rounded-lg
                font-black text-xs
                disabled:opacity-50
                ${
                  orderSide === 'BUY'
                    ? 'bg-emerald-500 hover:bg-emerald-400 text-black'
                    : 'bg-rose-500 hover:bg-rose-400 text-white'
                }
              `}
            >

              {orderLoading
                ? 'PROCESSING...'
                : tradingMode === 'PAPER'
                  ? `SIMULATE ${orderSide} TRADE`
                  : `PLACE DEMO ${orderSide} ORDER`
              }

            </button>

            {orderMessage && (

              <div className="
                p-3 rounded-lg
                bg-slate-900
                border border-slate-700
                text-[10px] leading-relaxed
                text-slate-300
              ">
                {orderMessage}
              </div>

            )}

            <p className="
              text-[9px] text-slate-500 text-center
            ">
              Live trading is disabled.
            </p>

          </div>

        </section>

        {/* ==================================================
            ACCOUNT DETAILS
        ================================================== */}

        <section className="
          bg-[#111a29]
          border border-slate-800
          rounded-2xl overflow-hidden
        ">

          <div className="
            p-5 flex flex-wrap
            justify-between items-center gap-3
            border-b border-slate-800
          ">

            <div>

              <h2 className="
                text-sm font-black text-white
              ">
                BINANCE DEMO ACCOUNT DETAILS
              </h2>

              <p className="
                text-[10px] text-slate-500 mt-1
              ">
                Positions and open orders
              </p>

            </div>

            <button
              onClick={() => void refreshAccount()}
              disabled={
                accountLoading ||
                !isBinanceConnected
              }
              className="
                px-4 py-2 rounded-lg
                bg-amber-400 hover:bg-amber-300
                text-black text-[10px] font-black
                disabled:opacity-50
              "
            >

              {accountLoading
                ? 'LOADING...'
                : 'REFRESH ACCOUNT'
              }

            </button>

          </div>

          {accountError && (

            <div className="
              p-3 border-b border-slate-800
              text-[10px] text-rose-400
            ">
              {accountError}
            </div>

          )}

          <div className="
            grid grid-cols-1 lg:grid-cols-2
            border-t border-slate-800
          ">

            {/* POSITIONS */}

            <div className="
              p-5 lg:border-r border-slate-800
            ">

              <h3 className="
                text-xs font-bold text-white mb-4
              ">
                OPEN POSITIONS ({positions.length})
              </h3>

              {positions.length === 0 ? (

                <p className="
                  text-[10px] text-slate-500 py-5
                ">
                  No open positions loaded.
                </p>

              ) : (

                <div className="space-y-3">

                  {positions.map((position, index) => (

                    <div
                      key={`${position.symbol}-${index}`}
                      className="
                        p-3 bg-[#080d18]
                        border border-slate-800 rounded-lg
                      "
                    >

                      <div className="
                        flex justify-between
                      ">

                        <span className="
                          text-xs font-bold text-white
                        ">
                          {position.symbol}
                        </span>

                        <span className="
                          text-[10px] text-amber-400
                        ">
                          {position.leverage}x
                        </span>

                      </div>

                      <div className="
                        mt-3 grid grid-cols-2 gap-3
                      ">

                        <PositionValue
                          title="Position Size"
                          value={position.positionAmt}
                        />

                        <PositionValue
                          title="Entry Price"
                          value={formatPrice(
                            Number(position.entryPrice)
                          )}
                        />

                        <PositionValue
                          title="Mark Price"
                          value={formatPrice(
                            Number(position.markPrice)
                          )}
                        />

                        <PositionValue
                          title="Unrealized PNL"
                          value={formatMoney(
                            Number(position.unrealizedProfit)
                          )}
                        />

                      </div>

                    </div>

                  ))}

                </div>

              )}

            </div>

            {/* OPEN ORDERS */}

            <div className="p-5">

              <h3 className="
                text-xs font-bold text-white mb-4
              ">
                OPEN ORDERS ({openOrders.length})
              </h3>

              {openOrders.length === 0 ? (

                <p className="
                  text-[10px] text-slate-500 py-5
                ">
                  No open orders loaded.
                </p>

              ) : (

                <div className="space-y-2">

                  {openOrders.map((order: any) => (

                    <div
                      key={order.orderId}
                      className="
                        p-3 bg-[#080d18]
                        border border-slate-800
                        rounded-lg flex justify-between gap-3
                      "
                    >

                      <div>

                        <p className="
                          text-xs font-bold text-white
                        ">
                          {order.symbol}
                        </p>

                        <p className="
                          text-[10px] text-slate-500 mt-1
                        ">
                          {order.side} / {order.type}
                        </p>

                      </div>

                      <div className="text-right">

                        <p className="
                          text-[10px] text-amber-400
                        ">
                          {order.status}
                        </p>

                        <p className="
                          text-[10px] text-slate-400 mt-1
                        ">
                          ID: {order.orderId}
                        </p>

                      </div>

                    </div>

                  ))}

                </div>

              )}

            </div>

          </div>

        </section>

        {/* ==================================================
            PAPER TRADING HISTORY
        ================================================== */}

        <section className="
          bg-[#111a29]
          border border-slate-800
          rounded-2xl p-5
        ">

          <div className="
            flex justify-between items-center mb-4
          ">

            <h2 className="
              text-sm font-black text-white
            ">
              PAPER TRADING HISTORY
            </h2>

            <span className="
              text-[10px] text-slate-500
            ">
              {paperOrders.length} simulations
            </span>

          </div>

          {paperOrders.length === 0 ? (

            <p className="
              text-[10px] text-slate-500
            ">
              No paper trades yet.
            </p>

          ) : (

            <div className="overflow-x-auto">

              <table className="
                w-full text-left text-[10px]
              ">

                <thead className="
                  text-slate-500
                  border-b border-slate-800
                ">

                  <tr>

                    <th className="py-3 pr-4">Time</th>

                    <th className="py-3 pr-4">Symbol</th>

                    <th className="py-3 pr-4">Side</th>

                    <th className="py-3 pr-4">Notional</th>

                    <th className="py-3 pr-4">Leverage</th>

                    <th className="py-3">Status</th>

                  </tr>

                </thead>

                <tbody>

                  {paperOrders.map(order => (

                    <tr
                      key={order.id}
                      className="border-b border-slate-800/50"
                    >

                      <td className="
                        py-3 pr-4 text-slate-400
                      ">
                        {order.createdAt}
                      </td>

                      <td className="
                        py-3 pr-4 text-white font-bold
                      ">
                        {order.symbol}
                      </td>

                      <td className={`
                        py-3 pr-4 font-bold
                        ${
                          order.side === 'BUY'
                            ? 'text-emerald-400'
                            : 'text-rose-400'
                        }
                      `}>
                        {order.side}
                      </td>

                      <td className="
                        py-3 pr-4 text-white
                      ">
                        {formatMoney(order.quantityUsd)}
                      </td>

                      <td className="
                        py-3 pr-4 text-amber-400
                      ">
                        {order.leverage}x
                      </td>

                      <td className="
                        py-3 text-slate-400
                      ">
                        PAPER ONLY
                      </td>

                    </tr>

                  ))}

                </tbody>

              </table>

            </div>

          )}

        </section>

        {/* ==================================================
            SYSTEM ACTIVITY
        ================================================== */}

        <section className="
          bg-[#111a29]
          border border-slate-800
          rounded-2xl overflow-hidden
        ">

          <div className="
            p-5 border-b border-slate-800
          ">

            <h2 className="
              text-sm font-black text-white
            ">
              SYSTEM ACTIVITY
            </h2>

            <p className="
              text-[10px] text-slate-500 mt-1
            ">
              Market, API connection and trading events
            </p>

          </div>

          <div className="
            p-4 space-y-3
            max-h-64 overflow-y-auto
          ">

            {alerts.map((alert, index) => (

              <div
                key={`${alert}-${index}`}
                className="
                  text-[10px] text-slate-400
                  flex gap-3
                "
              >

                <span className="text-emerald-500">
                  ›
                </span>

                <span>
                  {alert}
                </span>

              </div>

            ))}

          </div>

        </section>

        {/* FOOTER */}

        <footer className="
          py-6 border-t border-slate-800
          flex flex-wrap justify-between gap-3
        ">

          <p className="
            text-[10px] text-slate-600
          ">
            TURBOSCALP AI · BINANCE DEMO
          </p>

          <p className="
            text-[10px] text-slate-600
          ">
            Live trading disabled
          </p>

        </footer>

      </main>

      {/* ==================================================
          API SETTINGS MODAL
      ================================================== */}

      <ApiSettingsModal

        isOpen={showSettings}

        onClose={() => setShowSettings(false)}

        connected={isBinanceConnected}

        walletBalance={
          Number(account.totalWalletBalance) || 0
        }

        availableBalance={
          Number(account.availableBalance) || 0
        }

        canTrade={account.canTrade}

        onConnectionChange={handleConnectionChange}

      />

    </div>

  );

}

// ======================================================
// METRIC CARD
// ======================================================

function MetricCard({
  title,
  value,
  subtitle,
  color
}: {
  title: string;
  value: string;
  subtitle: string;
  color: string;
}) {

  return (

    <div className="
      bg-[#111a29]
      border border-slate-800
      rounded-xl p-4 min-w-0
    ">

      <p className="
        text-[9px] text-slate-500 tracking-wider
      ">
        {title}
      </p>

      <p className={`
        text-xl sm:text-2xl
        font-black mt-3 ${color}
      `}>
        {value}
      </p>

      <p className="
        text-[9px] text-slate-500 mt-2
      ">
        {subtitle}
      </p>

    </div>

  );

}

// ======================================================
// SIGNAL BADGE
// ======================================================

function SignalBadge({
  signal
}: {
  signal: SignalType;
}) {

  const styles = {

    BUY:
      'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',

    SELL:
      'bg-rose-500/10 text-rose-400 border-rose-500/30',

    NEUTRAL:
      'bg-slate-800 text-slate-400 border-slate-700'

  };

  return (

    <span className={`
      inline-block px-2 py-1
      rounded-md text-[9px]
      font-bold border ${styles[signal]}
    `}>
      {signal}
    </span>

  );

}

// ======================================================
// POSITION VALUE
// ======================================================

function PositionValue({
  title,
  value
}: {
  title: string;
  value: string;
}) {

  return (

    <div>

      <p className="
        text-[9px] text-slate-500
      ">
        {title}
      </p>

      <p className="
        text-[11px] text-white mt-1 break-all
      ">
        {value}
      </p>

    </div>

  );

}