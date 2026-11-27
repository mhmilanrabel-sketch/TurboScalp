export type OllamaDirection = 'BUY' | 'SELL' | 'NEUTRAL' | 'HOLD';

export interface OllamaQuantInput {
  direction: OllamaDirection;
  score: number;
  price: number;
  rsi?: number | null;
  ema9?: number | null;
  ema21?: number | null;
  ema50?: number | null;
  macd?: number | null;
  macdSignal?: number | null;
  atr?: number | null;
  volumeRatio?: number | null;
  volatilityPct?: number | null;
  change24h?: number | null;
  volume24h?: number | null;
}

export interface OllamaStatus {
  success: boolean;
  provider: 'OLLAMA_LOCAL';
  status: 'READY' | 'OFFLINE' | 'MODEL_NOT_INSTALLED' | 'CONFIGURATION_ERROR' | string;
  model: string;
  installedModels: string[];
  busy?: boolean;
  lastCheckedAt: string;
  message: string;
}

export interface OllamaAnalysis {
  symbol: string;
  decision: 'BUY' | 'SELL' | 'HOLD';
  marketRegime:
    | 'TRENDING_UP'
    | 'TRENDING_DOWN'
    | 'RANGE'
    | 'HIGH_VOLATILITY'
    | 'UNKNOWN';
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'NOT_PROVIDED';
  confidence: number;
  riskFlags: string[];
  rationale: string;
}

export interface OllamaAnalysisResponse {
  success: true;
  provider: 'OLLAMA_LOCAL';
  model: string;
  analysis: OllamaAnalysis;
  generatedAt: string;
  durationMs: number;
  cached: boolean;
  note: string;
}

export class OllamaApiError extends Error {
  statusCode: number;
  code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.name = 'OllamaApiError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

async function apiRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...init.headers,
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false) {
    const message =
      typeof data?.message === 'string'
        ? data.message
        : `Ollama request failed (HTTP ${response.status}).`;
    const code = typeof data?.code === 'string' ? data.code : undefined;
    throw new OllamaApiError(message, response.status, code);
  }
  return data as T;
}

export async function getOllamaStatus(): Promise<OllamaStatus> {
  // A 503 is an expected health state when Ollama is offline or the model
  // is not installed. Preserve its diagnostic JSON instead of throwing it away.
  const response = await fetch('/api/agent/ollama/status', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  const data = await response.json().catch(() => ({}));
  if (!data || typeof data !== 'object' || typeof data.status !== 'string') {
    throw new OllamaApiError(
      `Invalid Ollama status response (HTTP ${response.status}).`,
      response.status
    );
  }
  return data as OllamaStatus;
}

export function analyzeWithOllama(
  symbol: string,
  quant: OllamaQuantInput
): Promise<OllamaAnalysisResponse> {
  return apiRequest<OllamaAnalysisResponse>('/api/agent/ollama/analyze', {
    method: 'POST',
    body: JSON.stringify({ symbol, quant }),
  });
}
