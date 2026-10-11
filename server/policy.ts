/** Pure route selection: hard gates, token affordability, difficulty bands and the mode pick. */
import type { Route, RouterSettings, RoutingMode, Tier } from "../shared/router.ts";
import { tiers } from "../shared/router.ts";
import type {
  Decision,
  ModelPrice,
  PoolState,
  ProviderCatalog,
  QuotaSnapshot,
  RouteRequest,
} from "./contracts.ts";

export class NoRouteError extends Error {
  readonly rejected: string[];

  constructor(rejected: string[]) {
    super(`No route can serve this task: ${rejected.join("; ") || "no routes configured"}`);
    this.name = "NoRouteError";
    this.rejected = rejected;
  }
}

interface Candidate {
  route: Route;
  pool: PoolState;
  cost: number | null;
  fraction: number | null;
  remainingTokens: number | null;
  trust: Trust;
  /** Subscription quota: already paid for and lost at reset, unlike credits. */
  prepaid: boolean;
}

/** Preference order: quota seen and sufficient, then quota not reported, then seen but short. */
const trustOrder = ["covered", "unknown", "short"] as const;
type Trust = (typeof trustOrder)[number];

function priceOf(route: Route, prices: QuotaSnapshot["prices"]): ModelPrice | undefined {
  return route.priceRef === undefined ? undefined : prices[route.priceRef];
}

export function routeCost(route: Route, prices: QuotaSnapshot["prices"]): number | null {
  return route.costPerMTok ?? priceOf(route, prices)?.costPerMTok ?? null;
}

export function routeCapabilities(route: Route, prices: QuotaSnapshot["prices"]): string[] {
  return [...new Set([...route.capabilities, ...(priceOf(route, prices)?.capabilities ?? [])])];
}

// A missing pool is "unknown", not "exhausted": the provider may simply not report quota.
function poolOf(quota: QuotaSnapshot, poolId: string): PoolState {
  return (
    quota.pools[poolId] ?? {
      poolId,
      status: "unknown",
      planLabel: null,
      remainingFraction: null,
      remainingUsd: null,
      fullUsd: null,
      modelFractions: {},
      resetsAt: null,
      pace: null,
      detail: "",
    }
  );
}

/** Tightest known share: the pool-wide window plus model windows whose keyword the model id contains. */
function routeFraction(route: Route, pool: PoolState): number | null {
  const model = route.model.toLowerCase();
  const known: number[] = [];
  if (pool.remainingFraction !== null) known.push(pool.remainingFraction);
  for (const [keyword, fraction] of Object.entries(pool.modelFractions)) {
    if (model.includes(keyword)) known.push(fraction);
  }
  return known.length > 0 ? Math.min(...known) : null;
}

function rejectionReason(
  route: Route,
  request: RouteRequest,
  settings: RouterSettings,
  quota: QuotaSnapshot,
  catalog: ProviderCatalog,
): string | null {
  if (!route.enabled) return "switched off in settings";
  const provider = catalog[route.provider];
  if (!provider) return "provider unavailable";
  // An empty model list means the catalog is unknown, so any model is accepted.
  if (Object.keys(provider.models).length > 0 && !Object.hasOwn(provider.models, route.model)) {
    return "model not offered";
  }
  const pool = poolOf(quota, route.pool);
  if (pool.status === "unavailable") return `pool unavailable: ${pool.detail}`;
  if (pool.status === "exhausted") return "pool exhausted";
  const fraction = routeFraction(route, pool);
  if (fraction !== null && fraction <= settings.minFraction) {
    return fraction <= 0
      ? "pool exhausted"
      : `held in reserve (${Math.round(fraction * 100)}% left)`;
  }
  const capabilities = routeCapabilities(route, quota.prices);
  const missing = request.needs.find((need) => !capabilities.includes(need));
  return missing === undefined ? null : `lacks ${missing}`;
}

function remainingTokensOf(pool: PoolState, cost: number | null): number | null {
  return pool.remainingUsd !== null && cost !== null && cost > 0
    ? (pool.remainingUsd / cost) * 1e6
    : null;
}

// Requested band first, then harder bands ascending, then easier bands descending.
function bandOrder(tier: Tier): Tier[] {
  const index = tiers.indexOf(tier);
  return [tier, ...tiers.slice(index + 1), ...tiers.slice(0, index).reverse()];
}

function pickBand(
  candidates: Candidate[],
  order: Tier[],
): { band: Tier; trust: Trust; options: Candidate[] } | null {
  for (const trust of trustOrder) {
    for (const band of order) {
      const options = candidates.filter((c) => c.route.tiers.includes(band) && c.trust === trust);
      if (options.length > 0) return { band, trust, options };
    }
  }
  return null;
}

function compareCost(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}

