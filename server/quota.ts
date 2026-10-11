/** Turns Paseo usage reports and OpenRouter data into per-pool quota state and a model price table. */
import type { Pool, RouterSettings } from "../shared/router.ts";
import type { FetchJson, ModelPrice, PoolState, QuotaSnapshot } from "./contracts.ts";

export const openRouterBaseUrl = "https://openrouter.ai/api/v1";

// Balances move with every request, so their cache is short. Prices change rarely.
const balanceTtlMs = 60_000;
const priceTtlMs = 6 * 60 * 60_000;
const modelWindowPattern = /_model_(.+)$/;
// Paseo names usage windows after the provider's own period; these are the known lengths.
const windowHours: Record<string, number> = { five_hour: 5, daily: 24, weekly: 168, monthly: 720 };

export interface UsageWindow {
  id: string;
  remainingPct?: number | null;
  usedPct?: number | null;
  resetsAt?: string | null;
}

export interface UsageEntry {
  providerId: string;
  status: "available" | "unavailable" | "error";
  planLabel: string | null;
  windows: readonly UsageWindow[];
  error?: string | null;
}

export interface QuotaDeps {
  listUsage(): Promise<{ providers: readonly UsageEntry[] }>;
  fetchJson: FetchJson;
  env: Record<string, string | undefined>;
  now(): number;
}

type Usage = { providers: readonly UsageEntry[] } | { error: string };

interface Balance {
  remainingUsd: number;
  at: number;
}

interface PriceTable {
  table: Record<string, ModelPrice>;
  at: number;
}

export class QuotaReader {
  private readonly deps: QuotaDeps;
  private readonly balances: Map<string, Balance>;
  private prices: PriceTable | null;

  constructor(deps: QuotaDeps) {
    this.deps = deps;
    this.balances = new Map();
    this.prices = null;
  }

  async read(settings: RouterSettings): Promise<QuotaSnapshot> {
    const usage = loadUsage(this.deps);
    const prices = this.readPrices();
    const states = await Promise.all(
      settings.pools.map(async (pool) =>
        pool.kind === "credits"
          ? this.readCredits(pool)
          : subscriptionState(pool, await usage, this.deps.now()),
      ),
    );
    return {
      pools: Object.fromEntries(states.map((state) => [state.poolId, state])),
      prices: await prices,
    };
  }

  private async readCredits(pool: Pool): Promise<PoolState> {
    const key = this.deps.env[pool.apiKeyEnv];
    if (!key)
      return poolState({
        poolId: pool.id,
        status: "unavailable",
        detail: `${pool.apiKeyEnv} is not set`,
      });
    try {
      const remainingUsd = await this.balance(pool.apiKeyEnv, key);
      const sign = remainingUsd < 0 ? "-" : "";
      return poolState({
        poolId: pool.id,
        status: remainingUsd <= 0 ? "exhausted" : "available",
        remainingFraction: clamp(remainingUsd / pool.fullUsd),
        remainingUsd,
        fullUsd: pool.fullUsd,
        detail: `${sign}$${Math.abs(remainingUsd).toFixed(2)} credits left`,
      });
    } catch (error) {
      return poolState({ poolId: pool.id, status: "unknown", detail: errorMessage(error) });
    }
  }

  private async balance(apiKeyEnv: string, key: string): Promise<number> {
    const cached = this.balances.get(apiKeyEnv);
    if (cached && this.deps.now() - cached.at < balanceTtlMs) return cached.remainingUsd;
    const response = await this.deps.fetchJson(`${openRouterBaseUrl}/credits`, {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
    });
    const data = (response as { data?: { total_credits?: unknown; total_usage?: unknown } } | null)
      ?.data;
    if (typeof data?.total_credits !== "number" || typeof data.total_usage !== "number") {
      throw new Error("malformed credits response");
    }
    const remainingUsd = data.total_credits - data.total_usage;
    this.balances.set(apiKeyEnv, { remainingUsd, at: this.deps.now() });
    return remainingUsd;
  }

  private async readPrices(): Promise<Record<string, ModelPrice>> {
    const now = this.deps.now();
    if (this.prices && now - this.prices.at < priceTtlMs) return this.prices.table;
    try {
      const response = await this.deps.fetchJson(`${openRouterBaseUrl}/models`, { method: "GET" });
      const table = priceTable(response);
      this.prices = { table, at: now };
      return table;
    } catch {
      // A failure keeps the old table and its timestamp, so the next read retries.
      return this.prices?.table ?? {};
    }
  }
}

