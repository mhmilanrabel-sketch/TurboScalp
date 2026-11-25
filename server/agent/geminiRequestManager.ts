// server/agent/geminiRequestManager.ts
// Central Gemini AI Request Manager for TurboScalp Multi-Agent Engine
// - Primary model: GEMINI_PRIMARY_MODEL (default: gemini-4-hydrogen)
// - Optional fallback model: GEMINI_FALLBACK_MODEL (verified via API model list)
// - HTTP 503 UNAVAILABLE retry policy: max 2 retries (2s, 5s + jitter)
// - Circuit breaker for overloaded primary: 5m -> 10m -> 20m -> 30m (persisted)
// - Single recovery probe after cooldown
// - Full error taxonomy: 429 RESOURCE_EXHAUSTED, 503 UNAVAILABLE, 504 DEADLINE_EXCEEDED, 400 INVALID_ARGUMENT, 401/403
// - Never silently bypasses 429 quota exhaustion using fallback models
// - Concurrency limit 1 + in-flight dedupe + queue count + minimum request interval
// - Cache keyed by (symbol, closedCandleTime, modelId, promptVersion, featureVersion)

import fs from 'node:fs/promises';
import path from 'node:path';
import { GoogleGenAI, Type } from '@google/genai';
import type { QuantAnalysisResult } from './quantAnalyst.js';

export const GEMINI_DEFAULT_PRIMARY_MODEL = 'gemini-4-hydrogen';
export const GEMINI_MAX_DAILY_REQUESTS = 12;
export const GEMINI_PROMPT_VERSION = 'v3-503-failover';
export const GEMINI_FEATURE_VERSION = 'v2-batch3-mtf';
export const GEMINI_MAX_BATCH_SIZE = 3;
export const GEMINI_RETRY_DELAYS_MS = [2_000, 5_000] as const;
export const GEMINI_CIRCUIT_COOLDOWNS_MS = [
  5 * 60_000,
  10 * 60_000,
  20 * 60_000,
  30 * 60_000,
] as const;
export const GEMINI_MIN_INTERVAL_MS = 1_500;
export const GEMINI_QUOTA_EXHAUSTED_BANNER =
  'Gemini daily quota exhausted. Technical scanning remains available. AI-dependent automated entries are paused.';

export type GeminiManagerStatus =
  | 'STANDBY'
  | 'ACTIVE'
  | 'FALLBACK_ACTIVE'
  | 'OVERLOADED'
  | 'RECOVERING'
  | 'DEGRADED'
  | 'QUOTA_EXHAUSTED';

export type GeminiPrimaryStatus =
  | 'STANDBY'
  | 'ACTIVE'
  | 'OVERLOADED'
  | 'RECOVERING'
  | 'DEGRADED';

export type GeminiFallbackStatus = 'STANDBY' | 'ACTIVE' | 'DEGRADED' | 'DISABLED';

export type GeminiErrorCategory =
  | 'NONE'
  | 'CAPACITY_503'
  | 'QUOTA_429'
  | 'RATE_LIMIT_429'
  | 'TIMEOUT_504'
  | 'INVALID_ARGUMENT_400'
  | 'AUTH_401_403'
  | 'NETWORK_ERROR'
  | 'CONFIG_ERROR'
  | 'SCHEMA_ERROR';

export type GeminiMarketRegime = 'TRENDING' | 'SIDEWAYS' | 'VOLATILE' | 'CONFLICTED';
export type GeminiSentiment = 'BULLISH' | 'BEARISH' | 'NEUTRAL';

export interface GeminiAnalysisResult {
  symbol: string;
  available: boolean;
  degraded: boolean;
  quotaExhausted?: boolean;
  fromCache?: boolean;
  modelUsed?: string;
  usedFallback?: boolean;
  errorCategory?: GeminiErrorCategory;
  direction: 'BUY' | 'SELL' | 'HOLD';
  marketRegime: GeminiMarketRegime;
  confidence: number; // Strictly 0.0 - 1.0
  sentiment: GeminiSentiment;
  riskFlags: string[];
  reasoning: string;
  error?: string;
  analyzedAt: number;
}

export interface GeminiQuotaStatusSnapshot {
  status: GeminiManagerStatus;
  model: string;
  primaryModel: string;
  primaryStatus: GeminiPrimaryStatus;
  fallbackModel: string | null;
  fallbackVerified: boolean;
  fallbackStatus: GeminiFallbackStatus;
  fallbackActive: boolean;
  lastRespondedModel: string | null;
  requestsUsedToday: number;
  maxDailyRequests: number;
  pendingRequests: number;
  cachedAnalysesCount: number;
  lastSuccessfulAnalysisAt: number | null;
  lastApiError: string | null;
  lastErrorCode: string | null;
  lastErrorCategory: GeminiErrorCategory;
  geminiBlockedUntil: number | null;
  primaryCircuitOpenUntil: number | null;
  consecutive503Cycles: number;
  nextRetryAt: number | null;
  candidatesAwaitingAnalysis: number;
  quotaMessage: string | null;
  promptVersion: string;
  featureVersion: string;
  dateUtc: string;
}

export type GeminiBatchGeneratorFn = (params: {
  model: string;
  candidates: Array<Record<string, unknown>>;
}) => Promise<unknown>;

export type GeminiModelVerifierFn = (
  modelName: string
) => Promise<{ supported: boolean; reason?: string }>;

export interface GeminiRequestManagerOptions {
  suppliedNewsBySymbol?: Record<string, string[]>;
  batchGenerateFn?: GeminiBatchGeneratorFn;
  verifyFallbackModelFn?: GeminiModelVerifierFn;
  bypassCache?: boolean;
  nowMs?: number;
  retryDelaysMs?: readonly number[];
  jitterFn?: (maxMs: number) => number;
  minIntervalMs?: number;
  forceRecoveryProbe?: boolean;
}

interface CachedAnalysisEntry {
  cacheKey: string;
  symbol: string;
  candleTime: number;
  modelId: string;
  promptVersion: string;
  featureVersion: string;
  cachedAt: number;
  result: GeminiAnalysisResult;
}

interface PersistedGeminiQuotaState {
  version: number;
  dateUtc: string;
  primaryModel: string;
  primaryStatus: GeminiPrimaryStatus;
  fallbackModel: string | null;
  fallbackVerified: boolean;
  fallbackStatus: GeminiFallbackStatus;
  fallbackActive: boolean;
  lastRespondedModel: string | null;
  requestsUsedToday: number;
  maxDailyRequests: number;
  geminiBlockedUntil: number | null;
  primaryCircuitOpenUntil: number | null;
  consecutive503Cycles: number;
  nextRetryAt: number | null;
  lastSuccessfulAnalysisAt: number | null;
  lastApiError: string | null;
  lastErrorCode: string | null;
  lastErrorCategory: GeminiErrorCategory;
  consecutiveTransientFailures: number;
  cachedEntries: Record<string, CachedAnalysisEntry>;
}

const MAX_PERSISTED_CACHE_ENTRIES = 80;
const TRANSIENT_BASE_BACKOFF_MS = 30_000;
const TRANSIENT_MAX_BACKOFF_MS = 300_000;
const MISSING_KEY_RETRY_MS = 60_000;

export function getConfiguredPrimaryModel(): string {
  return (
    (process.env.GEMINI_PRIMARY_MODEL || '').trim() ||
    GEMINI_DEFAULT_PRIMARY_MODEL
  );
}

export function getConfiguredFallbackModel(): string | null {
  const raw = (process.env.GEMINI_FALLBACK_MODEL || '').trim();
  if (!raw) return null;
  if (raw === getConfiguredPrimaryModel()) return null;
  return raw;
}

function getQuotaStateFilePath(): string {
  return (
    process.env.TURBOSCALP_GEMINI_STATE_FILE ||
    path.resolve(process.cwd(), 'data', 'turboscalp-gemini-quota.json')
  );
}

export function utcDateKey(ms = Date.now()): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function getNextUtcMidnightMs(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() + 1,
    0,
    0,
    5,
    0
  );
}

export function buildGeminiCacheKey(
  symbol: string,
  closedCandleTime: number,
  modelId = getConfiguredPrimaryModel(),
  promptVersion = GEMINI_PROMPT_VERSION,
  featureVersion = GEMINI_FEATURE_VERSION
): string {
  return `${symbol.toUpperCase()}:${closedCandleTime}:${modelId}:${promptVersion}:${featureVersion}`;
}

function createInitialState(nowMs = Date.now()): PersistedGeminiQuotaState {
  const fallback = getConfiguredFallbackModel();
  return {
    version: 3,
    dateUtc: utcDateKey(nowMs),
    primaryModel: getConfiguredPrimaryModel(),
    primaryStatus: 'STANDBY',
    fallbackModel: fallback,
    fallbackVerified: false,
    fallbackStatus: fallback ? 'STANDBY' : 'DISABLED',
    fallbackActive: false,
    lastRespondedModel: null,
    requestsUsedToday: 0,
    maxDailyRequests: GEMINI_MAX_DAILY_REQUESTS,
    geminiBlockedUntil: null,
    primaryCircuitOpenUntil: null,
    consecutive503Cycles: 0,
    nextRetryAt: null,
    lastSuccessfulAnalysisAt: null,
    lastApiError: null,
    lastErrorCode: null,
    lastErrorCategory: 'NONE',
    consecutiveTransientFailures: 0,
    cachedEntries: {},
  };
}

