
import React, {
  useEffect,
  useState
} from 'react';

import {
  connectBinanceDemo,
  disconnectBinanceDemo,
  testBinanceConnection,
  getBinanceAccount,
  type BinanceConnectionState
} from '../services/binanceService';

interface Props {

  isOpen: boolean;

  onClose: () => void;

  connected: boolean;

  walletBalance: number;

  availableBalance: number;

  canTrade: boolean;

  onConnectionChange: (
    state: BinanceConnectionState
  ) => void;

}

// ======================================================
// COMPONENT
// ======================================================

export function ApiSettingsModal({

  isOpen,

  onClose,

  connected,

  walletBalance,

  availableBalance,

  canTrade,

  onConnectionChange

}: Props) {

  const [apiKey, setApiKey] = useState('');

  const [apiSecret, setApiSecret] = useState('');

  const [showSecret, setShowSecret] = useState(false);

  const [loading, setLoading] = useState(false);

  const [message, setMessage] = useState('');

  const [error, setError] = useState(false);

  const [showCredentialForm, setShowCredentialForm] =
    useState(!connected);

  const [verifiedAt, setVerifiedAt] = useState<string | null>(
    null
  );

  useEffect(() => {

    setShowCredentialForm(!connected);

  }, [connected]);

  useEffect(() => {

    if (!isOpen) {

      setApiKey('');
      setApiSecret('');
      setMessage('');
      setError(false);

    }

  }, [isOpen]);

  if (!isOpen) return null;

  // ====================================================
  // CONNECT BINANCE
  // ====================================================

  const handleConnect = async () => {

    if (!apiKey.trim() || !apiSecret.trim()) {

      setError(true);

      setMessage(
        'Please enter both Binance API Key and API Secret.'
      );

      return;

    }

    setLoading(true);
    setError(false);

    setMessage(
      'Authenticating with Binance Futures Demo...'
    );

    try {

      const result = await connectBinanceDemo(
        apiKey,
        apiSecret
      );

      const wallet = Number(
        result.walletBalance || 0
      );

      const available = Number(
        result.availableBalance || 0
      );

      // Tell the parent dashboard immediately.

      onConnectionChange({

        connected: true,

        walletBalance: wallet,

        availableBalance: available,

        canTrade: Boolean(result.canTrade)

      });

      // Do not keep the credentials in React state.

      setApiKey('');
      setApiSecret('');

      setShowCredentialForm(false);

      setVerifiedAt(
        new Date().toLocaleString()
      );

      setMessage(
        'Binance Futures Demo authentication successful.'
      );

      setError(false);

    } catch (err: any) {

      setError(true);

      setMessage(
        err?.message ||
        'Binance API authentication failed.'
      );

    } finally {

      setLoading(false);

    }

  };

  // ====================================================
  // TEST EXISTING API CONNECTION
  // ====================================================

  const handleTest = async () => {

    setLoading(true);

    setError(false);

    setMessage(
      'Checking Binance API authentication...'
    );

    try {

      const verification =
        await testBinanceConnection();

      const account = await getBinanceAccount();

      const wallet = Number(
        account.totalWalletBalance || 0
      );

      const available = Number(
        account.availableBalance || 0
      );

      onConnectionChange({

        connected: true,

        walletBalance: wallet,

        availableBalance: available,

        canTrade: Boolean(
          account.canTrade ?? verification.canTrade
        )

      });

      setVerifiedAt(
        new Date().toLocaleString()
      );

      setMessage(
        'API KEY ACTIVE. Authentication and account balance verified successfully.'
      );

      setError(false);

    } catch (err: any) {

      setError(true);

      setMessage(
        err?.message ||
        'API verification failed. Reconnect your Binance account.'
      );

      if (
        err?.message?.toLowerCase().includes('session') ||
        err?.message?.includes('401')
      ) {

        onConnectionChange({
          connected: false
        });

      }

    } finally {

      setLoading(false);

    }

  };

  // ====================================================
  // DISCONNECT
  // ====================================================

  const handleDisconnect = async () => {

    setLoading(true);

    try {

      await disconnectBinanceDemo();

      setApiKey('');
      setApiSecret('');

      setVerifiedAt(null);

      setMessage(
        'Binance API disconnected successfully.'
      );

      setError(false);

      onConnectionChange({
        connected: false
      });

      setShowCredentialForm(true);

    } catch (err: any) {

      setError(true);

      setMessage(
        err?.message ||
        'Could not disconnect Binance.'
      );

    } finally {

      setLoading(false);

    }

  };

  // ====================================================
  // PAPER MODE
  // ====================================================

  const handlePaperMode = async () => {

    setLoading(true);

    try {

      if (connected) {
        await disconnectBinanceDemo();
      }

      setApiKey('');
      setApiSecret('');

      setVerifiedAt(null);

      onConnectionChange({
        connected: false
      });

      setMessage(
        'Paper simulation mode selected.'
      );

      setError(false);

      setShowCredentialForm(false);

    } catch (err: any) {

      setError(true);

      setMessage(
        err?.message ||
        'Could not change trading mode.'
      );

    } finally {

      setLoading(false);

    }

  };

  // ====================================================
  // RENDER
  // ====================================================

  return (

    <div className="
      fixed inset-0 z-50
      bg-black/80 backdrop-blur-sm
      flex items-center justify-center
      p-4
    ">

      <div className="
        bg-[#131822]
        border border-slate-800
        rounded-2xl
        max-w-lg w-full
        p-6 space-y-5
        shadow-2xl
        font-mono text-slate-100
        max-h-[90vh] overflow-y-auto
      ">

        {/* HEADER */}

        <div className="
          flex items-center justify-between
          border-b border-slate-800 pb-4
        ">

          <div>

            <h3 className="
              text-base font-black text-white
            ">
              BINANCE API SETTINGS
            </h3>

            <p className="
              text-[10px] text-slate-500 mt-1
            ">
              USD-M Futures Demo Connector
            </p>

          </div>

          <button
            onClick={onClose}
            className="
              text-slate-400 hover:text-white
            "
          >
            ✕
          </button>

        </div>

        {/* ACTIVE API INDICATOR */}

        <div className={`
          p-4 rounded-xl border
          ${
            connected
              ? 'bg-emerald-950/40 border-emerald-500/40'
              : 'bg-slate-900 border-slate-700'
          }
        `}>

          <div className="
            flex items-center justify-between
            gap-3
          ">

            <div>

              <p className="
                text-[10px] text-slate-400
              ">
                API CONNECTION STATUS
              </p>

              <h3 className={`
                text-sm font-black mt-2
                ${
                  connected
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }
              `}>

                {connected
                  ? 'API KEY ACTIVE'
                  : 'API KEY INACTIVE'
                }

              </h3>

            </div>

            <div className={`
              px-3 py-2 rounded-lg
              text-[10px] font-black
              ${
                connected
                  ? 'bg-emerald-500 text-black'
                  : 'bg-slate-800 text-slate-400'
              }
            `}>

              {connected ? 'VERIFIED' : 'NOT CONNECTED'}

            </div>

          </div>

          {connected && (

            <div className="
              mt-3 pt-3 border-t
              border-emerald-500/20
              flex justify-between items-center
            ">

              <span className="
                text-[10px] text-slate-400
              ">
                Session status
              </span>

              <span className="
                text-[10px] text-emerald-400
              ">
                Authenticated
              </span>

            </div>

          )}

        </div>

        {/* BALANCE DISPLAY */}

        {connected && (

          <div className="
            bg-[#080d18]
            border border-emerald-500/30
            rounded-xl p-4 space-y-3
          ">

            <div>

              <p className="
                text-[10px] text-slate-400
              ">
                FUTURES WALLET BALANCE
              </p>

              <h2 className="
                text-2xl font-black
                text-emerald-400 mt-2
                break-all
              ">

                {walletBalance.toLocaleString(
                  'en-US',
                  {
                    minimumFractionDigits: 4,
                    maximumFractionDigits: 4
                  }
                )}

                <span className="
                  text-sm ml-2 text-slate-400
                ">
                  USDT
                </span>

              </h2>

            </div>

            <div className="
              flex justify-between items-center
              border-t border-slate-800 pt-3
            ">

              <span className="
                text-[10px] text-slate-400
              ">
                Available USDT
              </span>

              <span className="
                text-xs font-bold text-white
              ">

                {availableBalance.toLocaleString(
                  'en-US',
                  {
                    minimumFractionDigits: 4,
                    maximumFractionDigits: 4
                  }
                )}

                {' USDT'}

              </span>

            </div>

            <div className="
              flex justify-between items-center
            ">

              <span className="
                text-[10px] text-slate-400
              ">
                Futures trading permission
              </span>

              <span className={`
                text-[10px] font-bold
                ${
                  canTrade
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }
              `}>

                {canTrade ? 'ENABLED' : 'DISABLED'}

              </span>

            </div>

            {verifiedAt && (

              <p className="
                text-[9px] text-slate-500
                border-t border-slate-800 pt-2
              ">

                Last verified: {verifiedAt}

              </p>

            )}

          </div>

        )}

        {/* API CREDENTIAL INPUTS */}

        {showCredentialForm && (

          <div className="
            bg-slate-950
            border border-slate-800
            rounded-xl p-4 space-y-4
          ">

            <h4 className="
              text-xs font-bold text-white
            ">
              MANUAL API CREDENTIAL ENTRY
            </h4>

            <p className="
              text-[10px] text-slate-400
              leading-relaxed
            ">

              Enter your Binance Futures Demo API
              Key and Secret. The backend authenticates
              them and retains the credentials in an
              HttpOnly server-side session.

            </p>

            {/* API KEY */}

            <div>

              <label className="
                block text-[10px]
                text-slate-400 mb-2
              ">
                BINANCE API KEY
              </label>

              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                onChange={event =>
                  setApiKey(event.target.value)
                }
                placeholder="Enter API Key"
                className="
                  w-full bg-[#080d18]
                  border border-slate-700
                  rounded-lg px-3 py-3
                  text-xs text-white
                  outline-none focus:border-amber-400
                "
              />

            </div>

            {/* API SECRET */}

            <div>

              <label className="
                block text-[10px]
                text-slate-400 mb-2
              ">
                BINANCE API SECRET
              </label>

              <div className="relative">

                <input
                  type={showSecret ? 'text' : 'password'}
                  autoComplete="new-password"
                  spellCheck={false}
                  value={apiSecret}
                  onChange={event =>
                    setApiSecret(event.target.value)
                  }
                  placeholder="Enter API Secret"
                  className="
                    w-full bg-[#080d18]
                    border border-slate-700
                    rounded-lg px-3 py-3 pr-16
                    text-xs text-white
                    outline-none focus:border-amber-400
                  "
                />

                <button
                  type="button"
                  onClick={() =>
                    setShowSecret(value => !value)
                  }
                  className="
                    absolute right-3 top-1/2
                    -translate-y-1/2
                    text-[9px] text-amber-400
                  "
                >

                  {showSecret ? 'HIDE' : 'SHOW'}

                </button>

              </div>

            </div>

            <button
              onClick={handleConnect}
              disabled={loading}
              className="
                w-full p-4 rounded-xl
                bg-amber-400 hover:bg-amber-300
                text-black text-xs font-black
                disabled:opacity-50
              "
            >

              {loading
                ? 'VERIFYING API...'
                : 'TEST & CONNECT BINANCE'
              }

            </button>

          </div>

        )}

        {/* CHANGE API */}

        {connected && !showCredentialForm && (

          <button
            onClick={() => {
              setShowCredentialForm(true);
              setMessage('');
              setApiKey('');
              setApiSecret('');
            }}
            className="
              w-full p-3 rounded-xl
              bg-slate-900
              border border-slate-700
              text-slate-300 text-xs font-bold
            "
          >

            CHANGE API CREDENTIALS

          </button>

        )}

        {/* RESULT MESSAGE */}

        {message && (

          <div className={`
            p-3 rounded-xl
            text-[10px] leading-relaxed border
            ${
              error
                ? 'bg-rose-950/40 border-rose-500/30 text-rose-300'
                : 'bg-emerald-950/40 border-emerald-500/30 text-emerald-300'
            }
          `}>

            {message}

          </div>

        )}

        {/* TEST ACTIVE CONNECTION */}

        {connected && (

          <button
            onClick={handleTest}
            disabled={loading}
            className="
              w-full p-3 rounded-xl
              bg-slate-800 hover:bg-slate-700
              border border-slate-700
              text-white text-xs font-bold
              disabled:opacity-50
            "
          >

            {loading
              ? 'CHECKING...'
              : 'RECHECK API & UPDATE BALANCE'
            }

          </button>

        )}

        {/* DISCONNECT */}

        {connected && (

          <button
            onClick={handleDisconnect}
            disabled={loading}
            className="
              w-full p-3 rounded-xl
              bg-rose-950/40
              border border-rose-500/30
              text-rose-300 text-xs font-bold
              disabled:opacity-50
            "
          >

            DISCONNECT BINANCE API

          </button>

        )}

        {/* PAPER MODE */}

        <button
          onClick={handlePaperMode}
          disabled={loading}
          className="
            w-full p-3 rounded-xl
            bg-slate-800 hover:bg-slate-700
            border border-slate-700
            text-white text-xs font-bold
            disabled:opacity-50
          "
        >

          USE PAPER SIMULATION

        </button>

        {/* SECURITY */}

        <p className="
          text-[10px] text-slate-500
          leading-relaxed
        ">

          Use Futures Demo credentials only.
          Credentials are not stored in localStorage
          and are never displayed again after connection.
          The server session expires after two hours
          or when the server restarts.

        </p>

      </div>

    </div>

  );

}