function subscriptionState(pool: Pool, usage: Usage, now: number): PoolState {
  if ("error" in usage)
    return poolState({ poolId: pool.id, status: "unknown", detail: usage.error });
  const providerId = pool.usageProviderId ?? pool.id;
  const reports = usage.providers.filter((report) => report.providerId === providerId);
  const report = reports.find((candidate) => candidate.status === "available") ?? reports[0];
  if (!report) return poolState({ poolId: pool.id, status: "unknown", detail: "no usage report" });
  const planLabel = report.planLabel;
  if (report.status !== "available") {
    return poolState({
      poolId: pool.id,
      status: "unavailable",
      planLabel,
      detail: report.error ?? report.status,
    });
  }

  const modelFractions: Record<string, number> = {};
  const pooled: { window: UsageWindow; fraction: number }[] = [];
  for (const window of report.windows) {
    const fraction = windowFraction(window);
    if (fraction === null) continue;
    const model = modelWindowPattern.exec(window.id);
    if (model) modelFractions[model[1].toLowerCase()] = fraction;
    else pooled.push({ window, fraction });
  }
  if (pooled.length === 0) {
    return poolState({
      poolId: pool.id,
      status: "unknown",
      planLabel,
      modelFractions,
      detail: "no usage windows reported",
    });
  }

  const tightest = pooled.reduce((low, next) => (next.fraction < low.fraction ? next : low));
  const plan = pool.plans.find((candidate) =>
    (planLabel ?? "").toLowerCase().includes(candidate.match.toLowerCase()),
  );
  let remainingUsd: number | null = null;
  let fullUsd: number | null = null;
  for (const { window, fraction } of pooled) {
    const full = plan?.windowUsd[window.id];
    if (full === undefined) continue;
    if (remainingUsd === null || fraction * full < remainingUsd) {
      remainingUsd = fraction * full;
      fullUsd = full;
    }
  }

  const paces = pooled
    .map(({ window, fraction }) => windowPace(window, fraction, now))
    .filter((pace) => pace !== null);
  const windows = pooled
    .map(({ window, fraction }) => `${window.id} ${Math.round(fraction * 100)}%`)
    .join(", ");
  return poolState({
    poolId: pool.id,
    status: tightest.fraction <= 0 ? "exhausted" : "available",
    planLabel,
    remainingFraction: tightest.fraction,
    remainingUsd,
    fullUsd,
    modelFractions,
    resetsAt: tightest.window.resetsAt ?? null,
    pace: paces.length > 0 ? Math.min(...paces) : null,
    detail: `${planLabel ?? "no plan"}: ${windows}`,
  });
}

function windowPace(window: UsageWindow, fraction: number, now: number): number | null {
  const hours = windowHours[window.id];
  const resets = Date.parse(window.resetsAt ?? "");
  if (hours === undefined || Number.isNaN(resets)) return null;
  // The floor keeps a window that is about to reset from dividing by zero.
  const timeLeft = Math.min(1, Math.max(0.01, (resets - now) / (hours * 3_600_000)));
  return fraction / timeLeft;
}

function windowFraction(window: UsageWindow): number | null {
  if (typeof window.remainingPct === "number") return clamp(window.remainingPct / 100);
  if (typeof window.usedPct === "number") return clamp((100 - window.usedPct) / 100);
  return null;
}

// OpenRouter sends prices as decimal strings; any other shape counts as malformed.
function perTokenPrice(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return NaN;
}

function modalities(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function priceTable(response: unknown): Record<string, ModelPrice> {
  const data = (response as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) throw new Error("malformed models response");
  const table: Record<string, ModelPrice> = {};
  for (const model of data) {
    const prompt = perTokenPrice(model?.pricing?.prompt);
    const completion = perTokenPrice(model?.pricing?.completion);
    if (typeof model?.id !== "string" || !Number.isFinite(prompt) || !Number.isFinite(completion)) {
      continue;
    }
    const capabilities: string[] = [];
    if (modalities(model.architecture?.input_modalities).includes("image")) {
      capabilities.push("vision");
    }
    if (modalities(model.architecture?.output_modalities).includes("image")) {
      capabilities.push("image_generation");
    }
    table[model.id] = { costPerMTok: ((3 * prompt + completion) / 4) * 1e6, capabilities };
  }
  return table;
}

async function loadUsage(deps: QuotaDeps): Promise<Usage> {
  try {
    return await deps.listUsage();
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

function poolState(
  fields: Pick<PoolState, "poolId" | "status" | "detail"> & Partial<PoolState>,
): PoolState {
  return {
    planLabel: null,
    remainingFraction: null,
    remainingUsd: null,
    fullUsd: null,
    modelFractions: {},
    resetsAt: null,
    pace: null,
    ...fields,
  };
}

const clamp = (value: number) => Math.min(1, Math.max(0, value));

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
