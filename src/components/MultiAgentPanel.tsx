import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Brain,
  CheckCircle2,
  Cpu,
  Pause,
  Play,
  Radar,
  RefreshCw,
  RotateCcw,
  ShieldAlert,
  ShieldCheck,
  Square,
  TrendingDown,
  TrendingUp,
  X,
} from 'lucide-react';
import {
  fetchAgentLogs,
  fetchAgentStatus,
  pauseAgentTrading,
  recheckGeminiAi,
  resumeAgentEngine,
  startAgentEngine,
  stopAgentNewTrades,
  updateAgentConfig,
  type AgentLogEntry,
  type AgentStatusResponse,
  type OpportunitySnapshot,
} from '../services/agentService';
import type { FuturesPermissionDiagnostics } from '../services/binanceService';
import {
  analyzeWithOllama,
  getOllamaStatus,
  OllamaApiError,
  type OllamaAnalysisResponse,
  type OllamaQuantInput,
  type OllamaStatus,
} from '../services/ollamaService';
import { PermissionDiagnosticsCard } from './PermissionDiagnosticsCard';

interface MultiAgentPanelProps {
  apiConnected: boolean;
  canTrade: boolean;
  availableBalance: string;
  exchangePositions: any[];
  openOrders: any[];
  permissionDiagnostics: FuturesPermissionDiagnostics | null;
  checkingPermission: boolean;
  onCheckPermission: () => Promise<void>;
  onOpenApiSettings: () => void;
  onRefreshAccount: () => Promise<void>;
}

function fmtUsd(value: unknown, digits = 2): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function fmtPrice(value: unknown): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return n < 1
    ? `$${n.toPrecision(6)}`
    : `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })}`;
}

function fmtTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleTimeString();
}

function agentStateStyle(state: string): string {
  switch (state) {
    case 'ACTIVE':
      return 'text-emerald-400';
    case 'FALLBACK_ACTIVE':
    case 'RECOVERING':
      return 'text-cyan-300';
    case 'STANDBY':
      return 'text-slate-300';
    case 'PAUSED':
      return 'text-amber-300';
    case 'OVERLOADED':
    case 'DEGRADED':
      return 'text-amber-400';
    case 'QUOTA_EXHAUSTED':
    case 'ERROR':
      return 'text-rose-400';
    default:
      return 'text-slate-400';
  }
}

function fmtDateTime(ms: number | null | undefined): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

