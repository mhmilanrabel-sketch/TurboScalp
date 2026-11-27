// src/services/agentService.ts
// Typed frontend API client for the Multi-Agent Autonomous Trading Engine (/api/agent/*).

import type {
  AgentCriticalError,
  AgentEngineConfig,
  AgentLogEntry,
  AgentPerformanceSummary,
  AgentStatusResponse,
  AgentTradeRecord,
} from '../types';

export type {
  AgentCriticalError,
  AgentEngineConfig,
  AgentHealthState,
  AgentLogEntry,
  AgentName,
  AgentPerformanceSummary,
  AgentStatusResponse,
  AgentTradeRecord,
  AgentUnitStatus,
  ApprovedOrderPlan,
  EngineRunMode,
  GeminiAnalysisResult,
  GeminiErrorCategory,
  GeminiFallbackStatus,
  GeminiManagerStatus,
  GeminiPrimaryStatus,
  GeminiQuotaStatusSnapshot,
  OpportunitySnapshot,
  QuantAnalysisResult,
  RiskCheckItem,
  RiskDecision,
  TradingPolicyMode,
} from '../types';

async function agentRequest<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok || data?.success === false) {
    throw new Error(
      data?.error || data?.message || `Agent request failed (HTTP ${response.status})`
    );
  }
  return data as T;
}

export function fetchAgentStatus(): Promise<AgentStatusResponse> {
  return agentRequest<AgentStatusResponse>('/api/agent/status');
}

export function fetchAgentLogs(limit = 150): Promise<{
  success: boolean;
  logs: AgentLogEntry[];
  criticalErrors: AgentCriticalError[];
}> {
  return agentRequest(`/api/agent/logs?limit=${limit}`);
}

export function fetchAgentPerformance(): Promise<{
  success: boolean;
  environment: string;
  performance: AgentPerformanceSummary;
  trades: AgentTradeRecord[];
  learningSamplesCount: number;
}> {
  return agentRequest('/api/agent/performance');
}

export function fetchAgentConfig(): Promise<{
  success: boolean;
  environment: string;
  liveTradingEnabled: false;
  config: AgentEngineConfig;
}> {
  return agentRequest('/api/agent/config');
}

export function updateAgentConfig(
  patch: Partial<AgentEngineConfig>
): Promise<{ success: boolean; config: AgentEngineConfig }> {
  return agentRequest('/api/agent/config', {
    method: 'POST',
    body: JSON.stringify(patch),
  });
}

export function startAgentEngine(params: {
  mode: 'SCAN_ONLY' | 'AUTO_TRADING';
  demoConfirmed?: boolean;
}): Promise<AgentStatusResponse> {
  return agentRequest<AgentStatusResponse>('/api/agent/start', {
    method: 'POST',
    body: JSON.stringify(params),
  });
}

export function pauseAgentTrading(): Promise<AgentStatusResponse> {
  return agentRequest<AgentStatusResponse>('/api/agent/pause', {
    method: 'POST',
  });
}

export function resumeAgentEngine(params?: {
  mode?: 'SCAN_ONLY' | 'AUTO_TRADING';
  demoConfirmed?: boolean;
}): Promise<AgentStatusResponse> {
  return agentRequest<AgentStatusResponse>('/api/agent/resume', {
    method: 'POST',
    body: JSON.stringify(params || {}),
  });
}

export function stopAgentNewTrades(): Promise<AgentStatusResponse> {
  return agentRequest<AgentStatusResponse>('/api/agent/stop', {
    method: 'POST',
  });
}

export function closeAgentPosition(): Promise<AgentStatusResponse & {
  alreadyFlat?: boolean;
  orderId?: number | string | null;
  message?: string;
}> {
  return agentRequest('/api/agent/position/close', {
    method: 'POST',
    body: JSON.stringify({ confirm: true }),
  });
}

export function recheckGeminiAi(): Promise<AgentStatusResponse> {
  return agentRequest<AgentStatusResponse>('/api/agent/gemini/recheck', {
    method: 'POST',
  });
}
