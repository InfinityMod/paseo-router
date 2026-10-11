/** Internal seams between quota reading, classification, selection and the create hook. */
import type { Route, RoutingMode, Tier } from "../shared/router.ts";

export interface PoolState {
  poolId: string;
  /** "unknown": the provider reports no usable quota data, so the pool stays eligible. */
  status: "available" | "exhausted" | "unavailable" | "unknown";
  planLabel: string | null;
  /** Remaining share of the tightest pool-wide window, 0 to 1. */
  remainingFraction: number | null;
  /** List-price dollars left in that window, or the credit balance. */
  remainingUsd: number | null;
  /** Dollar value of that window when full. */
  fullUsd: number | null;
  /** Remaining share of model-scoped windows, keyed by the model keyword in the window id. */
  modelFractions: Record<string, number>;
  resetsAt: string | null;
  /**
   * Quota left relative to time left: remaining share divided by the share of the window still
   * ahead, for the window where that is lowest. Above 1, quota expires unused at the current
   * rate. Null for credits, which never expire, and for windows of unknown length.
   */
  pace: number | null;
  detail: string;
}

export interface ModelPrice {
  /** USD per million blended tokens: (3 x prompt + completion) / 4. */
  costPerMTok: number;
  /** "vision" for image input, "image_generation" for image output. */
  capabilities: string[];
}

export interface QuotaSnapshot {
  pools: Record<string, PoolState>;
  /** Keyed by OpenRouter model id. */
  prices: Record<string, ModelPrice>;
}

/** Providers able to start a session now. Empty `models` means the catalog is unknown. */
export type ProviderCatalog = Record<string, { models: Record<string, readonly string[]> }>;

export interface TaskText {
  title: string;
  prompt: string | null;
  systemPrompt: string | null;
}

export interface Classification {
  tier: Tier;
  needs: string[];
  reason: string;
  source: "explicit" | "llm" | "heuristic";
}

export interface RouteRequest {
  mode: RoutingMode;
  tier: Tier;
  needs: readonly string[];
}

export interface Decision {
  route: Route;
  modeId: string | null;
  thinkingOptionId: string | null;
  /** Tokens the route's pool can still pay for at this route's price. */
  remainingTokens: number | null;
  reason: string;
  /** Routes passed over, as "provider/model: why". */
  rejected: string[];
}

/** HTTP seam so tests never reach the network. Resolves parsed JSON, throws on non-2xx. */
export type FetchJson = (
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
  },
) => Promise<unknown>;