let state: PersistedGeminiQuotaState = createInitialState();
let candidatesAwaitingAnalysis = 0;
let pendingRequests = 0;
let lastRequestCompletedAt = 0;
let recoveryProbeInFlight = false;
let loadedFromDisk = false;
let loadedFilePath = '';
let loadPromise: Promise<void> | null = null;
let persistChain: Promise<void> = Promise.resolve();
let dispatchMutex: Promise<unknown> = Promise.resolve();
const inFlightByCacheKey = new Map<string, Promise<GeminiAnalysisResult>>();
let cachedAiClient: { apiKey: string; client: GoogleGenAI } | null = null;
const verifiedFallbackCache = new Map<
  string,
  { supported: boolean; checkedAt: number; reason?: string }
>();

function withDispatchLock<T>(fn: () => Promise<T>): Promise<T> {
  pendingRequests += 1;
  const run = async () => {
    try {
      return await fn();
    } finally {
      pendingRequests = Math.max(0, pendingRequests - 1);
    }
  };
  const next = dispatchMutex.then(run, run);
  dispatchMutex = next.catch(() => {});
  return next;
}

function getSharedGeminiClient(apiKey: string): GoogleGenAI {
  if (!cachedAiClient || cachedAiClient.apiKey !== apiKey) {
    cachedAiClient = {
      apiKey,
      client: new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      }),
    };
  }
  return cachedAiClient.client;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rolloverDateIfNeeded(nowMs = Date.now()): boolean {
  const today = utcDateKey(nowMs);
  if (state.dateUtc !== today) {
    state.dateUtc = today;
    state.requestsUsedToday = 0;
    state.consecutiveTransientFailures = 0;
    if (!state.geminiBlockedUntil || nowMs >= state.geminiBlockedUntil) {
      state.geminiBlockedUntil = null;
      if (!state.primaryCircuitOpenUntil || nowMs >= state.primaryCircuitOpenUntil) {
        state.nextRetryAt = null;
        if (state.lastErrorCategory === 'QUOTA_429' || state.lastErrorCategory === 'RATE_LIMIT_429') {
          state.lastApiError = null;
          state.lastErrorCode = null;
          state.lastErrorCategory = 'NONE';
          state.primaryStatus = 'STANDBY';
        }
      }
    }
    return true;
  }
  return false;
}

function syncConfiguredModelsIntoState(): void {
  const currentPrimary = getConfiguredPrimaryModel();
  const currentFallback = getConfiguredFallbackModel();
  if (state.primaryModel !== currentPrimary) {
    state.primaryModel = currentPrimary;
    state.primaryStatus = 'STANDBY';
    state.primaryCircuitOpenUntil = null;
    state.consecutive503Cycles = 0;
  }
  if (state.fallbackModel !== currentFallback) {
    state.fallbackModel = currentFallback;
    state.fallbackVerified = false;
    state.fallbackActive = false;
    state.fallbackStatus = currentFallback ? 'STANDBY' : 'DISABLED';
  } else if (!currentFallback) {
    state.fallbackVerified = false;
    state.fallbackActive = false;
    state.fallbackStatus = 'DISABLED';
  }
}

function refreshCircuitAndQuotaTimers(nowMs = Date.now()): boolean {
  syncConfiguredModelsIntoState();
  let changed = rolloverDateIfNeeded(nowMs);

  // 1. Check 429 daily quota block expiry
  if (state.geminiBlockedUntil && nowMs >= state.geminiBlockedUntil) {
    state.geminiBlockedUntil = null;
    if (state.lastErrorCategory === 'QUOTA_429') {
      state.lastErrorCategory = 'NONE';
      state.lastErrorCode = null;
      state.lastApiError = null;
      state.primaryStatus = 'STANDBY';
    }
    if (!state.primaryCircuitOpenUntil) {
      state.nextRetryAt = null;
    }
    changed = true;
  }

  // 2. Check 503 circuit breaker cooldown expiry -> transition cleanly to RECOVERING (single probe)
  if (state.primaryCircuitOpenUntil) {
    if (nowMs >= state.primaryCircuitOpenUntil) {
      if (state.primaryStatus !== 'RECOVERING') {
        state.primaryStatus = 'RECOVERING';
        changed = true;
      }
      state.nextRetryAt = null;
    } else {
      if (state.primaryStatus !== 'OVERLOADED') {
        state.primaryStatus = 'OVERLOADED';
        changed = true;
      }
      if (!state.geminiBlockedUntil) {
        state.nextRetryAt = state.primaryCircuitOpenUntil;
      }
    }
  }

  // 3. Check short transient backoff expiry (RPM/TPM/504)
  if (
    !state.geminiBlockedUntil &&
    !state.primaryCircuitOpenUntil &&
    state.nextRetryAt &&
    nowMs >= state.nextRetryAt
  ) {
    state.nextRetryAt = null;
    changed = true;
  }

  return changed;
}

export async function ensureGeminiManagerLoaded(nowMs = Date.now()): Promise<void> {
  const targetPath = getQuotaStateFilePath();
  if (loadedFromDisk && loadedFilePath === targetPath) {
    refreshCircuitAndQuotaTimers(nowMs);
    return;
  }
  if (!loadPromise || loadedFilePath !== targetPath) {
    loadedFilePath = targetPath;
    loadPromise = (async () => {
      try {
        const raw = await fs.readFile(targetPath, 'utf8');
        const parsed = JSON.parse(raw) as Partial<PersistedGeminiQuotaState>;
        const fresh = createInitialState();
        const today = utcDateKey();

        state = {
          ...fresh,
          dateUtc: typeof parsed.dateUtc === 'string' ? parsed.dateUtc : today,
          primaryModel: getConfiguredPrimaryModel(),
          primaryStatus:
            parsed.primaryStatus === 'ACTIVE' ||
            parsed.primaryStatus === 'OVERLOADED' ||
            parsed.primaryStatus === 'RECOVERING' ||
            parsed.primaryStatus === 'DEGRADED' ||
            parsed.primaryStatus === 'STANDBY'
              ? parsed.primaryStatus
              : 'STANDBY',
          fallbackModel: getConfiguredFallbackModel(),
          fallbackVerified: Boolean(parsed.fallbackVerified),
          fallbackStatus:
            !getConfiguredFallbackModel()
              ? 'DISABLED'
              : parsed.fallbackStatus === 'ACTIVE' ||
                  parsed.fallbackStatus === 'DEGRADED' ||
                  parsed.fallbackStatus === 'STANDBY'
                ? parsed.fallbackStatus
                : 'STANDBY',
          fallbackActive: Boolean(parsed.fallbackActive) && Boolean(getConfiguredFallbackModel()),
          lastRespondedModel:
            typeof parsed.lastRespondedModel === 'string' ? parsed.lastRespondedModel : null,
          requestsUsedToday:
            typeof parsed.requestsUsedToday === 'number' &&
            Number.isFinite(parsed.requestsUsedToday)
              ? Math.max(0, Math.trunc(parsed.requestsUsedToday))
              : 0,
          maxDailyRequests: GEMINI_MAX_DAILY_REQUESTS,
          geminiBlockedUntil:
            typeof parsed.geminiBlockedUntil === 'number' &&
            Number.isFinite(parsed.geminiBlockedUntil)
              ? parsed.geminiBlockedUntil
              : null,
          primaryCircuitOpenUntil:
            typeof parsed.primaryCircuitOpenUntil === 'number' &&
            Number.isFinite(parsed.primaryCircuitOpenUntil)
              ? parsed.primaryCircuitOpenUntil
              : null,
          consecutive503Cycles:
            typeof parsed.consecutive503Cycles === 'number' &&
            Number.isFinite(parsed.consecutive503Cycles)
              ? Math.max(0, Math.trunc(parsed.consecutive503Cycles))
              : 0,
          nextRetryAt:
            typeof parsed.nextRetryAt === 'number' &&
            Number.isFinite(parsed.nextRetryAt)
              ? parsed.nextRetryAt
              : null,
          lastSuccessfulAnalysisAt:
            typeof parsed.lastSuccessfulAnalysisAt === 'number' &&
            Number.isFinite(parsed.lastSuccessfulAnalysisAt)
              ? parsed.lastSuccessfulAnalysisAt
              : null,
          lastApiError:
            typeof parsed.lastApiError === 'string' ? parsed.lastApiError : null,
          lastErrorCode:
            typeof parsed.lastErrorCode === 'string' ? parsed.lastErrorCode : null,
          lastErrorCategory:
            parsed.lastErrorCategory && typeof parsed.lastErrorCategory === 'string'
              ? (parsed.lastErrorCategory as GeminiErrorCategory)
              : 'NONE',
          consecutiveTransientFailures:
            typeof parsed.consecutiveTransientFailures === 'number'
              ? Math.max(0, Math.trunc(parsed.consecutiveTransientFailures))
              : 0,
          cachedEntries:
            parsed.cachedEntries && typeof parsed.cachedEntries === 'object'
              ? { ...parsed.cachedEntries }
              : {},
        };
        refreshCircuitAndQuotaTimers(nowMs);
      } catch (err: any) {
        if (err?.code !== 'ENOENT') {
          console.error('[geminiRequestManager] failed to load quota state:', err);
        }
        state = createInitialState(nowMs);
      }
      loadedFromDisk = true;
    })();
  }
  await loadPromise;
}

