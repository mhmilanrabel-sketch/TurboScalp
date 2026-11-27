import React, { useCallback, useEffect, useState } from 'react';
import {
  analyzeWithOllama,
  getOllamaStatus,
  type OllamaAnalysisResponse,
  type OllamaQuantInput,
  type OllamaStatus
} from '../services/ollamaService';

type Props = {
  symbol: string;
  quant: OllamaQuantInput | null;
};

function statusColor(status: string): string {
  if (status === 'READY') return 'text-emerald-400';
  if (status === 'MODEL_NOT_INSTALLED') return 'text-amber-400';
  return 'text-rose-400';
}

function statusLabel(status: string): string {
  if (status === 'READY') return 'READY';
  if (status === 'MODEL_NOT_INSTALLED') return 'MODEL NOT INSTALLED';
  if (status === 'OFFLINE') return 'OFFLINE';
  return status.replaceAll('_', ' ');
}

export function OllamaPanel({ symbol, quant }: Props) {
  const [status, setStatus] = useState<OllamaStatus | null>(null);
  const [analysis, setAnalysis] = useState<OllamaAnalysisResponse | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  const [loadingAnalysis, setLoadingAnalysis] = useState(false);
  const [error, setError] = useState('');

  const refreshStatus = useCallback(async () => {
    setLoadingStatus(true);
    setError('');
    try {
      const result = await getOllamaStatus();
      setStatus(result);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : 'Unable to contact TurboScalp Ollama endpoint.';
      setStatus({
        success: false,
        provider: 'OLLAMA_LOCAL',
        status: 'OFFLINE',
        model: 'qwen3.5:4b',
        installedModels: [],
        lastCheckedAt: new Date().toISOString(),
        message
      });
      setError(message);
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const runAnalysis = async () => {
    if (!quant || loadingAnalysis || status?.status !== 'READY') return;
    setLoadingAnalysis(true);
    setError('');
    setAnalysis(null);
    try {
      const result = await analyzeWithOllama(symbol, quant);
      setAnalysis(result);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Local AI analysis failed.');
    } finally {
      setLoadingAnalysis(false);
    }
  };

  const result = analysis?.analysis;

  return (
    <section className="mb-5 rounded-2xl border border-slate-800 bg-[#111a29] p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-black text-white">LOCAL AI ANALYST</h2>
          <p className="mt-1 text-[10px] text-slate-500">
            Ollama · No Gemini API · Analysis only, no order execution
          </p>
        </div>
        <div className={`text-[10px] font-black ${statusColor(status?.status || 'OFFLINE')}`}>
          {status ? statusLabel(status.status) : 'CHECKING'}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div className="rounded-xl border border-slate-800 bg-[#080d18] p-3">
          <p className="text-[9px] uppercase text-slate-500">Provider</p>
          <p className="mt-1 text-xs font-bold text-white">OLLAMA LOCAL</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#080d18] p-3">
          <p className="text-[9px] uppercase text-slate-500">Model</p>
          <p className="mt-1 break-all text-xs font-bold text-white">{status?.model || 'qwen3.5:4b'}</p>
        </div>
        <div className="rounded-xl border border-slate-800 bg-[#080d18] p-3">
          <p className="text-[9px] uppercase text-slate-500">Market selected</p>
          <p className="mt-1 text-xs font-bold text-white">{symbol}</p>
        </div>
      </div>

      {status?.message && (
        <p className="mt-3 text-[10px] leading-relaxed text-slate-400">{status.message}</p>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => void refreshStatus()}
          disabled={loadingStatus}
          className="rounded-lg border border-slate-700 bg-slate-800 px-4 py-2 text-[10px] font-bold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {loadingStatus ? 'CHECKING...' : 'CHECK LOCAL AI'}
        </button>
        <button
          type="button"
          onClick={() => void runAnalysis()}
          disabled={loadingAnalysis || status?.status !== 'READY' || !quant || quant.price <= 0}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-[10px] font-black text-black hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {loadingAnalysis ? 'ANALYSING...' : `ANALYSE ${symbol}`}
        </button>
      </div>

      {!quant && (
        <p className="mt-3 text-[10px] text-amber-400">
          Waiting for valid market price and technical indicator data.
        </p>
      )}

      {error && (
        <div className="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-[10px] leading-relaxed text-rose-300">
          {error}
        </div>
      )}

      {result && (
        <div className="mt-4 rounded-xl border border-slate-700 bg-[#080d18] p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-xs font-black text-white">{result.symbol} · {result.decision}</p>
            <span className="text-[10px] font-bold text-cyan-300">{result.marketRegime}</span>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
            <div>
              <p className="text-[9px] text-slate-500">Sentiment</p>
              <p className="mt-1 text-[10px] font-bold text-white">{result.sentiment}</p>
            </div>
            <div>
              <p className="text-[9px] text-slate-500">Model confidence</p>
              <p className="mt-1 text-[10px] font-bold text-white">{(result.confidence * 100).toFixed(0)}%</p>
            </div>
            <div>
              <p className="text-[9px] text-slate-500">Analysis time</p>
              <p className="mt-1 text-[10px] font-bold text-white">{analysis?.durationMs ?? 0} ms</p>
            </div>
          </div>
          <p className="mt-3 text-[10px] leading-relaxed text-slate-300">{result.rationale}</p>
          {result.riskFlags.length > 0 && (
            <div className="mt-3">
              <p className="mb-2 text-[9px] font-bold uppercase text-amber-400">Risk flags</p>
              <ul className="list-disc space-y-1 pl-4 text-[10px] text-amber-200">
                {result.riskFlags.map((flag, index) => <li key={`${flag}-${index}`}>{flag}</li>)}
              </ul>
            </div>
          )}
          <p className="mt-3 text-[9px] leading-relaxed text-slate-500">
            Model confidence is an uncalibrated AI self-assessment, not a probability of profit. This panel does not authorize or place trades.
            {analysis?.cached ? ' Cached result.' : ''}
          </p>
        </div>
      )}

      <p className="mt-4 border-t border-slate-800 pt-3 text-[9px] text-slate-500">
        Ollama must be reachable from the TurboScalp Node.js backend. If TurboScalp is hosted remotely, 127.0.0.1 points to that server, not your Windows PC.
      </p>
    </section>
  );
}