/** How much quota the pool can spare: its pace when a reset is known, else its share left. */
function headroomOf(candidate: Candidate, tierTokens: number): number {
  const spend =
    candidate.pool.fullUsd && candidate.cost !== null
      ? (tierTokens * candidate.cost) / 1e6 / candidate.pool.fullUsd
      : 0;
  return (candidate.pool.pace ?? candidate.fraction ?? 0.5) - spend;
}

/** List price scaled by what spending costs later: quota that would expire is nearly free. */
function effectiveCost(candidate: Candidate): number | null {
  const { cost, prepaid, pool } = candidate;
  if (cost === null || !prepaid || pool.pace === null) return cost;
  return cost * Math.min(1, 1 / pool.pace);
}

function pickCandidate(all: Candidate[], mode: RoutingMode, tierTokens: number): Candidate {
  const byCostThenQuality = (a: Candidate, b: Candidate) =>
    compareCost(a.cost, b.cost) || b.route.quality - a.route.quality;
  if (mode === "performance") {
    return [...all].sort(
      (a, b) => b.route.quality - a.route.quality || (b.fraction ?? 0.5) - (a.fraction ?? 0.5),
    )[0];
  }
  // Credits are real money and keep; prepaid quota is lost at reset, so it is spent first.
  const prepaid = all.filter((candidate) => candidate.prepaid);
  const options = prepaid.length > 0 ? prepaid : all;
  if (mode === "economic") {
    return [...options].sort(
      (a, b) =>
        compareCost(effectiveCost(a), effectiveCost(b)) || b.route.quality - a.route.quality,
    )[0];
  }
  // Headroom within 0.05 of the best is a tie, so cost decides between near-equal pools.
  const headroom = new Map(options.map((c) => [c, headroomOf(c, tierTokens)]));
  const best = Math.max(...headroom.values());
  return options.filter((c) => (headroom.get(c) ?? 0) >= best - 0.05).sort(byCostThenQuality)[0];
}

export function selectRoute(
  request: RouteRequest,
  settings: RouterSettings,
  quota: QuotaSnapshot,
  catalog: ProviderCatalog,
): Decision {
  const rejected: string[] = [];
  const candidates: Candidate[] = [];
  const credits = new Set(
    settings.pools.filter((pool) => pool.kind === "credits").map((pool) => pool.id),
  );
  for (const route of settings.routes) {
    const reason = rejectionReason(route, request, settings, quota, catalog);
    if (reason !== null) {
      rejected.push(`${route.provider}/${route.model}: ${reason}`);
      continue;
    }
    const pool = poolOf(quota, route.pool);
    const cost = routeCost(route, quota.prices);
    const remainingTokens = remainingTokensOf(pool, cost);
    const fraction = routeFraction(route, pool);
    const short = remainingTokens !== null && remainingTokens < settings.tierTokens[request.tier];
    candidates.push({
      route,
      pool,
      cost,
      fraction,
      remainingTokens,
      // A pool that reports no quota may be empty, so pools with visible quota go first.
      trust: short ? "short" : fraction === null ? "unknown" : "covered",
      prepaid: !credits.has(route.pool),
    });
  }

  const found = pickBand(candidates, bandOrder(request.tier));
  if (found === null) throw new NoRouteError(rejected);
  if (found.trust !== "short") {
    // Budget losses hinge on estimated plan values, so name them for calibration.
    const needed = settings.tierTokens[request.tier];
    for (const { route, trust, remainingTokens } of candidates) {
      if (trust !== "short" || !route.tiers.includes(request.tier)) continue;
      rejected.push(
        `${route.provider}/${route.model}: about ${Math.floor(remainingTokens ?? 0)} tokens left, task needs ${needed}`,
      );
    }
  }

  const chosen = pickCandidate(found.options, request.mode, settings.tierTokens[request.tier]);
  const { route, fraction, remainingTokens, pool, prepaid } = chosen;
  const thinking = route.thinking[request.tier] ?? route.thinking[found.band] ?? null;
  const offered = catalog[route.provider].models[route.model] ?? [];

  const share =
    fraction === null
      ? `pool ${route.pool} quota unknown`
      : `pool ${route.pool} ${Math.round(fraction * 100)}% left`;
  let reason = `${request.mode}: ${route.provider}/${route.model} for a ${request.tier} task; ${share}`;
  if (prepaid && pool.pace !== null && pool.pace > 1) {
    reason += `, ${pool.pace.toFixed(1)}x more quota than time before it resets`;
  }
  if (found.band !== request.tier) {
    reason += `; no eligible route in "${request.tier}", used "${found.band}"`;
  }
  if (found.trust === "short") reason += "; quota may not cover the task";

  return {
    route,
    modeId: route.modeId ?? settings.providerModes[route.provider] ?? null,
    thinkingOptionId:
      thinking !== null && offered.length > 0 && !offered.includes(thinking) ? null : thinking,
    remainingTokens: remainingTokens === null ? null : Math.floor(remainingTokens),
    reason,
    rejected,
  };
}