export function persistGeminiManagerState(): Promise<void> {
  const target = getQuotaStateFilePath();
  persistChain = persistChain
    .then(async () => {
      const dir = path.dirname(target);
      const entries = Object.entries(state.cachedEntries)
        .sort((a, b) => b[1].cachedAt - a[1].cachedAt)
        .slice(0, MAX_PERSISTED_CACHE_ENTRIES);
      state.cachedEntries = Object.fromEntries(entries);

      const snapshot: PersistedGeminiQuotaState = {
        ...state,
        primaryModel: getConfiguredPrimaryModel(),
        fallbackModel: getConfiguredFallbackModel(),
        maxDailyRequests: GEMINI_MAX_DAILY_REQUESTS,
      };
      const tmp = `${target}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await fs.rename(tmp, target);
    })
    .catch((err) => {
      console.error('[geminiRequestManager] failed to persist quota state:', err);
    });
  return persistChain;
}

export async function resetGeminiRequestManagerForTests(options: {
  clearDisk?: boolean;
} = {}): Promise<void> {
  inFlightByCacheKey.clear();
  verifiedFallbackCache.clear();
  dispatchMutex = Promise.resolve();
  pendingRequests = 0;
  lastRequestCompletedAt = 0;
  recoveryProbeInFlight = false;
  candidatesAwaitingAnalysis = 0;
  state = createInitialState();
  loadedFromDisk = false;
  loadPromise = null;
  loadedFilePath = '';
  if (options.clearDisk) {
    await fs.rm(getQuotaStateFilePath(), { force: true }).catch(() => {});
  }
}

export function clearGeminiAnalysisCacheOnly(): void {
  state.cachedEntries = {};
  inFlightByCacheKey.clear();
}

// ── Google RetryInfo & Full Error Taxonomy Classification ─────────────────

export function parseDurationToMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw) && raw > 0) {
    return Math.round(raw * 1000);
  }
  if (typeof raw !== 'string') return null;
  const text = raw.trim();
  if (!text) return null;

  const tokenRegex = /(\d+(?:\.\d+)?)\s*(ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gi;
  let totalMs = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = tokenRegex.exec(text)) !== null) {
    const val = Number(m[1]);
    const unit = m[2].toLowerCase();
    if (!Number.isFinite(val)) continue;
    matched = true;
    if (unit === 'ms') totalMs += val;
    else if (unit.startsWith('h')) totalMs += val * 3_600_000;
    else if (unit.startsWith('m')) totalMs += val * 60_000;
    else if (unit.startsWith('s')) totalMs += val * 1_000;
  }

  if (matched && totalMs > 0) {
    return Math.ceil(totalMs);
  }

  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const secs = Number(text);
    return Number.isFinite(secs) && secs > 0 ? Math.ceil(secs * 1000) : null;
  }

  return null;
}

function collectErrorFragments(err: unknown): {
  statusCode: number | null;
  rawText: string;
  retryDelayMs: number | null;
  quotaMetrics: string[];
  quotaIds: string[];
  googleStatusText: string;
} {
  const errObj = (err && typeof err === 'object' ? err : {}) as Record<string, any>;
  const statusCode =
    typeof errObj.status === 'number'
      ? errObj.status
      : typeof errObj.statusCode === 'number'
        ? errObj.statusCode
        : typeof errObj.code === 'number'
          ? errObj.code
          : null;

  const chunks: string[] = [];
  if (typeof err === 'string') chunks.push(err);
  if (typeof errObj.message === 'string') chunks.push(errObj.message);
  if (typeof errObj.statusText === 'string') chunks.push(errObj.statusText);
  if (typeof errObj.body === 'string') chunks.push(errObj.body);

  let retryDelayMs: number | null = null;
  let googleStatusText =
    typeof errObj.status === 'string'
      ? errObj.status
      : typeof errObj.error?.status === 'string'
        ? errObj.error.status
        : '';
  const quotaMetrics: string[] = [];
  const quotaIds: string[] = [];

  const inspectObject = (node: unknown, depth = 0): void => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) inspectObject(item, depth + 1);
      return;
    }
    const rec = node as Record<string, unknown>;
    if (typeof rec.retryDelay === 'string' || typeof rec.retryDelay === 'number') {
      const parsed = parseDurationToMs(rec.retryDelay);
      if (parsed && (!retryDelayMs || parsed > retryDelayMs)) {
        retryDelayMs = parsed;
      }
    }
    if (typeof rec.status === 'string' && !googleStatusText) {
      googleStatusText = rec.status;
    }
    if (typeof rec.quotaMetric === 'string') quotaMetrics.push(rec.quotaMetric);
    if (typeof rec.quotaId === 'string') quotaIds.push(rec.quotaId);
    if (typeof rec.message === 'string') chunks.push(rec.message);

    for (const val of Object.values(rec)) {
      if (val && typeof val === 'object') inspectObject(val, depth + 1);
    }
  };

  inspectObject(errObj);
  if (errObj.response) inspectObject(errObj.response);

  for (const text of [...chunks]) {
    const jsonStart = text.indexOf('{');
    if (jsonStart >= 0) {
      try {
        const parsedJson = JSON.parse(text.slice(jsonStart));
        inspectObject(parsedJson);
      } catch {
        // Ignore partial non-JSON tail
      }
    }
  }

  const combinedText = chunks.join(' | ');

  if (!retryDelayMs) {
    const retryFieldMatch = combinedText.match(/"retryDelay"\s*:\s*"([^"]+)"/i);
    if (retryFieldMatch) {
      retryDelayMs = parseDurationToMs(retryFieldMatch[1]);
    }
  }

  if (!retryDelayMs) {
    const inlineRetryMatch = combinedText.match(
      /(?:Please retry in|retry after|retryDelay[=:]\s*)\s*([0-9]+(?:\.[0-9]+)?\s*(?:ms|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?:\s*[0-9]+(?:\.[0-9]+)?\s*(?:m|min|s|sec))*)/i
    );
    if (inlineRetryMatch) {
      retryDelayMs = parseDurationToMs(inlineRetryMatch[1]);
    }
  }

  return {
    statusCode,
    rawText: combinedText || String(err || 'Unknown Gemini API error'),
    retryDelayMs,
    quotaMetrics,
    quotaIds,
    googleStatusText: googleStatusText.toUpperCase(),
  };
}

export interface ClassifiedGeminiError {
  kind:
    | 'DAILY_QUOTA_EXHAUSTED'
    | 'RATE_LIMIT_TRANSIENT'
    | 'MODEL_OVERLOADED_503'
    | 'DEADLINE_TIMEOUT_504'
    | 'INVALID_ARGUMENT_400'
    | 'AUTH_ERROR_401_403'
    | 'TRANSIENT_NETWORK'
    | 'API_ERROR';
  category: GeminiErrorCategory;
  statusCode: number | null;
  errorCode: string;
  message: string;
  retryDelayMs: number | null;
  blockedUntilMs: number;
}

export function classifyGeminiError(
  err: unknown,
  nowMs = Date.now(),
  consecutiveFailures = 0
): ClassifiedGeminiError {
  const {
    statusCode,
    rawText,
    retryDelayMs,
    quotaMetrics,
    quotaIds,
    googleStatusText,
  } = collectErrorFragments(err);
  const combinedSignals = `${rawText} ${quotaMetrics.join(' ')} ${quotaIds.join(' ')} ${googleStatusText}`;

  // 1. 401 / 403 Credential or Authorization Errors (never retry or failover)
  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /\b401\b|\b403\b|PERMISSION_DENIED|UNAUTHENTICATED|API_KEY_INVALID|API key not valid/i.test(
      combinedSignals
    )
  ) {
    return {
      kind: 'AUTH_ERROR_401_403',
      category: 'AUTH_401_403',
      statusCode: statusCode ?? 403,
      errorCode: statusCode === 401 ? '401 UNAUTHENTICATED' : '403 PERMISSION_DENIED',
      message: rawText.slice(0, 400),
      retryDelayMs: null,
      blockedUntilMs: nowMs + MISSING_KEY_RETRY_MS,
    };
  }

  // 2. 400 INVALID_ARGUMENT Configuration / Request Errors (never retry as 503)
  if (
    statusCode === 400 ||
    googleStatusText === 'INVALID_ARGUMENT' ||
    /\b400\b.*INVALID_ARGUMENT|INVALID_ARGUMENT/i.test(combinedSignals)
  ) {
    return {
      kind: 'INVALID_ARGUMENT_400',
      category: 'INVALID_ARGUMENT_400',
      statusCode: 400,
      errorCode: '400 INVALID_ARGUMENT',
      message: rawText.slice(0, 400),
      retryDelayMs: null,
      blockedUntilMs: nowMs + TRANSIENT_BASE_BACKOFF_MS,
    };
  }

  // 3. 429 RESOURCE_EXHAUSTED (Quota vs RPM/TPM rate limit; NEVER failover)
  const is429 =
    statusCode === 429 ||
    googleStatusText === 'RESOURCE_EXHAUSTED' ||
    /\b429\b/.test(combinedSignals) ||
    /RESOURCE_EXHAUSTED/i.test(combinedSignals);

  const isDailyMetric =
    /GenerateRequestsPerDayPerModel/i.test(combinedSignals) ||
    /RequestsPerDay/i.test(combinedSignals) ||
    /PerDay/i.test(combinedSignals) ||
    /free_tier_requests/i.test(combinedSignals) ||
    /daily quota/i.test(combinedSignals);

  const isPerMinuteMetric =
    /PerMinute/i.test(combinedSignals) ||
    /\bRPM\b|\bTPM\b/i.test(combinedSignals) ||
    /RequestsPerMinute/i.test(combinedSignals) ||
    /TokensPerMinute/i.test(combinedSignals);

  if (is429 && isDailyMetric && !isPerMinuteMetric) {
    const effectiveDelay =
      retryDelayMs && retryDelayMs > 0
        ? retryDelayMs
        : Math.max(60_000, getNextUtcMidnightMs(nowMs) - nowMs);
    return {
      kind: 'DAILY_QUOTA_EXHAUSTED',
      category: 'QUOTA_429',
      statusCode: 429,
      errorCode: '429 RESOURCE_EXHAUSTED (GenerateRequestsPerDayPerModel-FreeTier)',
      message: rawText.slice(0, 400),
      retryDelayMs,
      blockedUntilMs: nowMs + effectiveDelay,
    };
  }

  if (is429 && isPerMinuteMetric) {
    const expMs = Math.min(
      TRANSIENT_MAX_BACKOFF_MS,
      TRANSIENT_BASE_BACKOFF_MS * 2 ** Math.min(3, consecutiveFailures)
    );
    const delayMs = Math.min(
      TRANSIENT_MAX_BACKOFF_MS,
      Math.max(expMs, retryDelayMs ?? 0)
    );
    return {
      kind: 'RATE_LIMIT_TRANSIENT',
      category: 'RATE_LIMIT_429',
      statusCode: 429,
      errorCode: '429 RESOURCE_EXHAUSTED (RPM/TPM)',
      message: rawText.slice(0, 400),
      retryDelayMs,
      blockedUntilMs: nowMs + delayMs,
    };
  }

  if (is429) {
    if (!retryDelayMs || retryDelayMs >= 300_000) {
      const effectiveDelay =
        retryDelayMs ?? Math.max(60_000, getNextUtcMidnightMs(nowMs) - nowMs);
      return {
        kind: 'DAILY_QUOTA_EXHAUSTED',
        category: 'QUOTA_429',
        statusCode: 429,
        errorCode: '429 RESOURCE_EXHAUSTED',
        message: rawText.slice(0, 400),
        retryDelayMs,
        blockedUntilMs: nowMs + effectiveDelay,
      };
    }
    return {
      kind: 'RATE_LIMIT_TRANSIENT',
      category: 'RATE_LIMIT_429',
      statusCode: 429,
      errorCode: '429 RESOURCE_EXHAUSTED (Temporary)',
      message: rawText.slice(0, 400),
      retryDelayMs,
      blockedUntilMs: nowMs + retryDelayMs,
    };
  }

  // 4. 503 UNAVAILABLE (Google model capacity spike — eligible for 2s/5s retry + circuit breaker + verified fallback)
  if (
    statusCode === 503 ||
    googleStatusText === 'UNAVAILABLE' ||
    /\b503\b|UNAVAILABLE|currently experiencing high demand|high demand/i.test(
      combinedSignals
    )
  ) {
    return {
      kind: 'MODEL_OVERLOADED_503',
      category: 'CAPACITY_503',
      statusCode: 503,
      errorCode: '503 UNAVAILABLE',
      message: rawText.slice(0, 400),
      retryDelayMs,
      blockedUntilMs: nowMs + GEMINI_CIRCUIT_COOLDOWNS_MS[0],
    };
  }

  // 5. 504 DEADLINE_EXCEEDED / Request Timeout (distinct from 503 capacity)
  if (
    statusCode === 504 ||
    googleStatusText === 'DEADLINE_EXCEEDED' ||
    /\b504\b|DEADLINE_EXCEEDED|ETIMEDOUT|request timed out|timeout/i.test(
      combinedSignals
    )
  ) {
    const expMs = Math.min(
      TRANSIENT_MAX_BACKOFF_MS,
      20_000 * 2 ** Math.min(3, consecutiveFailures)
    );
    return {
      kind: 'DEADLINE_TIMEOUT_504',
      category: 'TIMEOUT_504',
      statusCode: 504,
      errorCode: '504 DEADLINE_EXCEEDED',
      message: rawText.slice(0, 400),
      retryDelayMs,
      blockedUntilMs: nowMs + Math.max(expMs, retryDelayMs ?? 0),
    };
  }

  // 6. Other transient network / 500 / 502 errors
  if (
    statusCode === 500 ||
    statusCode === 502 ||
    /500|502|ECONNRESET|ENOTFOUND|network/i.test(combinedSignals)
  ) {
    const expMs = Math.min(
      TRANSIENT_MAX_BACKOFF_MS,
      15_000 * 2 ** Math.min(3, consecutiveFailures)
    );
    return {
      kind: 'TRANSIENT_NETWORK',
      category: 'NETWORK_ERROR',
      statusCode,
      errorCode: statusCode ? `HTTP_${statusCode}` : 'TRANSIENT_NETWORK_ERROR',
      message: rawText.slice(0, 400),
      retryDelayMs,
      blockedUntilMs: nowMs + Math.max(expMs, retryDelayMs ?? 0),
    };
  }

  return {
    kind: 'API_ERROR',
    category: 'CONFIG_ERROR',
    statusCode,
    errorCode: statusCode ? `HTTP_${statusCode}` : 'GEMINI_API_ERROR',
    message: rawText.slice(0, 400),
    retryDelayMs,
    blockedUntilMs: nowMs + TRANSIENT_BASE_BACKOFF_MS,
  };
}

// ── Fallback Model Verification via Official Model List ───────────────────

export async function verifyFallbackModelSupport(
  fallbackModel: string | null,
  apiKey: string,
  verifyFn?: GeminiModelVerifierFn
): Promise<{ supported: boolean; reason?: string }> {
  if (!fallbackModel) {
    return { supported: false, reason: 'GEMINI_FALLBACK_MODEL is not configured.' };
  }
  if (fallbackModel === getConfiguredPrimaryModel()) {
    return {
      supported: false,
      reason: 'GEMINI_FALLBACK_MODEL matches primary model and cannot act as fallback.',
    };
  }

  const cached = verifiedFallbackCache.get(fallbackModel);
  if (cached && Date.now() - cached.checkedAt < 10 * 60_000) {
    return { supported: cached.supported, reason: cached.reason };
  }

  try {
    if (verifyFn) {
      const res = await verifyFn(fallbackModel);
      verifiedFallbackCache.set(fallbackModel, { ...res, checkedAt: Date.now() });
      return res;
    }

    if (!apiKey) {
      return {
        supported: false,
        reason: 'GEMINI_API_KEY missing; cannot verify fallback model.',
      };
    }

    const ai = getSharedGeminiClient(apiKey);
    const pager = await ai.models.list({ config: { pageSize: 100 } });
    let matchedModel: any = null;
    for await (const m of pager as any) {
      const shortName = String(m?.name || '').replace(/^models\//, '');
      if (shortName === fallbackModel || m?.name === fallbackModel) {
        matchedModel = m;
        break;
      }
    }

    if (!matchedModel) {
      const res = {
        supported: false,
        reason: `Configured GEMINI_FALLBACK_MODEL "${fallbackModel}" was not found in Google AI API model list.`,
      };
      verifiedFallbackCache.set(fallbackModel, { ...res, checkedAt: Date.now() });
      return res;
    }

    const actions: string[] = Array.isArray(matchedModel.supportedActions)
      ? matchedModel.supportedActions
      : Array.isArray(matchedModel.supportedGenerationMethods)
        ? matchedModel.supportedGenerationMethods
        : [];

    if (actions.length > 0 && !actions.includes('generateContent')) {
      const res = {
        supported: false,
        reason: `Fallback model "${fallbackModel}" does not support generateContent.`,
      };
      verifiedFallbackCache.set(fallbackModel, { ...res, checkedAt: Date.now() });
      return res;
    }

    const res = { supported: true };
    verifiedFallbackCache.set(fallbackModel, { ...res, checkedAt: Date.now() });
    return res;
  } catch (err: any) {
    return {
      supported: false,
      reason: err?.message || `Failed to verify fallback model "${fallbackModel}" against API model list.`,
    };
  }
}

// ── Strict JSON Schema Validation ────────────────────────────────────────

export function validateGeminiPayloadSchema(
  raw: unknown,
  expectedSymbol: string
): Omit<GeminiAnalysisResult, 'available' | 'degraded' | 'analyzedAt'> {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Gemini output was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  const dir = String(obj.direction || '').toUpperCase();
  if (dir !== 'BUY' && dir !== 'SELL' && dir !== 'HOLD') {
    throw new Error(`Invalid Gemini direction: ${String(obj.direction)}`);
  }

  const regimeRaw = String(obj.marketRegime || '').toUpperCase();
  const marketRegime: GeminiMarketRegime =
    regimeRaw === 'TRENDING' ||
    regimeRaw === 'SIDEWAYS' ||
    regimeRaw === 'VOLATILE' ||
    regimeRaw === 'CONFLICTED'
      ? regimeRaw
      : 'SIDEWAYS';

  const sentRaw = String(obj.sentiment || '').toUpperCase();
  const sentiment: GeminiSentiment =
    sentRaw === 'BULLISH' || sentRaw === 'BEARISH' || sentRaw === 'NEUTRAL'
      ? sentRaw
      : 'NEUTRAL';

  let confidence = Number(obj.confidence);
  if (!Number.isFinite(confidence)) {
    throw new Error('Invalid Gemini confidence value.');
  }
  if (confidence > 1) confidence = confidence / 100;
  confidence = Math.min(1, Math.max(0, Number(confidence.toFixed(3))));

  const riskFlags = Array.isArray(obj.riskFlags)
    ? obj.riskFlags.map((item) => String(item).trim()).filter(Boolean).slice(0, 8)
    : [];

  const reasoning = String(obj.reasoning || '').trim();
  if (!reasoning) {
    throw new Error('Gemini output missing reasoning string.');
  }

  return {
    symbol: expectedSymbol.toUpperCase(),
    direction: dir,
    marketRegime,
    confidence,
    sentiment,
    riskFlags,
    reasoning: reasoning.slice(0, 500),
  };
}

function buildSanitizedCandidatePayload(
  quant: QuantAnalysisResult,
  headlines: string[] = []
): Record<string, unknown> {
  // Never include Binance credentials or account secrets in any Gemini payload.
  return {
    symbol: quant.symbol,
    closedCandleTime: quant.latestClosedCandleTime,
    lastClosedPrice: quant.price,
    change24hPct: Number(quant.change24h.toFixed(2)),
    quoteVolume24hUsdt: Math.round(quant.quoteVolume),
    quantProposedDirection: quant.direction,
    heuristicScore: quant.heuristicScore,
    signalStrengthScore: quant.signalStrengthScore,
    minScoreThreshold: quant.minScoreRequired,
    trendStrength: quant.trendStrength,
    mtfAligned: quant.mtfAligned,
    indicators15m: {
      ema9: Number(quant.ema9_15m.toFixed(6)),
      ema21: Number(quant.ema21_15m.toFixed(6)),
      ema50: Number(quant.ema50_15m.toFixed(6)),
      rsi14: Number(quant.rsi14.toFixed(2)),
      macd: Number(quant.macd.toFixed(6)),
      macdSignal: Number(quant.macdSignal.toFixed(6)),
      macdHistogram: Number(quant.macdHistogram.toFixed(6)),
      atr14: Number(quant.atr14.toFixed(6)),
      volatilityPct: Number(quant.volatilityPct.toFixed(3)),
      volumeRatio: Number(quant.volumeRatio.toFixed(2)),
      supportLevel: Number(quant.supportLevel.toFixed(6)),
      resistanceLevel: Number(quant.resistanceLevel.toFixed(6)),
      breakout: quant.breakout,
      marketStructure: quant.marketStructure,
    },
    indicators5m: {
      ema9: Number(quant.ema9_5m.toFixed(6)),
      ema21: Number(quant.ema21_5m.toFixed(6)),
      ema50: Number(quant.ema50_5m.toFixed(6)),
      rsi14: Number(quant.rsi5m.toFixed(2)),
    },
    quantReasons: quant.reasons,
    verifiedNewsHeadlines: headlines,
  };
}

function makeUnavailableResult(
  symbol: string,
  params: {
    quotaExhausted: boolean;
    errorCategory: GeminiErrorCategory;
    flag: string;
    reasoning: string;
    error: string;
    modelUsed?: string;
    nowMs: number;
  }
): GeminiAnalysisResult {
  return {
    symbol,
    available: false,
    degraded: true,
    quotaExhausted: params.quotaExhausted,
    usedFallback: false,
    modelUsed: params.modelUsed ?? getConfiguredPrimaryModel(),
    errorCategory: params.errorCategory,
    direction: 'HOLD',
    marketRegime: 'SIDEWAYS',
    confidence: 0,
    sentiment: 'NEUTRAL',
    riskFlags: [params.flag],
    reasoning: params.reasoning,
    error: params.error,
    analyzedAt: params.nowMs,
  };
}

async function invokeModelGenerateBatch(params: {
  model: string;
  candidatePayloads: Array<Record<string, unknown>>;
  apiKey: string;
  batchGenerateFn?: GeminiBatchGeneratorFn;
}): Promise<unknown> {
  if (params.batchGenerateFn) {
    return params.batchGenerateFn({
      model: params.model,
      candidates: params.candidatePayloads,
    });
  }

  const ai = getSharedGeminiClient(params.apiKey);
  const response = await ai.models.generateContent({
    model: params.model,
    contents:
      `Analyze the following ${params.candidatePayloads.length} qualified Binance USD-M Futures closed-candle candidate(s) and return one separate JSON object per candidate symbol grounded ONLY in the supplied metrics:\n` +
      JSON.stringify({ candidates: params.candidatePayloads }),
    config: {
      systemInstruction:
        'You are Agent 3, a senior cryptocurrency market analyst with NO exchange execution authority. ' +
        'For EACH supplied candidate symbol, return an independent analysis entry in the analyses array. ' +
        'Never invent news headlines, macro events, or numbers outside the payload. ' +
        'Classify marketRegime as TRENDING, SIDEWAYS, VOLATILE, or CONFLICTED. ' +
        'Classify sentiment as BULLISH, BEARISH, or NEUTRAL. ' +
        'Return confidence between 0.0 and 1.0 as qualitative alignment (never claim statistical win probability). ' +
        'Recommend BUY, SELL, or HOLD and list technical conflicts or volatility riskFlags.',
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          analyses: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                symbol: { type: Type.STRING },
                direction: { type: Type.STRING, description: 'BUY, SELL, or HOLD' },
                marketRegime: {
                  type: Type.STRING,
                  description: 'TRENDING, SIDEWAYS, VOLATILE, or CONFLICTED',
                },
                confidence: {
                  type: Type.NUMBER,
                  description: 'Float between 0.0 and 1.0',
                },
                sentiment: {
                  type: Type.STRING,
                  description: 'BULLISH, BEARISH, or NEUTRAL',
                },
                riskFlags: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                reasoning: {
                  type: Type.STRING,
                  description: 'Concise 1-2 sentence explanation',
                },
              },
              required: [
                'symbol',
                'direction',
                'marketRegime',
                'confidence',
                'sentiment',
                'riskFlags',
                'reasoning',
              ],
            },
          },
        },
        required: ['analyses'],
      },
    },
  });

  const rawText = (response.text ?? '{}').trim();
  return JSON.parse(rawText);
}

async function waitForMinimumRequestInterval(
  minIntervalMs = GEMINI_MIN_INTERVAL_MS
): Promise<void> {
  if (minIntervalMs <= 0 || lastRequestCompletedAt <= 0) return;
  const elapsed = Date.now() - lastRequestCompletedAt;
  if (elapsed < minIntervalMs) {
    await sleep(minIntervalMs - elapsed);
  }
}

function getEffectiveModelForCache(nowMs = Date.now()): string {
  refreshCircuitAndQuotaTimers(nowMs);
  if (
    state.primaryCircuitOpenUntil &&
    nowMs < state.primaryCircuitOpenUntil &&
    state.fallbackModel &&
    state.fallbackVerified
  ) {
    return state.fallbackModel;
  }
  return state.primaryModel;
}

export function getGeminiQuotaStatus(nowMs = Date.now()): GeminiQuotaStatusSnapshot {
  refreshCircuitAndQuotaTimers(nowMs);

  const blockedByQuota =
    (state.geminiBlockedUntil !== null && nowMs < state.geminiBlockedUntil) ||
    state.requestsUsedToday >= GEMINI_MAX_DAILY_REQUESTS;

  const circuitOpen =
    state.primaryCircuitOpenUntil !== null &&
    nowMs < state.primaryCircuitOpenUntil;

  let overallStatus: GeminiManagerStatus;
  if (blockedByQuota) {
    overallStatus = 'QUOTA_EXHAUSTED';
  } else if (state.fallbackActive && state.fallbackStatus === 'ACTIVE' && circuitOpen) {
    overallStatus = 'FALLBACK_ACTIVE';
  } else if (circuitOpen) {
    overallStatus =
      state.fallbackModel &&
      state.fallbackStatus !== 'DEGRADED' &&
      state.fallbackStatus !== 'DISABLED'
        ? 'OVERLOADED'
        : 'DEGRADED';
  } else if (state.primaryStatus === 'RECOVERING') {
    overallStatus = 'RECOVERING';
  } else if (state.primaryStatus === 'DEGRADED') {
    overallStatus = 'DEGRADED';
  } else if (state.primaryStatus === 'ACTIVE' && state.lastSuccessfulAnalysisAt !== null) {
    overallStatus = 'ACTIVE';
  } else if (state.fallbackActive && state.fallbackStatus === 'ACTIVE' && state.lastSuccessfulAnalysisAt !== null) {
    overallStatus = 'FALLBACK_ACTIVE';
  } else {
    overallStatus = 'STANDBY';
  }

  const quotaMessage =
    overallStatus === 'QUOTA_EXHAUSTED'
      ? GEMINI_QUOTA_EXHAUSTED_BANNER
      : overallStatus === 'FALLBACK_ACTIVE'
        ? `Primary model ${state.primaryModel} overloaded (503). Fallback model ${state.fallbackModel} is handling analysis.`
        : state.lastApiError && (overallStatus === 'DEGRADED' || overallStatus === 'OVERLOADED')
          ? `Gemini AI Analyst ${overallStatus}: ${state.lastApiError}`
          : null;

  return {
    status: overallStatus,
    model: state.lastRespondedModel ?? state.primaryModel,
    primaryModel: state.primaryModel,
    primaryStatus: state.primaryStatus,
    fallbackModel: state.fallbackModel,
    fallbackVerified: state.fallbackVerified,
    fallbackStatus: state.fallbackStatus,
    fallbackActive: state.fallbackActive,
    lastRespondedModel: state.lastRespondedModel,
    requestsUsedToday: state.requestsUsedToday,
    maxDailyRequests: GEMINI_MAX_DAILY_REQUESTS,
    pendingRequests,
    cachedAnalysesCount: Object.keys(state.cachedEntries).length,
    lastSuccessfulAnalysisAt: state.lastSuccessfulAnalysisAt,
    lastApiError: state.lastApiError,
    lastErrorCode: state.lastErrorCode,
    lastErrorCategory: state.lastErrorCategory,
    geminiBlockedUntil: state.geminiBlockedUntil,
    primaryCircuitOpenUntil: state.primaryCircuitOpenUntil,
    consecutive503Cycles: state.consecutive503Cycles,
    nextRetryAt:
      state.geminiBlockedUntil ??
      state.primaryCircuitOpenUntil ??
      state.nextRetryAt,
    candidatesAwaitingAnalysis,
    quotaMessage,
    promptVersion: GEMINI_PROMPT_VERSION,
    featureVersion: GEMINI_FEATURE_VERSION,
    dateUtc: state.dateUtc,
  };
}

export function setGeminiAwaitingCandidatesCount(count: number): void {
  candidatesAwaitingAnalysis = Math.max(0, Math.trunc(count));
}

export function getCachedGeminiAnalysis(
  symbol: string,
  closedCandleTime: number,
  modelId = getEffectiveModelForCache(),
  promptVersion = GEMINI_PROMPT_VERSION,
  featureVersion = GEMINI_FEATURE_VERSION
): GeminiAnalysisResult | null {
  const key = buildGeminiCacheKey(
    symbol,
    closedCandleTime,
    modelId,
    promptVersion,
    featureVersion
  );
  const hit = state.cachedEntries[key];
  if (!hit) return null;
  return {
    ...hit.result,
    fromCache: true,
  };
}

export interface BatchAnalysisOutcome {
  resultsBySymbol: Map<string, GeminiAnalysisResult>;
  requestsDispatched: number;
  cacheHits: number;
  awaitingAnalysisCount: number;
  quotaStatus: GeminiQuotaStatusSnapshot;
}

export async function analyzeCandidatesWithManager(
  candidates: QuantAnalysisResult[],
  options: GeminiRequestManagerOptions = {}
): Promise<BatchAnalysisOutcome> {
  const now = options.nowMs ?? Date.now();
  await ensureGeminiManagerLoaded(now);
  refreshCircuitAndQuotaTimers(now);

  const uniqueCandidates: QuantAnalysisResult[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!seen.has(c.symbol)) {
      seen.add(c.symbol);
      uniqueCandidates.push(c);
    }
  }

  const activeCacheModel = getEffectiveModelForCache(now);
  const resultsBySymbol = new Map<string, GeminiAnalysisResult>();
  const uncached: QuantAnalysisResult[] = [];
  let cacheHits = 0;

  // 1. Check cache keyed by (symbol, closedCandleTime, modelId, promptVersion, featureVersion)
  for (const c of uniqueCandidates) {
    if (!options.bypassCache) {
      const hit =
        getCachedGeminiAnalysis(c.symbol, c.latestClosedCandleTime, state.primaryModel) ??
        (state.fallbackModel && state.fallbackActive
          ? getCachedGeminiAnalysis(c.symbol, c.latestClosedCandleTime, state.fallbackModel)
          : null);
      if (hit) {
        resultsBySymbol.set(c.symbol, hit);
        cacheHits++;
        continue;
      }
    }
    uncached.push(c);
  }

  candidatesAwaitingAnalysis = uncached.length;

  if (uncached.length === 0) {
    return {
      resultsBySymbol,
      requestsDispatched: 0,
      cacheHits,
      awaitingAnalysisCount: 0,
      quotaStatus: getGeminiQuotaStatus(now),
    };
  }

  // 2. Deduplicate identical concurrent in-flight analyses
  const remainingNeedDispatch: QuantAnalysisResult[] = [];
  const joinedInFlight: Array<{ symbol: string; promise: Promise<GeminiAnalysisResult> }> = [];

  for (const c of uncached) {
    const key = buildGeminiCacheKey(c.symbol, c.latestClosedCandleTime, activeCacheModel);
    const existing = inFlightByCacheKey.get(key);
    if (existing) {
      joinedInFlight.push({ symbol: c.symbol, promise: existing });
    } else {
      remainingNeedDispatch.push(c);
    }
  }

  if (remainingNeedDispatch.length === 0 && joinedInFlight.length > 0) {
    const settled = await Promise.all(
      joinedInFlight.map(async (item) => ({
        symbol: item.symbol,
        result: await item.promise,
      }))
    );
    for (const entry of settled) {
      resultsBySymbol.set(entry.symbol, entry.result);
    }
    const stillUncached = uncached.filter(
      (c) => !resultsBySymbol.get(c.symbol)?.available
    ).length;
    candidatesAwaitingAnalysis = stillUncached;
    return {
      resultsBySymbol,
      requestsDispatched: 0,
      cacheHits,
      awaitingAnalysisCount: stillUncached,
      quotaStatus: getGeminiQuotaStatus(Date.now()),
    };
  }

  const batchSlice = remainingNeedDispatch.slice(0, GEMINI_MAX_BATCH_SIZE);
  const deferredSlice = remainingNeedDispatch.slice(GEMINI_MAX_BATCH_SIZE);

  const resolvers = new Map<string, (res: GeminiAnalysisResult) => void>();
  for (const c of batchSlice) {
    const key = buildGeminiCacheKey(c.symbol, c.latestClosedCandleTime, activeCacheModel);
    const p = new Promise<GeminiAnalysisResult>((resolve) => {
      resolvers.set(key, resolve);
    });
    inFlightByCacheKey.set(key, p);
  }

  let requestsDispatched = 0;

  const resolveBatchItem = (symbol: string, candleTime: number, res: GeminiAnalysisResult) => {
    const kActive = buildGeminiCacheKey(symbol, candleTime, activeCacheModel);
    resultsBySymbol.set(symbol, res);
    resolvers.get(kActive)?.(res);
  };

  try {
    await withDispatchLock(async () => {
      const lockNow = options.nowMs ?? Date.now();
      refreshCircuitAndQuotaTimers(lockNow);

      // Re-check cache after acquiring single-instance dispatch lock
      const stillToFetch: QuantAnalysisResult[] = [];
      for (const c of batchSlice) {
        if (!options.bypassCache) {
          const hit =
            getCachedGeminiAnalysis(c.symbol, c.latestClosedCandleTime, state.primaryModel) ??
            (state.fallbackModel && state.fallbackActive
              ? getCachedGeminiAnalysis(c.symbol, c.latestClosedCandleTime, state.fallbackModel)
              : null);
          if (hit) {
            resolveBatchItem(c.symbol, c.latestClosedCandleTime, hit);
            cacheHits++;
            continue;
          }
        }
        stillToFetch.push(c);
      }

      if (stillToFetch.length === 0) return;

      // Gate 1: Strict 429 daily quota exhaustion block (NO fallback bypass allowed!)
      if (state.geminiBlockedUntil && lockNow < state.geminiBlockedUntil) {
        for (const c of stillToFetch) {
          resolveBatchItem(
            c.symbol,
            c.latestClosedCandleTime,
            makeUnavailableResult(c.symbol, {
              quotaExhausted: true,
              errorCategory: 'QUOTA_429',
              flag: 'AI_QUOTA_EXHAUSTED',
              reasoning: GEMINI_QUOTA_EXHAUSTED_BANNER,
              error:
                state.lastApiError ||
                `Quota blocked until ${new Date(state.geminiBlockedUntil).toISOString()}`,
              nowMs: lockNow,
            })
          );
        }
        return;
      }

      if (state.requestsUsedToday >= GEMINI_MAX_DAILY_REQUESTS) {
        const blockedUntil = getNextUtcMidnightMs(lockNow);
        state.geminiBlockedUntil = blockedUntil;
        state.nextRetryAt = blockedUntil;
        state.lastErrorCode = 'DAILY_CAP_12_REACHED';
        state.lastErrorCategory = 'QUOTA_429';
        state.lastApiError = `Daily limit reached (${state.requestsUsedToday}/${GEMINI_MAX_DAILY_REQUESTS} requests used).`;
        await persistGeminiManagerState();

        for (const c of stillToFetch) {
          resolveBatchItem(
            c.symbol,
            c.latestClosedCandleTime,
            makeUnavailableResult(c.symbol, {
              quotaExhausted: true,
              errorCategory: 'QUOTA_429',
              flag: 'AI_QUOTA_EXHAUSTED',
              reasoning: GEMINI_QUOTA_EXHAUSTED_BANNER,
              error: state.lastApiError,
              nowMs: lockNow,
            })
          );
        }
        return;
      }

      // Gate 2: Short transient RPM/504 backoff
      if (
        !state.primaryCircuitOpenUntil &&
        state.nextRetryAt &&
        lockNow < state.nextRetryAt
      ) {
        const reason =
          state.lastApiError ||
          `Gemini backoff active until ${new Date(state.nextRetryAt).toISOString()}`;
        for (const c of stillToFetch) {
          resolveBatchItem(
            c.symbol,
            c.latestClosedCandleTime,
            makeUnavailableResult(c.symbol, {
              quotaExhausted: false,
              errorCategory: state.lastErrorCategory || 'NETWORK_ERROR',
              flag: 'AI_DEGRADED_BACKOFF',
              reasoning: `AI Market Analyst DEGRADED: ${reason}`,
              error: reason,
              nowMs: lockNow,
            })
          );
        }
        return;
      }

      const apiKey = (process.env.GEMINI_API_KEY || '').trim();
      if (!options.batchGenerateFn && !apiKey) {
        state.primaryStatus = 'DEGRADED';
        state.lastErrorCode = 'MISSING_GEMINI_API_KEY';
        state.lastErrorCategory = 'CONFIG_ERROR';
        state.lastApiError = 'GEMINI_API_KEY is not configured on the backend server.';
        state.nextRetryAt = lockNow + MISSING_KEY_RETRY_MS;
        await persistGeminiManagerState();

        for (const c of stillToFetch) {
          resolveBatchItem(
            c.symbol,
            c.latestClosedCandleTime,
            makeUnavailableResult(c.symbol, {
              quotaExhausted: false,
              errorCategory: 'CONFIG_ERROR',
              flag: 'AI_DEGRADED_MISSING_KEY',
              reasoning:
                'GEMINI_API_KEY is not configured on the backend; AI Analyst is DEGRADED.',
              error: state.lastApiError,
              nowMs: lockNow,
            })
          );
        }
        return;
      }

      const candidatePayloads = stillToFetch.map((c) =>
        buildSanitizedCandidatePayload(
          c,
          options.suppliedNewsBySymbol?.[c.symbol] ?? []
        )
      );

      // Helper to validate and cache successful model output under the ACTUAL responding model
      const handleModelSuccess = async (
        respondingModel: string,
        usedFallback: boolean,
        rawBatchResponse: unknown
      ) => {
        const itemsArray: unknown[] = Array.isArray(
          (rawBatchResponse as Record<string, unknown>)?.analyses
        )
          ? ((rawBatchResponse as Record<string, unknown>).analyses as unknown[])
          : Array.isArray(rawBatchResponse)
            ? rawBatchResponse
            : [rawBatchResponse];

        const bySymbolRaw = new Map<string, unknown>();
        for (const item of itemsArray) {
          if (item && typeof item === 'object' && 'symbol' in item) {
            const sym = String((item as Record<string, unknown>).symbol || '')
              .toUpperCase()
              .trim();
            if (sym) bySymbolRaw.set(sym, item);
          }
        }

        const completedAt = options.nowMs ?? Date.now();
        let anySuccess = false;

        for (let idx = 0; idx < stillToFetch.length; idx++) {
          const c = stillToFetch[idx];
          const candidateRaw =
            bySymbolRaw.get(c.symbol.toUpperCase()) ??
            (itemsArray.length === stillToFetch.length ? itemsArray[idx] : undefined);

          try {
            if (!candidateRaw) {
              throw new Error(`Batch response omitted candidate ${c.symbol}.`);
            }
            const validated = validateGeminiPayloadSchema(candidateRaw, c.symbol);
            const okResult: GeminiAnalysisResult = {
              ...validated,
              available: true,
              degraded: false,
              quotaExhausted: false,
              fromCache: false,
              modelUsed: respondingModel,
              usedFallback,
              errorCategory: 'NONE',
              analyzedAt: completedAt,
            };
            const storeKey = buildGeminiCacheKey(
              c.symbol,
              c.latestClosedCandleTime,
              respondingModel
            );
            const isSyntheticProbe =
              c.price === 0 && c.reasons.includes('Manual RECHECK AI health probe');
            if (!isSyntheticProbe) {
              state.cachedEntries[storeKey] = {
                cacheKey: storeKey,
                symbol: c.symbol,
                candleTime: c.latestClosedCandleTime,
                modelId: respondingModel,
                promptVersion: GEMINI_PROMPT_VERSION,
                featureVersion: GEMINI_FEATURE_VERSION,
                cachedAt: completedAt,
                result: okResult,
              };
            }
            resolveBatchItem(c.symbol, c.latestClosedCandleTime, okResult);
            anySuccess = true;
          } catch (itemErr: any) {
            const msg = itemErr?.message || `Schema validation failed for ${c.symbol}`;
            resolveBatchItem(
              c.symbol,
              c.latestClosedCandleTime,
              makeUnavailableResult(c.symbol, {
                quotaExhausted: false,
                errorCategory: 'SCHEMA_ERROR',
                flag: 'AI_DEGRADED_SCHEMA',
                reasoning: `AI Market Analyst DEGRADED: ${msg}`,
                error: msg,
                modelUsed: respondingModel,
                nowMs: completedAt,
              })
            );
          }
        }

        if (anySuccess) {
          state.lastSuccessfulAnalysisAt = completedAt;
          state.lastRespondedModel = respondingModel;
          state.consecutiveTransientFailures = 0;
          if (!usedFallback) {
            state.primaryStatus = 'ACTIVE';
            state.primaryCircuitOpenUntil = null;
            state.consecutive503Cycles = 0;
            state.fallbackActive = false;
            if (state.fallbackModel) {
              state.fallbackStatus = 'STANDBY';
            }
            state.lastApiError = null;
            state.lastErrorCode = null;
            state.lastErrorCategory = 'NONE';
            state.nextRetryAt = null;
          } else {
            state.fallbackVerified = true;
            state.fallbackStatus = 'ACTIVE';
            state.fallbackActive = true;
            // Preserve primary 503 overload info accurately while fallback serves analysis
          }
          if (state.requestsUsedToday >= GEMINI_MAX_DAILY_REQUESTS) {
            state.geminiBlockedUntil = getNextUtcMidnightMs(completedAt);
            state.nextRetryAt = state.geminiBlockedUntil;
          }
        }
        await persistGeminiManagerState();
      };

      // Helper for Safe Single-Shot Fallback Execution (ONLY allowed on primary 503 capacity failure)
      const tryVerifiedFallbackOnce = async (
        primaryErrClassified: ClassifiedGeminiError
      ): Promise<boolean> => {
        const fbModel = state.fallbackModel;
        if (!fbModel) {
          state.fallbackStatus = 'DISABLED';
          state.fallbackActive = false;
          return false;
        }
        if (state.requestsUsedToday >= GEMINI_MAX_DAILY_REQUESTS) {
          return false;
        }

        const verification = await verifyFallbackModelSupport(
          fbModel,
          apiKey,
          options.verifyFallbackModelFn
        );
        if (!verification.supported) {
          state.fallbackVerified = false;
          state.fallbackStatus = 'DEGRADED';
          state.fallbackActive = false;
          state.lastApiError = `${primaryErrClassified.errorCode}: ${primaryErrClassified.message} | Fallback invalid: ${verification.reason}`;
          await persistGeminiManagerState();
          return false;
        }

        state.fallbackVerified = true;
        await waitForMinimumRequestInterval(options.minIntervalMs ?? GEMINI_MIN_INTERVAL_MS);
        state.requestsUsedToday += 1;
        requestsDispatched += 1;
        await persistGeminiManagerState();

        try {
          const fbRaw = await invokeModelGenerateBatch({
            model: fbModel,
            candidatePayloads,
            apiKey,
            batchGenerateFn: options.batchGenerateFn,
          });
          lastRequestCompletedAt = Date.now();
          await handleModelSuccess(fbModel, true, fbRaw);
          return true;
        } catch (fbErr: any) {
          lastRequestCompletedAt = Date.now();
          const fbClassified = classifyGeminiError(
            fbErr,
            options.nowMs ?? Date.now(),
            state.consecutiveTransientFailures
          );
          state.fallbackStatus = 'DEGRADED';
          state.fallbackActive = false;
          state.lastErrorCode = `${primaryErrClassified.errorCode} / FALLBACK_${fbClassified.errorCode}`;
          state.lastErrorCategory = fbClassified.category;
          state.lastApiError = `Primary ${primaryErrClassified.errorCode}; Fallback (${fbModel}) failed: ${fbClassified.message}`;
          if (fbClassified.kind === 'DAILY_QUOTA_EXHAUSTED') {
            state.geminiBlockedUntil = fbClassified.blockedUntilMs;
            state.nextRetryAt = fbClassified.blockedUntilMs;
          }
          await persistGeminiManagerState();
          return false;
        }
      };

      // Check whether primary circuit breaker is open (cooldown not yet expired & not forcing probe)
      const circuitOpenAndUnexpired =
        state.primaryCircuitOpenUntil !== null &&
        lockNow < state.primaryCircuitOpenUntil &&
        !options.forceRecoveryProbe;

      if (circuitOpenAndUnexpired) {
        state.primaryStatus = 'OVERLOADED';
        const openPrimaryErr: ClassifiedGeminiError = {
          kind: 'MODEL_OVERLOADED_503',
          category: 'CAPACITY_503',
          statusCode: 503,
          errorCode: '503 UNAVAILABLE (Circuit Breaker Open)',
          message:
            state.lastApiError ||
            `Primary model ${state.primaryModel} circuit breaker open until ${new Date(state.primaryCircuitOpenUntil!).toISOString()}`,
          retryDelayMs: null,
          blockedUntilMs: state.primaryCircuitOpenUntil!,
        };

        const fbOk = await tryVerifiedFallbackOnce(openPrimaryErr);
        if (!fbOk) {
          for (const c of stillToFetch) {
            resolveBatchItem(
              c.symbol,
              c.latestClosedCandleTime,
              makeUnavailableResult(c.symbol, {
                quotaExhausted: state.lastErrorCategory === 'QUOTA_429',
                errorCategory: state.lastErrorCategory || 'CAPACITY_503',
                flag: 'AI_PRIMARY_OVERLOADED',
                reasoning: `AI Market Analyst DEGRADED: ${state.lastApiError || openPrimaryErr.message}`,
                error: state.lastApiError || openPrimaryErr.message,
                nowMs: lockNow,
              })
            );
          }
        }
        return;
      }

      // If primary was in cooldown expiry or RECOVERING state, enforce single recovery probe lock
      const isRecoveryAttempt =
        state.primaryStatus === 'RECOVERING' ||
        state.primaryStatus === 'OVERLOADED' ||
        Boolean(options.forceRecoveryProbe);
      if (isRecoveryAttempt) {
        if (recoveryProbeInFlight) {
          for (const c of stillToFetch) {
            resolveBatchItem(
              c.symbol,
              c.latestClosedCandleTime,
              makeUnavailableResult(c.symbol, {
                quotaExhausted: false,
                errorCategory: 'CAPACITY_503',
                flag: 'AI_RECOVERY_PROBE_BUSY',
                reasoning: 'Single Gemini primary recovery probe is already in progress.',
                error: 'Recovery probe already active',
                nowMs: lockNow,
              })
            );
          }
          return;
        }
        recoveryProbeInFlight = true;
        state.primaryStatus = 'RECOVERING';
      }

      try {
        // Attempt primary model with central HTTP 503 retry policy:
        // Initial attempt + max 2 retries (2s, 5s + jitter) on 503 ONLY.
        // If recovering from circuit breaker, allow only 1 recovery probe without retry burst.
        const maxRetries = isRecoveryAttempt ? 0 : GEMINI_RETRY_DELAYS_MS.length;
        const retrySchedule = options.retryDelaysMs ?? GEMINI_RETRY_DELAYS_MS;
        let lastPrimaryErr: ClassifiedGeminiError | null = null;
        let primarySucceeded = false;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          if (state.requestsUsedToday >= GEMINI_MAX_DAILY_REQUESTS) {
            lastPrimaryErr = {
              kind: 'DAILY_QUOTA_EXHAUSTED',
              category: 'QUOTA_429',
              statusCode: 429,
              errorCode: 'DAILY_CAP_12_REACHED',
              message: `Daily limit (${GEMINI_MAX_DAILY_REQUESTS}/day) reached mid-cycle.`,
              retryDelayMs: null,
              blockedUntilMs: getNextUtcMidnightMs(Date.now()),
            };
            break;
          }

          if (attempt > 0) {
            const baseDelay = retrySchedule[attempt - 1] ?? 5_000;
            const jitter = options.jitterFn
              ? options.jitterFn(Math.min(500, Math.round(baseDelay * 0.2)))
              : Math.floor(Math.random() * Math.min(500, Math.round(baseDelay * 0.2)));
            await sleep(baseDelay + jitter);
          }

          await waitForMinimumRequestInterval(options.minIntervalMs ?? GEMINI_MIN_INTERVAL_MS);
          state.requestsUsedToday += 1;
          requestsDispatched += 1;
          await persistGeminiManagerState();

          try {
            const primaryRaw = await invokeModelGenerateBatch({
              model: state.primaryModel,
              candidatePayloads,
              apiKey,
              batchGenerateFn: options.batchGenerateFn,
            });
            lastRequestCompletedAt = Date.now();
            await handleModelSuccess(state.primaryModel, false, primaryRaw);
            primarySucceeded = true;
            break;
          } catch (attemptErr: any) {
            lastRequestCompletedAt = Date.now();
            const classified = classifyGeminiError(
              attemptErr,
              options.nowMs ?? Date.now(),
              state.consecutiveTransientFailures
            );
            lastPrimaryErr = classified;

            // ONLY HTTP 503 UNAVAILABLE qualifies for retry loop (2s, 5s + jitter)
            if (classified.kind === 'MODEL_OVERLOADED_503' && attempt < maxRetries) {
              continue;
            }
            break;
          }
        }

        if (primarySucceeded) return;

        // Primary failed
        const errNow = options.nowMs ?? Date.now();
        const finalErr =
          lastPrimaryErr ??
          classifyGeminiError(new Error('Primary model request failed'), errNow);

        state.lastApiError = finalErr.message;
        state.lastErrorCode = finalErr.errorCode;
        state.lastErrorCategory = finalErr.category;

        if (finalErr.kind === 'MODEL_OVERLOADED_503') {
          // Open / escalate circuit breaker: 5m -> 10m -> 20m -> max 30m
          const cycleIdx = Math.min(
            GEMINI_CIRCUIT_COOLDOWNS_MS.length - 1,
            state.consecutive503Cycles
          );
          const cooldownMs = GEMINI_CIRCUIT_COOLDOWNS_MS[cycleIdx];
          state.consecutive503Cycles += 1;
          state.primaryStatus = 'OVERLOADED';
          state.primaryCircuitOpenUntil = errNow + cooldownMs;
          state.nextRetryAt = state.primaryCircuitOpenUntil;
          await persistGeminiManagerState();

          // Attempt safe verified fallback model ONCE (only on 503 overload, never on 429)
          const fbSucceeded = await tryVerifiedFallbackOnce(finalErr);
          if (fbSucceeded) return;
        } else if (finalErr.kind === 'DAILY_QUOTA_EXHAUSTED') {
          // Strictly NO fallback bypass on 429 daily quota exhaustion
          state.primaryStatus = 'DEGRADED';
          state.fallbackActive = false;
          state.geminiBlockedUntil = finalErr.blockedUntilMs;
          state.nextRetryAt = finalErr.blockedUntilMs;
          await persistGeminiManagerState();
        } else {
          // 429 RPM/TPM, 504 DEADLINE_EXCEEDED, 400 INVALID_ARGUMENT, 401/403 AUTH, or network error
          state.primaryStatus = 'DEGRADED';
          state.fallbackActive = false;
          state.consecutiveTransientFailures += 1;
          state.nextRetryAt = finalErr.blockedUntilMs;
          await persistGeminiManagerState();
        }

        const isDailyQuota = finalErr.kind === 'DAILY_QUOTA_EXHAUSTED';
        for (const c of stillToFetch) {
          resolveBatchItem(
            c.symbol,
            c.latestClosedCandleTime,
            makeUnavailableResult(c.symbol, {
              quotaExhausted: isDailyQuota,
              errorCategory: state.lastErrorCategory,
              flag: isDailyQuota
                ? 'AI_QUOTA_EXHAUSTED'
                : finalErr.kind === 'MODEL_OVERLOADED_503'
                  ? 'AI_OVERLOADED_DEGRADED'
                  : `AI_${state.lastErrorCategory}`,
              reasoning: isDailyQuota
                ? GEMINI_QUOTA_EXHAUSTED_BANNER
                : `AI Market Analyst DEGRADED (${finalErr.errorCode}): ${finalErr.message}`,
              error: state.lastApiError || finalErr.message,
              modelUsed: state.primaryModel,
              nowMs: errNow,
            })
          );
        }
      } finally {
        if (isRecoveryAttempt) {
          recoveryProbeInFlight = false;
        }
      }
    });

    if (joinedInFlight.length > 0) {
      const joinedSettled = await Promise.all(
        joinedInFlight.map(async (item) => ({
          symbol: item.symbol,
          result: await item.promise,
        }))
      );
      for (const entry of joinedSettled) {
        if (!resultsBySymbol.has(entry.symbol)) {
          resultsBySymbol.set(entry.symbol, entry.result);
        }
      }
    }

    for (const d of deferredSlice) {
      if (!resultsBySymbol.has(d.symbol)) {
        resultsBySymbol.set(
          d.symbol,
          makeUnavailableResult(d.symbol, {
            quotaExhausted: Boolean(
              state.geminiBlockedUntil && Date.now() < state.geminiBlockedUntil
            ),
            errorCategory: state.lastErrorCategory,
            flag: 'AI_DEFERRED_BATCH_LIMIT',
            reasoning:
              'Candidate queued behind top 3 batched Gemini analyses to conserve quota.',
            error: 'Queued in batch limit (max 3 per Gemini request)',
            nowMs: Date.now(),
          })
        );
      }
    }
  } finally {
    for (const c of batchSlice) {
      const key = buildGeminiCacheKey(c.symbol, c.latestClosedCandleTime, activeCacheModel);
      inFlightByCacheKey.delete(key);
    }
  }

  const awaitingAfter = uniqueCandidates.filter((c) => {
    const res = resultsBySymbol.get(c.symbol);
    return !res || (!res.available && !res.fromCache);
  }).length;
  candidatesAwaitingAnalysis = awaitingAfter;

  return {
    resultsBySymbol,
    requestsDispatched,
    cacheHits,
    awaitingAnalysisCount: awaitingAfter,
    quotaStatus: getGeminiQuotaStatus(options.nowMs ?? Date.now()),
  };
}

let recheckBusy = false;

export async function recheckGeminiAvailability(
  candidates: QuantAnalysisResult[] = [],
  options: GeminiRequestManagerOptions = {}
): Promise<GeminiQuotaStatusSnapshot> {
  const now = options.nowMs ?? Date.now();
  await ensureGeminiManagerLoaded(now);
  refreshCircuitAndQuotaTimers(now);

  if (recheckBusy) {
    return getGeminiQuotaStatus(now);
  }
  recheckBusy = true;

  try {
    // Never bypass 429 daily quota block on RECHECK AI
    if (
      (state.geminiBlockedUntil && now < state.geminiBlockedUntil) ||
      state.requestsUsedToday >= GEMINI_MAX_DAILY_REQUESTS
    ) {
      return getGeminiQuotaStatus(now);
    }

    // Also verify fallback model support if configured (non-generation list call)
    const apiKey = (process.env.GEMINI_API_KEY || '').trim();
    if (state.fallbackModel && (apiKey || options.verifyFallbackModelFn)) {
      const fbCheck = await verifyFallbackModelSupport(
        state.fallbackModel,
        apiKey,
        options.verifyFallbackModelFn
      );
      state.fallbackVerified = fbCheck.supported;
      if (!fbCheck.supported) {
        state.fallbackStatus = 'DEGRADED';
      } else if (!state.fallbackActive) {
        state.fallbackStatus = 'STANDBY';
      }
      await persistGeminiManagerState();
    }

    // Run either queued qualified candidate batch (up to 3) OR a tiny single-symbol closed-candle health probe
    const probeTarget: QuantAnalysisResult[] =
      candidates.length > 0
        ? candidates.slice(0, GEMINI_MAX_BATCH_SIZE)
        : [
            {
              symbol: 'BTCUSDT',
              direction: 'HOLD',
              heuristicScore: 0,
              signalStrengthScore: 0,
              minScoreRequired: 65,
              price: 0,
              change24h: 0,
              quoteVolume: 0,
              ema9_15m: 0,
              ema21_15m: 0,
              ema50_15m: 0,
              ema9_5m: 0,
              ema21_5m: 0,
              ema50_5m: 0,
              rsi14: 50,
              rsi5m: 50,
              macd: 0,
              macdSignal: 0,
              macdHistogram: 0,
              atr14: 0,
              volatilityPct: 0,
              volumeRatio: 1,
              trendStrength: 0,
              supportLevel: 0,
              resistanceLevel: 0,
              breakout: 'NONE',
              mtfAligned: false,
              marketStructure: 'RANGING',
              unusualVolume: false,
              unusualVolatility: false,
              stopLoss: null,
              takeProfit: null,
              reasons: ['Manual RECHECK AI health probe'],
              latestClosedCandleTime: now,
              fetchedAt: now,
            },
          ];

    const prevAwaiting = candidatesAwaitingAnalysis;
    await analyzeCandidatesWithManager(probeTarget, {
      ...options,
      bypassCache: true,
      forceRecoveryProbe: true,
    });
    if (candidates.length === 0) {
      candidatesAwaitingAnalysis = prevAwaiting;
    }

    return getGeminiQuotaStatus(options.nowMs ?? Date.now());
  } finally {
    recheckBusy = false;
  }
}