function OpportunityCard({
  title,
  side,
  opportunity,
}: {
  title: string;
  side: 'BUY' | 'SELL';
  opportunity: OpportunitySnapshot | null;
}) {
  const q = opportunity?.quant;
  const risk = opportunity?.riskDecision;
  const isBuy = side === 'BUY';

  return (
    <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
        <div className="flex items-center gap-2">
          {isBuy ? (
            <TrendingUp className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <TrendingDown className="w-4 h-4 text-rose-400 shrink-0" />
          )}
          <span className="text-xs font-semibold text-slate-200">{title}</span>
        </div>
        {q ? (
          <span
            className={`text-xs font-semibold tabular-nums ${
              isBuy ? 'text-emerald-400' : 'text-rose-400'
            }`}
          >
            {q.symbol} · {q.direction}
          </span>
        ) : (
          <span className="text-xs text-slate-500">No directional candidate</span>
        )}
      </div>

      {q ? (
        <div className="space-y-3 text-xs">
          <div className="grid grid-cols-3 gap-2 tabular-nums">
            <div>
              <p className="text-[11px] text-slate-500">Last Closed</p>
              <p className="font-semibold text-white">{fmtPrice(q.price)}</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-500">Signal Score</p>
              <p className="font-semibold text-cyan-300">
                {q.signalStrengthScore} / 100
              </p>
            </div>
            <div>
              <p className="text-[11px] text-slate-500">Trend Strength</p>
              <p className="font-semibold text-slate-200">{q.trendStrength} / 100</p>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-2 border-t border-slate-800/70 pt-2.5 tabular-nums">
            <div>
              <p className="text-[11px] text-slate-500">RSI 14</p>
              <p className="font-medium text-slate-200">{q.rsi14.toFixed(1)}</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-500">Vol Ratio</p>
              <p className="font-medium text-slate-200">{q.volumeRatio.toFixed(2)}x</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-500">Volatility</p>
              <p className="font-medium text-slate-200">{q.volatilityPct.toFixed(2)}%</p>
            </div>
            <div>
              <p className="text-[11px] text-slate-500">MTF EMA</p>
              <p className="font-medium text-slate-200">{q.mtfAligned ? 'Aligned' : 'Mixed'}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-slate-800/70 pt-2 text-[11px] tabular-nums">
            <div>
              <span className="text-slate-500">S/R Range: </span>
              <span className="text-slate-300">
                {fmtPrice(q.supportLevel)} – {fmtPrice(q.resistanceLevel)}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Breakout: </span>
              <span className="text-slate-200">{q.breakout}</span>
            </div>
          </div>

          {q.reasons.length > 0 && (
            <p className="text-[11px] text-slate-400 leading-relaxed">
              {q.reasons.slice(0, 3).join(' · ')}
            </p>
          )}

          {risk && (
            <div className="border-t border-slate-800/70 pt-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-slate-500">Risk Manager Gate</span>
                <span
                  className={`text-[11px] font-semibold ${
                    risk.approved ? 'text-emerald-400' : 'text-amber-300'
                  }`}
                >
                  {risk.approved ? 'APPROVED' : 'REJECTED'}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-300">
                {risk.reasons[0] || 'Evaluated'}
              </p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-xs text-slate-500 py-4">
          Run the scanner to compute closed-candle EMA 9/21/50, RSI 14, MACD, ATR 14, and S/R scores (min {65}/100).
        </p>
      )}
    </div>
  );
}

export const MultiAgentPanel: React.FC<MultiAgentPanelProps> = ({
  apiConnected,
  canTrade,
  availableBalance,
  exchangePositions,
  openOrders,
  permissionDiagnostics,
  checkingPermission,
  onCheckPermission,
  onOpenApiSettings,
  onRefreshAccount,
}) => {
  const [status, setStatus] = useState<AgentStatusResponse | null>(null);
  const [logs, setLogs] = useState<AgentLogEntry[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string>('');
  const [confirmAutoModalOpen, setConfirmAutoModalOpen] = useState(false);
  const [confirmChecked, setConfirmChecked] = useState(false);
  const [activeTab, setActiveTab] = useState<'OVERVIEW' | 'SCANNER' | 'LEARNING' | 'LOGS'>('OVERVIEW');

  // Local Qwen Analyst (Ollama) state — strictly manual / on-demand, never polled aggressively
  const [ollamaStatus, setOllamaStatus] = useState<OllamaStatus | null>(null);
  const [ollamaChecking, setOllamaChecking] = useState<boolean>(true);
  const [ollamaAnalyzingSide, setOllamaAnalyzingSide] = useState<'BUY' | 'SELL' | null>(null);
  const [ollamaAnalysis, setOllamaAnalysis] = useState<OllamaAnalysisResponse | null>(null);
  const [ollamaError, setOllamaError] = useState<string>('');
  const [ollamaErrorCode, setOllamaErrorCode] = useState<string | null>(null);

  const refreshData = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([fetchAgentStatus(), fetchAgentLogs(150)]);
      setStatus(s);
      setLogs(l.logs || []);
    } catch (err: any) {
      setActionError(err?.message || 'Unable to poll Multi-Agent backend.');
    }
  }, []);

  const refreshOllamaStatus = useCallback(async () => {
    setOllamaChecking(true);
    setOllamaError('');
    setOllamaErrorCode(null);
    try {
      const next = await getOllamaStatus();
      setOllamaStatus(next);
    } catch (err: any) {
      const message = err?.message || 'Unable to check local Ollama status.';
      setOllamaError(message);
      setOllamaErrorCode(err instanceof OllamaApiError ? err.code || null : null);
      setOllamaStatus({
        success: false,
        provider: 'OLLAMA_LOCAL',
        status: 'OFFLINE',
        model: 'qwen3.5:4b',
        installedModels: [],
        lastCheckedAt: new Date().toISOString(),
        message,
      });
    } finally {
      setOllamaChecking(false);
    }
  }, []);

  const handleAnalyzeWithOllama = async (
    side: 'BUY' | 'SELL',
    opportunity: OpportunitySnapshot | null
  ) => {
    if (!opportunity || ollamaAnalyzingSide !== null || ollamaStatus?.status !== 'READY') {
      return;
    }

    const q = opportunity.quant;
    const payload: OllamaQuantInput = {
      direction: q.direction,
      score: q.signalStrengthScore,
      price: q.price,
      rsi: q.rsi14,
      ema9: q.ema9_15m,
      ema21: q.ema21_15m,
      ema50: q.ema50_15m,
      macd: q.macd,
      macdSignal: q.macdSignal,
      atr: q.atr14,
      volumeRatio: q.volumeRatio,
      volatilityPct: q.volatilityPct,
      change24h: q.change24h,
      volume24h: q.quoteVolume,
    };

    setOllamaAnalyzingSide(side);
    setOllamaError('');
    setOllamaErrorCode(null);
    try {
      const response = await analyzeWithOllama(q.symbol, payload);
      setOllamaAnalysis(response);
    } catch (err: any) {
      const message = err?.message || 'Local Qwen analysis failed.';
      setOllamaError(message);
      setOllamaErrorCode(err instanceof OllamaApiError ? err.code || null : null);
    } finally {
      setOllamaAnalyzingSide(null);
    }
  };

  useEffect(() => {
    void refreshData();
    const timer = window.setInterval(() => void refreshData(), 4_000);
    return () => window.clearInterval(timer);
  }, [refreshData]);

  useEffect(() => {
    void refreshOllamaStatus();
  }, [refreshOllamaStatus]);

  const handleStartScanner = async () => {
    setBusyAction('START_SCANNER');
    setActionError('');
    try {
      const updated = await startAgentEngine({ mode: 'SCAN_ONLY' });
      setStatus(updated);
      await refreshData();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to start Market Scanner.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleConfirmStartAutoTrading = async () => {
    if (!confirmChecked) return;
    setBusyAction('START_AUTO');
    setActionError('');
    try {
      const updated = await startAgentEngine({
        mode: 'AUTO_TRADING',
        demoConfirmed: true,
      });
      setStatus(updated);
      setConfirmAutoModalOpen(false);
      setConfirmChecked(false);
      await Promise.all([refreshData(), onRefreshAccount()]);
    } catch (err: any) {
      setActionError(err?.message || 'Failed to start Demo Auto Trading.');
    } finally {
      setBusyAction(null);
    }
  };

  const handlePause = async () => {
    setBusyAction('PAUSE');
    setActionError('');
    try {
      const updated = await pauseAgentTrading();
      setStatus(updated);
      await refreshData();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to pause new trades.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleResume = async () => {
    setBusyAction('RESUME');
    setActionError('');
    try {
      const updated = await resumeAgentEngine({
        mode: status?.demoExplicitlyConfirmed ? 'AUTO_TRADING' : 'SCAN_ONLY',
        demoConfirmed: Boolean(status?.demoExplicitlyConfirmed),
      });
      setStatus(updated);
      await refreshData();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to resume.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleStopNewTrades = async () => {
    setBusyAction('STOP');
    setActionError('');
    try {
      const updated = await stopAgentNewTrades();
      setStatus(updated);
      await refreshData();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to stop new trades.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleToggleQuantOnlyPaper = async () => {
    const nextEnabled = !(status?.config?.quantOnlyPaperMode === true);
    setBusyAction('POLICY');
    setActionError('');
    try {
      await updateAgentConfig({
        quantOnlyPaperMode: nextEnabled,
        tradingPolicy: nextEnabled ? 'QUANT_ONLY_PAPER' : 'GEMINI_REQUIRED',
      });
      await refreshData();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to update trading policy.');
    } finally {
      setBusyAction(null);
    }
  };

  const handleRecheckGemini = async () => {
    if (busyAction !== null) return;
    setBusyAction('RECHECK_AI');
    setActionError('');
    try {
      const updated = await recheckGeminiAi();
      setStatus(updated);
      await refreshData();
    } catch (err: any) {
      setActionError(err?.message || 'Failed to recheck Gemini AI availability.');
    } finally {
      setBusyAction(null);
    }
  };

  const mode = status?.mode ?? 'STOPPED';
  const autoTrading = Boolean(status?.autoTradingEnabled);
  const progress = status?.scanProgress;
  const progressPct =
    progress && progress.totalTargets > 0
      ? Math.min(100, Math.round((progress.completedTargets / progress.totalTargets) * 100))
      : 0;
  const aiAnalysis = status?.aiAnalysis;
  const geminiStatus = status?.geminiStatus;
  const riskDecision = status?.riskDecision;
  const activeTrade = status?.activeTrade;
  const perf = status?.performance;
  const criticalErrors = status?.criticalErrors ?? [];
  const effectiveDiagnostics =
    permissionDiagnostics ?? status?.permissionDiagnostics ?? null;
  const tradingConfirmed = Boolean(
    apiConnected &&
      canTrade &&
      effectiveDiagnostics?.tradingConfirmed &&
      effectiveDiagnostics?.accountConfigCanTrade === true &&
      effectiveDiagnostics?.orderTestPassed
  );
  const openPosCount = exchangePositions.filter(
    (p) => Math.abs(Number(p.positionAmt)) > 1e-12
  ).length;
  const unrealizedTotal =
    status?.unrealizedPnl ??
    exchangePositions.reduce((s, p) => s + (Number(p.unRealizedProfit) || 0), 0);

  const rawGeminiState = geminiStatus?.status ?? 'STANDBY';
  const geminiState =
    rawGeminiState === 'ACTIVE' && !geminiStatus?.lastSuccessfulAnalysisAt
      ? 'STANDBY'
      : rawGeminiState;
  const primaryStatusDisplay =
    geminiStatus?.primaryStatus === 'ACTIVE' && !geminiStatus?.lastSuccessfulAnalysisAt
      ? 'STANDBY'
      : geminiStatus?.primaryStatus ?? 'STANDBY';
  const fallbackModelDisplay = geminiStatus?.fallbackModel || 'NOT CONFIGURED';
  const fallbackStatusDisplay = geminiStatus?.fallbackModel
    ? geminiStatus?.fallbackStatus ?? 'STANDBY'
    : 'DISABLED';
  const isQuotaExhausted = geminiState === 'QUOTA_EXHAUSTED';
  const isFallbackActive =
    geminiState === 'FALLBACK_ACTIVE' || Boolean(geminiStatus?.fallbackActive);
  const isPrimaryOverloaded =
    geminiState === 'OVERLOADED' || primaryStatusDisplay === 'OVERLOADED';
  const isRecovering =
    geminiState === 'RECOVERING' || primaryStatusDisplay === 'RECOVERING';
  const isGeminiDegraded = geminiState === 'DEGRADED';
  const quantOnlyPaperEnabled = status?.config?.quantOnlyPaperMode === true;

  const bestBuyCandidate = status?.opportunities?.bestBuy ?? null;
  const bestSellCandidate = status?.opportunities?.bestSell ?? null;

  const ollamaDisplayState:
    | 'CHECKING'
    | 'READY'
    | 'OFFLINE'
    | 'MODEL NOT INSTALLED'
    | 'BUSY'
    | 'ERROR' = (() => {
    if (ollamaAnalyzingSide !== null || ollamaErrorCode === 'OLLAMA_BUSY' || ollamaStatus?.busy) {
      return 'BUSY';
    }
    if (ollamaChecking && !ollamaStatus) {
      return 'CHECKING';
    }
    if (ollamaError) {
      return 'ERROR';
    }
    if (!ollamaStatus) {
      return 'CHECKING';
    }
    if (ollamaStatus.status === 'READY') return 'READY';
    if (ollamaStatus.status === 'MODEL_NOT_INSTALLED') return 'MODEL NOT INSTALLED';
    if (ollamaStatus.status === 'OFFLINE') return 'OFFLINE';
    return 'ERROR';
  })();

  const ollamaStatusColor =
    ollamaDisplayState === 'READY'
      ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10'
      : ollamaDisplayState === 'BUSY'
        ? 'text-cyan-300 border-cyan-500/40 bg-cyan-500/10'
        : ollamaDisplayState === 'CHECKING'
          ? 'text-slate-300 border-slate-700 bg-slate-900'
          : ollamaDisplayState === 'MODEL NOT INSTALLED'
            ? 'text-amber-300 border-amber-500/40 bg-amber-500/10'
            : 'text-rose-300 border-rose-500/40 bg-rose-500/10';

  return (
    <section className="border border-slate-800 bg-[#0b1322] rounded-2xl p-5 space-y-6">
      {/* Panel Header + Dedicated Control Buttons */}
      <div className="flex flex-col gap-4 border-b border-slate-800 pb-5 xl:flex-row xl:items-center xl:justify-between">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-3">
            <Cpu className="w-5 h-5 text-cyan-400 shrink-0" />
            <h2 className="text-base font-bold tracking-wide text-white">
              MULTI-AGENT CONTROL PANEL
            </h2>
            <span className="text-xs font-semibold text-cyan-300">
              USD-M FUTURES DEMO ONLY
            </span>
          </div>
          <p className="text-xs text-slate-400">
            Engine: <span className="font-semibold text-slate-200">{mode}</span>
            <span className="mx-2 text-slate-700">·</span>
            Auto-Trading:{' '}
            <span
              className={`font-semibold ${
                autoTrading ? 'text-emerald-400' : 'text-slate-300'
              }`}
            >
              {autoTrading ? 'ON (DEMO ARMED)' : 'OFF'}
            </span>
            <span className="mx-2 text-slate-700">·</span>
            Last Scan: <span className="text-slate-200 tabular-nums">{fmtTime(status?.lastScanAt)}</span>
            <span className="mx-2 text-slate-700">·</span>
            Last Trade: <span className="text-slate-200 tabular-nums">{fmtTime(status?.lastTradeAt)}</span>
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => void handleStartScanner()}
            disabled={busyAction !== null}
            className="inline-flex items-center gap-2 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3.5 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-cyan-500/25 disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Radar className="w-3.5 h-3.5" />
            {busyAction === 'START_SCANNER' ? 'Starting...' : 'START SCANNER'}
          </button>

          <button
            onClick={() => {
              if (!apiConnected) {
                onOpenApiSettings();
                return;
              }
              setConfirmChecked(false);
              setConfirmAutoModalOpen(true);
            }}
            disabled={busyAction !== null || autoTrading || (apiConnected && !tradingConfirmed)}
            title={
              apiConnected && !tradingConfirmed
                ? 'Disabled until both Futures Account Can Trade and Demo Order Test pass.'
                : undefined
            }
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-3.5 py-2 text-xs font-bold text-slate-950 transition hover:bg-emerald-400 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Play className="w-3.5 h-3.5" />
            START DEMO AUTO TRADING
          </button>

          <button
            onClick={() => void handlePause()}
            disabled={busyAction !== null || mode === 'STOPPED' || mode === 'PAUSED'}
            className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-xs font-semibold text-amber-200 transition hover:bg-amber-500/20 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <Pause className="w-3.5 h-3.5" />
            PAUSE NEW TRADES
          </button>

          <button
            onClick={() => void handleResume()}
            disabled={busyAction !== null || mode !== 'PAUSED'}
            className="inline-flex items-center gap-2 rounded-lg border border-cyan-400/30 bg-slate-900 px-3.5 py-2 text-xs font-semibold text-cyan-200 transition hover:bg-slate-800 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            RESUME NEW TRADES
          </button>

          <button
            onClick={() => void handleStopNewTrades()}
            disabled={busyAction !== null || mode === 'STOPPED'}
            className="inline-flex items-center gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2 text-xs font-semibold text-rose-200 transition hover:bg-rose-500/20 disabled:opacity-40 whitespace-nowrap shrink-0"
          >
            <Square className="w-3.5 h-3.5" />
            STOP NEW TRADES
          </button>

          <button
            onClick={() => void refreshData()}
            aria-label="Refresh Multi-Agent Status"
            className="inline-flex items-center justify-center rounded-lg border border-slate-700 bg-slate-900 p-2 text-slate-300 transition hover:bg-slate-800"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Action Error or Critical Execution Alert Banner */}
      {(actionError || status?.lastError) && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-200">
          <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <span>{actionError || status?.lastError}</span>
        </div>
      )}

      {criticalErrors.length > 0 && (
        <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/60 bg-rose-950/50 px-4 py-3 text-xs text-rose-100">
          <ShieldAlert className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
          <div>
            <p className="font-bold text-rose-300">
              Latest Critical Alert ({fmtTime(criticalErrors[0].at)}): {criticalErrors[0].stage}
            </p>
            <p className="text-rose-200 mt-0.5">{criticalErrors[0].message}</p>
          </div>
        </div>
      )}

      {/* Key KPI Summary Strip (Full-Width 4 Columns) */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-3.5">
          <p className="text-[11px] text-slate-400">Market Scan Progress</p>
          <div className="mt-1 flex items-baseline justify-between gap-2">
            <p className="text-lg font-bold text-white tabular-nums">
              {progress?.completedTargets ?? 0} / {progress?.totalTargets ?? 20} Pairs
            </p>
            <span className="text-xs text-cyan-300 tabular-nums">{progressPct}%</span>
          </div>
          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
            <div
              className="h-full bg-cyan-400 transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <p className="mt-1.5 text-[11px] text-slate-500 truncate">
            {progress?.stageLabel || 'Idle'}
          </p>
        </div>

        <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-3.5">
          <p className="text-[11px] text-slate-400">Daily Realized / Unrealized PnL</p>
          <div className="mt-1 flex items-baseline gap-2 tabular-nums">
            <p
              className={`text-lg font-bold ${
                (status?.todayRealizedPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {fmtUsd(status?.todayRealizedPnl ?? 0)}
            </p>
            <span
              className={`text-xs font-semibold ${
                unrealizedTotal >= 0 ? 'text-emerald-300' : 'text-rose-300'
              }`}
            >
              (uPnL {unrealizedTotal >= 0 ? '+' : ''}
              {fmtUsd(unrealizedTotal)})
            </span>
          </div>
          <p className="mt-2 text-[11px] text-slate-500 tabular-nums">
            Fees: {fmtUsd(perf?.totalTradingFees ?? 0)} · Funding: {fmtUsd(perf?.totalFundingFees ?? 0)}
          </p>
        </div>

        <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-3.5">
          <p className="text-[11px] text-slate-400">Open Exposure &amp; Protection</p>
          <p className="mt-1 text-lg font-bold text-white tabular-nums">
            {openPosCount} / {status?.riskLimits.MAX_OPEN_POSITIONS ?? 1} Position
          </p>
          <p className="mt-2 text-[11px] text-slate-400 truncate">
            {activeTrade
              ? `${activeTrade.symbol} SL ${activeTrade.stopStatus} (#${activeTrade.stopAlgoId ?? '—'}) · TP ${activeTrade.takeProfitStatus} (#${activeTrade.targetAlgoId ?? '—'})`
              : `${status?.exchangeOpenOrdersCount ?? openOrders.length} open exchange orders`}
          </p>
        </div>

        <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-3.5">
          <p className="text-[11px] text-slate-400">Demo Connection &amp; Limits</p>
          <p className="mt-1 text-lg font-bold text-white tabular-nums">
            {apiConnected ? fmtUsd(availableBalance) : 'Not Connected'}
          </p>
          <p className="mt-2 text-[11px] text-slate-400 tabular-nums">
            0.25% risk · Max 2x · $100 cap · {status?.config?.cooldownMinutes ?? 30}m cooldown
          </p>
        </div>
      </div>

      {/* Futures Trading Permission Diagnostics */}
      <PermissionDiagnosticsCard
        apiConnected={apiConnected}
        canTrade={canTrade}
        diagnostics={effectiveDiagnostics}
        checking={checkingPermission}
        onCheckPermission={onCheckPermission}
      />

      {/* GEMINI AI ANALYST — 503 Auto-Recovery, Verified Model Failover & Quota Manager */}
      <div
        data-testid="gemini-analyst-status-card"
        className="border border-slate-800 bg-[#080f1b] rounded-xl p-4 space-y-3.5"
      >
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:justify-between border-b border-slate-800/80 pb-3">
          <div className="flex flex-wrap items-center gap-2.5">
            <Brain
              className={`w-4 h-4 shrink-0 ${
                isQuotaExhausted
                  ? 'text-rose-400'
                  : isFallbackActive || isRecovering
                    ? 'text-cyan-400'
                    : isPrimaryOverloaded || isGeminiDegraded
                      ? 'text-amber-400'
                      : geminiState === 'ACTIVE'
                        ? 'text-emerald-400'
                        : 'text-slate-400'
              }`}
            />
            <h3 className="text-xs font-bold tracking-wider text-white">
              GEMINI SERVICE (OPTIONAL)
            </h3>
            <span
              data-testid="gemini-status-badge"
              className={`text-xs font-black tracking-wide ${
                isQuotaExhausted
                  ? 'text-rose-400'
                  : isFallbackActive || isRecovering
                    ? 'text-cyan-300'
                    : isPrimaryOverloaded || isGeminiDegraded
                      ? 'text-amber-300'
                      : geminiState === 'ACTIVE'
                        ? 'text-emerald-400'
                        : 'text-slate-300'
              }`}
            >
              Status: {geminiState}
            </span>
            {isFallbackActive && (
              <span
                data-testid="gemini-fallback-active-badge"
                className="rounded border border-cyan-500/50 bg-cyan-500/15 px-2 py-0.5 text-[10px] font-bold tracking-wider text-cyan-200"
              >
                FALLBACK ACTIVE ({fallbackModelDisplay})
              </span>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
            <span className="text-slate-400">
              AI Approval:{' '}
              <span className="font-semibold text-cyan-300">
                REQUIRED
              </span>
              <span className="text-slate-500" data-testid="local-qwen-approval-mode">
                Local Qwen trade approval: {status?.config?.localAiApprovalEnabled ? 'ENABLED' : 'DISABLED (ADVISORY)'}
              </span>
            </span>
            <span className="text-slate-500 tabular-nums">
              Quota: {geminiStatus?.requestsUsedToday ?? 0} / {geminiStatus?.maxDailyRequests ?? 12}
            </span>
            <button
              type="button"
              data-testid="recheck-ai-btn"
              onClick={() => void handleRecheckGemini()}
              disabled={busyAction !== null || isQuotaExhausted}
              title={
                isQuotaExhausted
                  ? 'Blocked while daily 429 quota is exhausted.'
                  : 'Run a single locked recovery probe against Gemini AI.'
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1 text-[11px] font-semibold text-cyan-200 transition hover:bg-cyan-500/25 cursor-pointer disabled:opacity-40 whitespace-nowrap"
            >
              <RefreshCw className={`w-3 h-3 ${busyAction === 'RECHECK_AI' ? 'animate-spin' : ''}`} />
              {busyAction === 'RECHECK_AI' ? 'RECHECKING...' : 'RECHECK AI'}
            </button>
            <button
              type="button"
              onClick={() => void handleToggleQuantOnlyPaper()}
              disabled={busyAction !== null}
              className={`rounded-lg border px-2.5 py-1 text-[11px] font-semibold transition cursor-pointer disabled:opacity-50 ${
                quantOnlyPaperEnabled
                  ? 'border-amber-500/50 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                  : 'border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800'
              }`}
            >
              {quantOnlyPaperEnabled
                ? 'QUANT_ONLY Paper-Testing: ON (No Orders)'
                : 'Enable QUANT_ONLY Paper-Testing'}
            </button>
          </div>
        </div>

        {isQuotaExhausted && (
          <div
            data-testid="gemini-quota-exhausted-banner"
            className="flex items-start gap-2.5 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2.5 text-xs text-rose-200"
          >
            <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold text-rose-100">
                Gemini daily quota exhausted (429 RESOURCE_EXHAUSTED). Fallback bypass disabled. Technical scanning remains available; AI-dependent automated Demo entries are paused.
              </p>
              <p className="text-[11px] text-rose-300/90">
                Existing open positions continue active reconciliation and protective Algo SL/TP management.
              </p>
            </div>
          </div>
        )}

        {!isQuotaExhausted && isFallbackActive && (
          <div
            data-testid="gemini-fallback-banner"
            className="flex items-start gap-2.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-100"
          >
            <AlertTriangle className="w-4 h-4 text-cyan-300 shrink-0 mt-0.5" />
            <span>
              FALLBACK ACTIVE: Primary model <span className="font-mono font-semibold">{geminiStatus?.primaryModel ?? 'gemini-4-hydrogen'}</span> is OVERLOADED (503). Verified fallback <span className="font-mono font-semibold">{fallbackModelDisplay}</span> is serving analysis until cooldown probe completes.
            </span>
          </div>
        )}

        {!isQuotaExhausted && !isFallbackActive && (isPrimaryOverloaded || isGeminiDegraded || isRecovering) && (
          <div
            data-testid="gemini-degraded-banner"
            className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
          >
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <span>
              {isRecovering
                ? `Primary model ${geminiStatus?.primaryModel ?? 'gemini-4-hydrogen'} cooldown expired — awaiting single recovery probe.`
                : isPrimaryOverloaded
                  ? `Primary model ${geminiStatus?.primaryModel ?? 'gemini-4-hydrogen'} is OVERLOADED (503 high demand). Circuit breaker active; mathematical scanner & protective monitoring continue while AI-dependent automated entries stay blocked.`
                  : 'Gemini AI Analyst is temporarily DEGRADED. Mathematical market scanning & protective monitoring remain operational while AI-dependent automated entries stay blocked.'}
            </span>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 text-xs tabular-nums">
          <div className="rounded-lg border border-slate-800/80 bg-[#070d17] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              PRIMARY MODEL
            </p>
            <p
              data-testid="gemini-primary-model"
              className="mt-1 font-mono text-[11px] sm:text-xs font-semibold text-cyan-300 break-words"
            >
              {geminiStatus?.primaryModel ?? 'gemini-4-hydrogen'}
            </p>
          </div>

          <div className="rounded-lg border border-slate-800/80 bg-[#070d17] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              PRIMARY STATUS
            </p>
            <p
              data-testid="gemini-primary-status"
              className={`mt-1 font-bold ${agentStateStyle(primaryStatusDisplay)}`}
            >
              {primaryStatusDisplay}
            </p>
          </div>

          <div className="rounded-lg border border-slate-800/80 bg-[#070d17] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              FALLBACK MODEL
            </p>
            <p
              data-testid="gemini-fallback-model"
              className={`mt-1 font-mono text-[11px] sm:text-xs font-semibold break-words ${
                geminiStatus?.fallbackModel ? 'text-slate-200' : 'text-slate-500'
              }`}
            >
              {fallbackModelDisplay}
            </p>
          </div>

          <div className="rounded-lg border border-slate-800/80 bg-[#070d17] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              FALLBACK STATUS
            </p>
            <p
              data-testid="gemini-fallback-status"
              className={`mt-1 font-bold ${
                fallbackStatusDisplay === 'ACTIVE'
                  ? 'text-cyan-300'
                  : fallbackStatusDisplay === 'DEGRADED'
                    ? 'text-amber-400'
                    : fallbackStatusDisplay === 'STANDBY'
                      ? 'text-slate-300'
                      : 'text-slate-500'
              }`}
            >
              {fallbackStatusDisplay}
            </p>
          </div>

          <div className="rounded-lg border border-slate-800/80 bg-[#070d17] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              REQUEST QUEUE
            </p>
            <p
              data-testid="gemini-request-queue"
              className="mt-1 font-bold text-white"
            >
              {geminiStatus?.pendingRequests ?? 0} pending · {geminiStatus?.candidatesAwaitingAnalysis ?? 0} awaiting
            </p>
          </div>

          <div className="rounded-lg border border-slate-800/80 bg-[#070d17] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              CACHE
            </p>
            <p
              data-testid="gemini-cached-count"
              className="mt-1 font-bold text-emerald-300"
            >
              {geminiStatus?.cachedAnalysesCount ?? 0} entries
            </p>
          </div>

          <div className="rounded-lg border border-slate-800/80 bg-[#070d17] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              LAST SUCCESSFUL ANALYSIS
            </p>
            <p
              data-testid="gemini-last-success"
              className="mt-1 text-[11px] leading-snug font-medium text-slate-200 break-words"
            >
              {geminiStatus?.lastSuccessfulAnalysisAt
                ? `${fmtDateTime(geminiStatus.lastSuccessfulAnalysisAt)}${geminiStatus.lastRespondedModel ? ` (${geminiStatus.lastRespondedModel})` : ''}`
                : 'Never'}
            </p>
          </div>

          <div className="rounded-lg border border-slate-800/80 bg-[#070d17] px-3 py-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              NEXT RETRY
            </p>
            <p
              data-testid="gemini-next-retry"
              className="mt-1 text-[11px] font-medium text-amber-200 truncate"
            >
              {geminiStatus?.nextRetryAt
                ? fmtDateTime(geminiStatus.nextRetryAt)
                : isRecovering
                  ? 'Probe Ready'
                  : 'Ready'}
            </p>
          </div>

          <div className="rounded-lg border border-slate-800/80 bg-[#070d17] px-3 py-2 col-span-2">
            <p className="text-[10px] uppercase tracking-wider text-slate-500">
              LAST ERROR
            </p>
            <p
              data-testid="gemini-last-error"
              className={`mt-1 text-[11px] truncate ${
                geminiStatus?.lastApiError ? 'text-rose-300' : 'text-slate-400'
              }`}
              title={geminiStatus?.lastApiError ?? 'None'}
            >
              {geminiStatus?.lastApiError
                ? geminiStatus.lastErrorCode
                  ? `[${geminiStatus.lastErrorCode}] ${geminiStatus.lastApiError}`
                  : geminiStatus.lastApiError
                : 'None'}
            </p>
          </div>
        </div>
      </div>

      {/* Six Specialist Agent Status Cards */}
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">
          Six Specialist Agents
        </h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {(status?.agents ?? []).map((agent) => (
            <div
              key={agent.id}
              className="border border-slate-800 bg-[#080f1b] rounded-xl p-3.5 space-y-1.5"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold text-white">
                  {agent.label}
                </span>
                <span className={`text-[11px] font-bold ${agentStateStyle(agent.status)}`}>
                  {agent.status}
                </span>
              </div>
              <p className="text-[11px] text-slate-500">{agent.role}</p>
              <p className="text-xs text-slate-200 pt-1 truncate" title={agent.detail}>
                {agent.detail}
              </p>
              <p className="text-[10px] text-slate-600 tabular-nums">
                Updated: {fmtTime(agent.lastRunAt)}
              </p>
            </div>
          ))}
        </div>
      </div>

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 pb-3">
        {[
          { id: 'OVERVIEW', label: 'Opportunities, AI & Risk' },
          {
            id: 'SCANNER',
            label: `Top 20 Scanned (${status?.opportunities?.scannedTopCount ?? 0})`,
          },
          {
            id: 'LEARNING',
            label: `Performance & Walk-Forward (${perf?.closedTrades ?? 0})`,
          },
          { id: 'LOGS', label: `Agent Event Logs (${logs.length})` },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id as any)}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition whitespace-nowrap shrink-0 ${
              activeTab === tab.id
                ? 'bg-cyan-500/20 text-cyan-200 border border-cyan-500/40'
                : 'text-slate-400 hover:text-slate-200 border border-transparent hover:border-slate-800'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* TAB 1: Overview */}
      {activeTab === 'OVERVIEW' && (
        <div className="space-y-5">
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <OpportunityCard
              title="Best BUY Opportunity"
              side="BUY"
              opportunity={status?.opportunities?.bestBuy ?? null}
            />
            <OpportunityCard
              title="Best SELL Opportunity"
              side="SELL"
              opportunity={status?.opportunities?.bestSell ?? null}
            />
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            {/* Gemini AI Market Analyst Panel */}
            <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
                <div className="flex items-center gap-2">
                  <Brain className="w-4 h-4 text-cyan-400" />
                  <span className="text-xs font-semibold text-white">
                    Agent 3: Gemini AI Market Analyst
                  </span>
                </div>
                <span
                  className={`text-xs font-semibold ${
                    aiAnalysis?.result?.quotaExhausted
                      ? 'text-rose-400'
                      : aiAnalysis?.result?.degraded
                        ? 'text-amber-400'
                        : aiAnalysis?.result?.usedFallback
                          ? 'text-cyan-300'
                          : aiAnalysis?.result?.available
                            ? 'text-emerald-400'
                            : 'text-slate-400'
                  }`}
                >
                  {aiAnalysis
                    ? aiAnalysis.result.quotaExhausted
                      ? 'QUOTA_EXHAUSTED'
                      : aiAnalysis.result.degraded
                        ? aiAnalysis.result.errorCategory === 'CAPACITY_503'
                          ? 'OVERLOADED (503)'
                          : 'DEGRADED'
                        : `${aiAnalysis.symbol} · ${aiAnalysis.result.marketRegime} · ${aiAnalysis.result.direction}${aiAnalysis.result.usedFallback ? ' · FALLBACK' : ''}`
                    : geminiState !== 'STANDBY' && geminiState !== 'ACTIVE'
                      ? geminiState
                      : 'Awaiting Qualified Signal'}
                </span>
              </div>

              {aiAnalysis ? (
                <div className="space-y-2.5 text-xs">
                  <div className="grid grid-cols-4 gap-2 tabular-nums">
                    <div>
                      <p className="text-[11px] text-slate-500">Sentiment</p>
                      <p className="font-semibold text-slate-200">
                        {aiAnalysis.result.sentiment}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-slate-500">Confidence (0–1)</p>
                      <p className="font-semibold text-cyan-300">
                        {aiAnalysis.result.confidence.toFixed(2)}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-slate-500">Model Used</p>
                      <p className="font-mono text-[11px] font-semibold text-slate-200 truncate">
                        {aiAnalysis.result.modelUsed || geminiStatus?.primaryModel || 'gemini-4-hydrogen'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-slate-500">Status</p>
                      <p
                        className={`font-semibold ${
                          aiAnalysis.result.usedFallback
                            ? 'text-cyan-300'
                            : aiAnalysis.result.available
                              ? 'text-emerald-400'
                              : 'text-amber-300'
                        }`}
                      >
                        {aiAnalysis.result.usedFallback
                          ? 'FALLBACK ACTIVE'
                          : aiAnalysis.result.available
                            ? 'Verified Schema'
                            : 'DEGRADED'}
                      </p>
                    </div>
                  </div>
                  <p className="text-slate-300 leading-relaxed">
                    {aiAnalysis.result.reasoning}
                  </p>
                  {aiAnalysis.result.riskFlags.length > 0 && (
                    <p className="text-[11px] text-amber-300">
                      Risk Flags: {aiAnalysis.result.riskFlags.join(' · ')}
                    </p>
                  )}
                </div>
              ) : (
                <p className="text-xs text-slate-500 py-3">
                  No AI evaluation run yet. Gemini analyzes quantitative outputs and flags regime conflicts without direct order execution rights.
                </p>
              )}
            </div>

            {/* Mathematical Risk Manager Gate */}
            <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
                <div className="flex items-center gap-2">
                  {riskDecision?.approved ? (
                    <ShieldCheck className="w-4 h-4 text-emerald-400" />
                  ) : (
                    <ShieldAlert className="w-4 h-4 text-amber-400" />
                  )}
                  <span className="text-xs font-semibold text-white">
                    Agent 4: Mathematical Risk Manager Veto
                  </span>
                </div>
                <span
                  className={`text-xs font-bold ${
                    riskDecision?.approved
                      ? 'text-emerald-400'
                      : riskDecision
                        ? 'text-rose-400'
                        : 'text-slate-500'
                  }`}
                >
                  {riskDecision
                    ? riskDecision.approved
                      ? `APPROVED · ${riskDecision.symbol}`
                      : `REJECTED · ${riskDecision.symbol}`
                    : 'Awaiting Candidate'}
                </span>
              </div>

              {riskDecision ? (
                <div className="space-y-2 text-xs">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {riskDecision.checks.map((c) => (
                      <div
                        key={c.name}
                        className="flex items-center justify-between border border-slate-800/80 rounded-lg px-2.5 py-1.5"
                      >
                        <span className="text-[11px] text-slate-300">{c.name}</span>
                        <span
                          className={`text-[11px] font-semibold ${
                            c.passed ? 'text-emerald-400' : 'text-rose-400'
                          }`}
                        >
                          {c.passed ? 'PASS' : 'FAIL'}
                        </span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-400 pt-1">
                    {riskDecision.reasons.join(' · ')}
                  </p>
                </div>
              ) : (
                <p className="text-xs text-slate-500 py-3">
                  Risk Manager computes quantity = (availableBalance × 0.0025) / |entry − stopLoss| and enforces stepSize, notional caps ($100), and 1% daily drawdown limits.
                </p>
              )}
            </div>
          </div>

          {/* Local Qwen Analyst (Ollama — Advisory Only) */}
          <div
            data-testid="local-qwen-analyst-card"
            className="border border-slate-800 bg-[#080f1b] rounded-xl p-4 space-y-3.5"
          >
            <div className="flex flex-col gap-3 border-b border-slate-800/80 pb-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-2.5">
                <Cpu className="w-4 h-4 text-emerald-400 shrink-0" />
                <h3 className="text-xs font-bold tracking-wider text-white">
                  LOCAL QWEN ANALYST
                </h3>
                <span
                  data-testid="ollama-status-badge"
                  className={`rounded border px-2 py-0.5 text-[10px] font-bold tracking-wide ${ollamaStatusColor}`}
                >
                  {ollamaDisplayState}
                </span>
                <span
                  data-testid="ollama-model-name"
                  className="font-mono text-[11px] font-semibold text-cyan-300"
                >
                  {ollamaStatus?.model || 'qwen3.5:4b'}
                </span>
                <span className="text-[11px] text-slate-500">
                  Advisory Only · No Order Authority
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  data-testid="ollama-refresh-status-btn"
                  onClick={() => void refreshOllamaStatus()}
                  disabled={ollamaChecking || ollamaAnalyzingSide !== null}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                >
                  <RefreshCw className={`w-3 h-3 ${ollamaChecking ? 'animate-spin' : ''}`} />
                  {ollamaChecking ? 'Checking...' : 'Refresh Status'}
                </button>

                <button
                  type="button"
                  data-testid="ollama-analyze-buy-btn"
                  onClick={() => void handleAnalyzeWithOllama('BUY', bestBuyCandidate)}
                  disabled={
                    !bestBuyCandidate ||
                    ollamaStatus?.status !== 'READY' ||
                    ollamaAnalyzingSide !== null ||
                    ollamaChecking
                  }
                  title={
                    !bestBuyCandidate
                      ? 'Run the market scanner first to detect a BUY candidate.'
                      : ollamaStatus?.status !== 'READY'
                        ? 'Local Ollama model must be READY before running analysis.'
                        : `Analyze ${bestBuyCandidate.symbol} with local Qwen`
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 transition hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                >
                  <TrendingUp className="w-3.5 h-3.5" />
                  {ollamaAnalyzingSide === 'BUY'
                    ? `Analyzing ${bestBuyCandidate?.symbol ?? 'BUY'}...`
                    : bestBuyCandidate
                      ? `Analyze BUY Candidate (${bestBuyCandidate.symbol})`
                      : 'Analyze BUY Candidate'}
                </button>

                <button
                  type="button"
                  data-testid="ollama-analyze-sell-btn"
                  onClick={() => void handleAnalyzeWithOllama('SELL', bestSellCandidate)}
                  disabled={
                    !bestSellCandidate ||
                    ollamaStatus?.status !== 'READY' ||
                    ollamaAnalyzingSide !== null ||
                    ollamaChecking
                  }
                  title={
                    !bestSellCandidate
                      ? 'Run the market scanner first to detect a SELL candidate.'
                      : ollamaStatus?.status !== 'READY'
                        ? 'Local Ollama model must be READY before running analysis.'
                        : `Analyze ${bestSellCandidate.symbol} with local Qwen`
                  }
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-[11px] font-semibold text-rose-200 transition hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                >
                  <TrendingDown className="w-3.5 h-3.5" />
                  {ollamaAnalyzingSide === 'SELL'
                    ? `Analyzing ${bestSellCandidate?.symbol ?? 'SELL'}...`
                    : bestSellCandidate
                      ? `Analyze SELL Candidate (${bestSellCandidate.symbol})`
                      : 'Analyze SELL Candidate'}
                </button>
              </div>
            </div>

            {ollamaStatus?.message && (
              <p
                data-testid="ollama-status-message"
                className={`text-xs ${
                  ollamaDisplayState === 'READY'
                    ? 'text-slate-300'
                    : ollamaDisplayState === 'MODEL NOT INSTALLED'
                      ? 'text-amber-300'
                      : 'text-slate-400'
                }`}
              >
                {ollamaStatus.message}
              </p>
            )}

            {ollamaAnalyzingSide !== null && (
              <div
                data-testid="ollama-busy-banner"
                className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 px-3 py-2 text-xs text-cyan-200"
              >
                Running local Qwen inference on CPU (<span className="font-mono">think: false</span>,{' '}
                <span className="font-mono">num_ctx: 2048</span>). Only one request runs at a time; please wait.
              </div>
            )}

            {ollamaError && (
              <div
                data-testid="ollama-error-banner"
                className="flex items-start gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs text-rose-200"
              >
                <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
                <span>{ollamaError}</span>
              </div>
            )}

            {!bestBuyCandidate && !bestSellCandidate && (
              <p
                data-testid="ollama-no-candidates-note"
                className="text-xs text-slate-400"
              >
                No directional BUY or SELL candidate is queued yet. Click <span className="font-semibold text-slate-200">START SCANNER</span> to compute real quantitative indicators before requesting local Qwen analysis.
              </p>
            )}

            {ollamaAnalysis && (
              <div
                data-testid="ollama-analysis-result"
                className="rounded-xl border border-slate-800 bg-[#070d17] p-4 space-y-3 text-xs"
              >
                <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800/80 pb-2.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-white">
                      {ollamaAnalysis.analysis.symbol}
                    </span>
                    <span
                      data-testid="ollama-decision"
                      className={`rounded px-2 py-0.5 font-bold ${
                        ollamaAnalysis.analysis.decision === 'BUY'
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : ollamaAnalysis.analysis.decision === 'SELL'
                            ? 'bg-rose-500/20 text-rose-300'
                            : 'bg-slate-800 text-slate-200'
                      }`}
                    >
                      {ollamaAnalysis.analysis.decision}
                    </span>
                    <span className="font-mono text-[11px] text-slate-400">
                      {ollamaAnalysis.model}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-400 tabular-nums">
                    Duration: <span className="font-semibold text-cyan-300">{ollamaAnalysis.durationMs} ms</span>
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 tabular-nums">
                  <div>
                    <p className="text-[11px] text-slate-500">Confidence (0–1)</p>
                    <p data-testid="ollama-confidence" className="font-semibold text-cyan-300">
                      {ollamaAnalysis.analysis.confidence.toFixed(2)}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Market Regime</p>
                    <p data-testid="ollama-regime" className="font-semibold text-slate-200">
                      {ollamaAnalysis.analysis.marketRegime}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Sentiment</p>
                    <p data-testid="ollama-sentiment" className="font-semibold text-slate-200">
                      {ollamaAnalysis.analysis.sentiment}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-slate-500">Generated At</p>
                    <p className="font-medium text-slate-300">
                      {new Date(ollamaAnalysis.generatedAt).toLocaleTimeString()}
                    </p>
                  </div>
                </div>

                <p data-testid="ollama-rationale" className="text-slate-300 leading-relaxed">
                  {ollamaAnalysis.analysis.rationale}
                </p>

                {ollamaAnalysis.analysis.riskFlags.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[11px] font-semibold text-amber-300">Risk Flags</p>
                    <ul
                      data-testid="ollama-risk-flags"
                      className="list-disc pl-4 space-y-0.5 text-[11px] text-amber-200/90"
                    >
                      {ollamaAnalysis.analysis.riskFlags.map((flag, idx) => (
                        <li key={`${flag}-${idx}`}>{flag}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}

            <p className="text-[11px] text-slate-500">
              Ollama runs from the TurboScalp Node.js backend (<span className="font-mono">OLLAMA_BASE_URL</span>). Confidence is an uncalibrated model self-assessment, not measured win probability.
            </p>
          </div>

          {/* Open Positions, Actual Binance Entry & Algo Order IDs */}
          <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-4 space-y-3">
            <div className="flex items-center justify-between border-b border-slate-800/80 pb-2.5">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-cyan-400" />
                <span className="text-xs font-semibold text-white">
                  Active Demo Position &amp; Protective Algo Orders
                </span>
              </div>
              <span className="text-xs text-slate-400 tabular-nums">
                {openPosCount} Active on Exchange
              </span>
            </div>

            {activeTrade ? (
              <div className="grid grid-cols-2 gap-4 text-xs md:grid-cols-6 tabular-nums">
                <div>
                  <p className="text-[11px] text-slate-500">Contract &amp; Side</p>
                  <p className="font-bold text-white">
                    {activeTrade.symbol} · {activeTrade.side} ({activeTrade.positionMode})
                  </p>
                  <p className="text-[11px] text-slate-400">
                    Qty {activeTrade.executedQuantity} · {activeTrade.leverage}x
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500">Actual Entry Price</p>
                  <p className="font-semibold text-white">{fmtPrice(activeTrade.entryPrice)}</p>
                  <p className="text-[11px] text-slate-400">
                    Order #{activeTrade.entryOrderId ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500">Mark Price</p>
                  <p className="font-semibold text-slate-200">{fmtPrice(activeTrade.markPrice)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500">STOP_MARKET Algo</p>
                  <p className="font-semibold text-rose-300">
                    {fmtPrice(activeTrade.stopPrice)} · {activeTrade.stopStatus}
                  </p>
                  <p className="text-[10px] text-slate-500 font-mono">
                    Algo ID: {activeTrade.stopAlgoId ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500">TAKE_PROFIT Algo</p>
                  <p className="font-semibold text-emerald-300">
                    {fmtPrice(activeTrade.takeProfitPrice)} · {activeTrade.takeProfitStatus}
                  </p>
                  <p className="text-[10px] text-slate-500 font-mono">
                    Algo ID: {activeTrade.targetAlgoId ?? '—'}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500">Unrealized PnL</p>
                  <p
                    className={`font-bold ${
                      activeTrade.unrealizedPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {fmtUsd(activeTrade.unrealizedPnl)}
                  </p>
                </div>
              </div>
            ) : openPosCount > 0 ? (
              <div className="space-y-2">
                {exchangePositions
                  .filter((p) => Math.abs(Number(p.positionAmt)) > 1e-12)
                  .map((p) => (
                    <div
                      key={`${p.symbol}-${p.positionSide}`}
                      className="flex flex-wrap items-center justify-between gap-3 text-xs tabular-nums"
                    >
                      <span className="font-semibold text-white">
                        {p.symbol} ({p.positionSide || 'BOTH'}) qty={p.positionAmt} @{' '}
                        {fmtPrice(p.entryPrice)}
                      </span>
                      <span
                        className={`font-semibold ${
                          Number(p.unRealizedProfit) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        uPnL: {fmtUsd(p.unRealizedProfit)}
                      </span>
                    </div>
                  ))}
              </div>
            ) : (
              <p className="text-xs text-slate-500 py-2">
                No open Futures Demo positions. Agent 5 holds new entries until Risk Manager approval and explicit Demo Auto-Trading activation.
              </p>
            )}
          </div>
        </div>
      )}

      {/* TAB 2: Top 20 Markets Scanned */}
      {activeTab === 'SCANNER' && (
        <div className="overflow-x-auto border border-slate-800 rounded-xl">
          <table className="w-full text-left text-xs tabular-nums">
            <thead className="bg-[#080f1b] text-[11px] text-slate-400 border-b border-slate-800">
              <tr>
                <th className="px-3 py-2.5">Symbol</th>
                <th className="px-3 py-2.5 text-right">Closed Price</th>
                <th className="px-3 py-2.5 text-right">24h %</th>
                <th className="px-3 py-2.5 text-right">RSI 14</th>
                <th className="px-3 py-2.5 text-right">MACD Hist</th>
                <th className="px-3 py-2.5 text-right">Vol Ratio</th>
                <th className="px-3 py-2.5">Breakout / MTF</th>
                <th className="px-3 py-2.5 text-right">Heuristic Score</th>
                <th className="px-3 py-2.5 text-right">Signal</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {(status?.opportunities?.candidates ?? []).map((c) => (
                <tr key={c.symbol} className="hover:bg-slate-900/40">
                  <td className="px-3 py-2.5 font-semibold text-white">{c.symbol}</td>
                  <td className="px-3 py-2.5 text-right text-slate-200">{fmtPrice(c.price)}</td>
                  <td
                    className={`px-3 py-2.5 text-right ${
                      c.change24h >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {c.change24h >= 0 ? '+' : ''}
                    {c.change24h.toFixed(2)}%
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-300">{c.rsi14.toFixed(1)}</td>
                  <td className="px-3 py-2.5 text-right text-slate-300">
                    {c.macdHistogram.toFixed(4)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-300">
                    {c.volumeRatio.toFixed(2)}x
                  </td>
                  <td className="px-3 py-2.5 text-slate-400">
                    {c.breakout} · {c.mtfAligned ? 'MTF' : 'Single-TF'}
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold text-cyan-300">
                    {c.heuristicScore > 0 ? `+${c.heuristicScore}` : c.heuristicScore}
                  </td>
                  <td
                    className={`px-3 py-2.5 text-right font-bold ${
                      c.direction === 'BUY'
                        ? 'text-emerald-400'
                        : c.direction === 'SELL'
                          ? 'text-rose-400'
                          : 'text-slate-500'
                    }`}
                  >
                    {c.direction}
                  </td>
                </tr>
              ))}
              {(status?.opportunities?.candidates?.length ?? 0) === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-500">
                    Click START SCANNER to scan the top 20 liquid USD-M USDT perpetual pairs.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* TAB 3: Performance & Walk-Forward */}
      {activeTab === 'LEARNING' && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 tabular-nums">
            <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-3">
              <p className="text-[11px] text-slate-500">Closed Trades</p>
              <p className="text-base font-bold text-white mt-0.5">
                {perf?.closedTrades ?? 0}
              </p>
            </div>
            <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-3">
              <p className="text-[11px] text-slate-500">Win / Loss Rate</p>
              <p className="text-base font-bold text-cyan-300 mt-0.5">
                {perf?.winRate !== null && perf?.winRate !== undefined
                  ? `${perf.winRate}% / ${perf.lossRate ?? 0}%`
                  : '—'}
              </p>
            </div>
            <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-3">
              <p className="text-[11px] text-slate-500">Profit Factor</p>
              <p className="text-base font-bold text-slate-200 mt-0.5">
                {perf?.profitFactor ?? '—'}
              </p>
            </div>
            <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-3">
              <p className="text-[11px] text-slate-500">Max Drawdown</p>
              <p className="text-base font-bold text-rose-300 mt-0.5">
                {fmtUsd(perf?.maxDrawdownUsd ?? 0)} ({perf?.maxDrawdownPct ?? 0}%)
              </p>
            </div>
            <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-3">
              <p className="text-[11px] text-slate-500">Net Realized PnL</p>
              <p
                className={`text-base font-bold mt-0.5 ${
                  (perf?.netRealizedPnl ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                }`}
              >
                {fmtUsd(perf?.netRealizedPnl ?? 0)}
              </p>
            </div>
          </div>

          <div className="border border-slate-800 bg-[#080f1b] rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-white">
                Agent 6 Walk-Forward Validation Dataset
              </span>
              <span className="text-cyan-300">
                {perf?.walkForwardReport.status ?? 'INSUFFICIENT_SAMPLES'} · Live Risk Limits Locked
              </span>
            </div>
            <p className="text-xs text-slate-400">
              {perf?.walkForwardReport.summaryNote}
            </p>
          </div>
        </div>
      )}

      {/* TAB 4: Activity Logs */}
      {activeTab === 'LOGS' && (
        <div className="border border-slate-800 bg-[#080f1b] rounded-xl divide-y divide-slate-800/70 max-h-96 overflow-y-auto">
          {logs.map((log) => (
            <div
              key={log.id}
              className="flex flex-col gap-1 px-3.5 py-2.5 text-xs sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="flex items-start gap-2.5">
                <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                  {fmtTime(log.at)}
                </span>
                <span
                  className={`font-semibold text-[11px] shrink-0 ${
                    log.level === 'CRITICAL' || log.level === 'ERROR'
                      ? 'text-rose-400'
                      : log.level === 'WARN'
                        ? 'text-amber-300'
                        : log.level === 'TRADE'
                          ? 'text-emerald-400'
                          : 'text-cyan-300'
                  }`}
                >
                  [{log.agent}]
                </span>
                <span className="text-slate-200">{log.message}</span>
              </div>
            </div>
          ))}
          {logs.length === 0 && (
            <p className="p-6 text-center text-xs text-slate-500">
              No agent activity recorded yet. Start the scanner to inspect live runs.
            </p>
          )}
        </div>
      )}

      {/* Explicit Demo-Only Confirmation Dialog */}
      {confirmAutoModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md rounded-2xl border border-slate-700 bg-[#0b1322] p-5 space-y-4 shadow-2xl">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-5 h-5 text-emerald-400" />
                <h3 className="text-sm font-bold text-white">
                  Confirm Binance Futures DEMO Auto Trading
                </h3>
              </div>
              <button
                onClick={() => setConfirmAutoModalOpen(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2 text-xs text-slate-300 leading-relaxed">
              <p>
                Orders are submitted exclusively to{' '}
                <span className="font-mono text-cyan-300">demo-fapi.binance.com</span>. Live trading is permanently disabled.
              </p>
              <ul className="list-disc pl-4 space-y-1 text-slate-400">
                <li>Max risk per trade: 0.25% of available USDT balance</li>
                <li>Max leverage: 2x · Max order notional: 100 USDT · Max 1 open position</li>
                <li>Mandatory Algo STOP_MARKET &amp; TAKE_PROFIT_MARKET exits verified on exchange</li>
                <li>Emergency rollback closes position &amp; pauses entries if protection fails</li>
              </ul>
              {!tradingConfirmed && (
                <p className="text-rose-300 font-semibold">
                  Warning: {effectiveDiagnostics?.classificationMessage || 'Both Futures Account Can Trade (ENABLED) and Demo Futures Order Test (PASSED) must be confirmed before arming auto trading.'}
                </p>
              )}
            </div>

            <label className="flex items-start gap-2.5 rounded-lg border border-slate-800 bg-[#080f1b] p-3 text-xs text-slate-200 cursor-pointer">
              <input
                type="checkbox"
                checked={confirmChecked}
                onChange={(e) => setConfirmChecked(e.target.checked)}
                className="mt-0.5 rounded border-slate-600"
              />
              <span>
                I confirm this runs in Binance USD-M Futures DEMO ONLY and authorize Risk-Manager-approved automated Demo orders.
              </span>
            </label>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setConfirmAutoModalOpen(false)}
                className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleConfirmStartAutoTrading()}
                disabled={!confirmChecked || !tradingConfirmed || busyAction !== null}
                className="rounded-lg bg-emerald-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-emerald-400 disabled:opacity-40"
              >
                {busyAction === 'START_AUTO' ? 'Arming...' : 'Confirm & Arm Demo Auto Trading'}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
};
