/** Shared contracts: routing vocabulary, the host settings document and the status RPC. */
import { defineRpc, defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/** Provider id agents select to request automatic routing, as in `auto/balanced`. */
export const autoProviderId = "auto";

export const routingModes = ["economic", "balanced", "performance"] as const;
export type RoutingMode = (typeof routingModes)[number];

/** Difficulty bands, easiest first. */
export const tiers = ["tiny", "quick", "normal", "hard"] as const;
export type Tier = (typeof tiers)[number];

const tierSchema = z.enum(tiers);

export const routeSchema = z.object({
  /** Paseo provider that runs the agent, e.g. "claude" or "omp". */
  provider: z.string().min(1),
  /** Model id inside that provider, e.g. "openrouter/z-ai/glm-5.3-flash". */
  model: z.string().min(1),
  /** Quota pool this route spends from. */
  pool: z.string().min(1),
  /** Difficulty bands this route may serve. */
  tiers: z.array(tierSchema).min(1),
  /** Relative capability, 0 to 100. Performance mode takes the highest in the band. */
  quality: z.number().min(0).max(100),
  /** OpenRouter model id whose list price and modalities describe this route. */
  priceRef: z.string().optional(),
  /** USD per million blended tokens. Overrides the `priceRef` list price. */
  costPerMTok: z.number().min(0).optional(),
  /** Extra capabilities on top of the ones `priceRef` reports, e.g. "image_generation". */
  capabilities: z.array(z.string()).default([]),
  /** Permission mode for the provider. Defaults to `providerModes[provider]`. */
  modeId: z.string().optional(),
  /** Thinking option per difficulty band. Omitted bands use the model default. */
  thinking: z.partialRecord(tierSchema, z.string()).default({}),
  /** Off keeps the route in the catalog but out of every selection. */
  enabled: z.boolean().default(true),
});
export type Route = z.infer<typeof routeSchema>;

export const planSchema = z.object({
  /** Case-insensitive substring of the reported plan label. "" matches every plan. */
  match: z.string(),
  /** Estimated list-price value of one full window in USD, by usage window id. */
  windowUsd: z.record(z.string(), z.number().positive()),
});

export const poolSchema = z.object({
  id: z.string().min(1),
  /** "subscription" reads Paseo usage windows. "credits" reads an OpenRouter balance. */
  kind: z.enum(["subscription", "credits"]),
  /** subscription: `providerId` in Paseo's usage reports. Defaults to the pool id. */
  usageProviderId: z.string().optional(),
  /** subscription: first matching plan wins. No match leaves the dollar value unknown. */
  plans: z.array(planSchema).default([]),
  /** credits: environment variable holding the API key. */
  apiKeyEnv: z.string().default("OPENROUTER_API_KEY"),
  /** credits: balance treated as a full pool when balancing against subscriptions. */
  fullUsd: z.number().positive().default(20),
});
export type Pool = z.infer<typeof poolSchema>;

export const classifierSchema = z.object({
  enabled: z.boolean().default(true),
  /** Decision model asked through OpenRouter's Decisions API. */
  model: z.string().default("typesafe/jev-1.13"),
  apiKeyEnv: z.string().default("OPENROUTER_API_KEY"),
  timeoutMs: z.number().positive().default(12_000),
});
export type ClassifierSettings = z.infer<typeof classifierSchema>;

// Window values are list-price dollars. Claude Pro and Codex Pro Lite were measured in October
// 2026 by pricing local session logs against the reported usage share; Max scales Pro by 5 and 20.
// Unlisted plans keep an unknown value until calibrated in Settings.
const defaultPools: z.input<typeof poolSchema>[] = [
  {
    id: "claude",
    kind: "subscription",
    plans: [
      { match: "max 20", windowUsd: { five_hour: 1700, weekly: 40_000 } },
      { match: "max", windowUsd: { five_hour: 425, weekly: 10_000 } },
      { match: "pro", windowUsd: { five_hour: 85, weekly: 2000 } },
    ],
  },
  {
    id: "codex",
    kind: "subscription",
    plans: [{ match: "prolite", windowUsd: { weekly: 270 } }],
  },
  { id: "kimi", kind: "subscription" },
  { id: "zai", kind: "subscription" },
  { id: "openrouter", kind: "credits" },
];

const fast = { tiny: "low", quick: "medium", normal: "high" } as const;

// Quality and bands follow the order of the hand-written agent profiles this plugin replaces.
const defaultRoutes: z.input<typeof routeSchema>[] = [
  {
    provider: "claude",
    model: "claude-fable-5-1",
    pool: "claude",
    tiers: ["hard"],
    quality: 98,
    priceRef: "anthropic/claude-fable-5.1",
    thinking: { hard: "high" },
  },
  {
    provider: "codex",
    model: "gpt-6-astra",
    pool: "codex",
    tiers: ["hard"],
    quality: 96,
    priceRef: "openai/gpt-6-astra",
    capabilities: ["image_generation"],
    thinking: { hard: "high" },
  },
  {
    provider: "claude",
    model: "claude-opus-5-5",
    pool: "claude",
    tiers: ["hard"],
    quality: 92,
    priceRef: "anthropic/claude-opus-5.5",
    thinking: { hard: "high" },
  },
  {
    provider: "codex",
    model: "gpt-6.1-sol",
    pool: "codex",
    tiers: ["normal", "hard"],
    quality: 88,
    priceRef: "openai/gpt-6.1-sol",
    capabilities: ["image_generation"],
    thinking: { normal: "medium", hard: "high" },
  },
  {
    provider: "claude",
    model: "claude-sonnet-5-5",
    pool: "claude",
    tiers: ["normal", "hard"],
    quality: 85,
    priceRef: "anthropic/claude-sonnet-5.5",
    thinking: { normal: "medium", hard: "high" },
  },
  {
    provider: "omp",
    model: "kimi-code/k3",
    pool: "kimi",
    tiers: ["normal", "hard"],
    quality: 82,
    priceRef: "moonshotai/kimi-k3",
  },
  {
    provider: "omp",
    model: "openrouter/deepseek/deepseek-v4-pro",
    pool: "openrouter",
    tiers: ["quick", "normal"],
    quality: 72,
    priceRef: "deepseek/deepseek-v4-pro",
  },
  {
    provider: "claude",
    model: "claude-haiku-5-5",
    pool: "claude",
    tiers: ["tiny", "quick", "normal"],
    quality: 70,
    priceRef: "anthropic/claude-haiku-5.5",
    thinking: fast,
  },
  {
    provider: "codex",
    model: "gpt-6-luna",
    pool: "codex",
    tiers: ["tiny", "quick", "normal"],
    quality: 68,
    priceRef: "openai/gpt-6-luna",
    capabilities: ["image_generation"],
    thinking: fast,
  },
  {
    provider: "omp",
    model: "zai/glm-5.3-flash",
    pool: "zai",
    tiers: ["tiny", "quick", "normal"],
    quality: 60,
    priceRef: "z-ai/glm-5.3-flash",
    thinking: { tiny: "low", normal: "high" },
  },
  {
    provider: "omp",
    model: "openrouter/z-ai/glm-5.3-flash",
    pool: "openrouter",
    tiers: ["tiny", "quick", "normal"],
    quality: 60,
    priceRef: "z-ai/glm-5.3-flash",
    thinking: { tiny: "low", normal: "high" },
  },
  {
    provider: "omp",
    model: "openrouter/deepseek/deepseek-v4-flash",
    pool: "openrouter",
    tiers: ["tiny", "quick"],
    quality: 50,
    priceRef: "deepseek/deepseek-v4-flash",
  },
];

export const settingsSchema = z.object({
  routes: z.array(routeSchema).default(() => z.array(routeSchema).parse(defaultRoutes)),
  pools: z.array(poolSchema).default(() => z.array(poolSchema).parse(defaultPools)),
  classifier: classifierSchema.prefault({}),
  /** Estimated billable tokens one task of each band consumes. */
  tierTokens: z
    .object({
      tiny: z.number().positive().default(20_000),
      quick: z.number().positive().default(80_000),
      normal: z.number().positive().default(300_000),
      hard: z.number().positive().default(1_000_000),
    })
    .prefault({}),
  /** Reserve: pools at or below this remaining share are left to the agents that spawn others. */
  minFraction: z.number().min(0).max(1).default(0.15),
  /** Adds the "spawn through the router" rule to the system prompt of every new agent. */
  injectSpawnRule: z.boolean().default(true),
  /** Routes every agent that another agent spawns, even when it names a concrete provider. */
  enforce: z.boolean().default(true),
  /** A mode here replaces whatever mode an agent requests. "off" honours the request. */
  forceMode: z.enum(["off", ...routingModes]).default("off"),
  /** Minutes a provider/model is skipped after it failed to start. 0 never skips. */
  pauseMinutes: z.number().min(0).default(30),
  /** Permission mode per provider for routes that set none. */
  providerModes: z
    .record(z.string(), z.string())
    .default({ claude: "auto", codex: "auto-review", omp: "full" }),
});
export type RouterSettings = z.infer<typeof settingsSchema>;

export const routerSettings = defineSettings({
  id: "router",
  scope: "host",
  version: 1,
  schema: settingsSchema,
});

const poolStatusSchema = z.object({
  poolId: z.string(),
  status: z.enum(["available", "exhausted", "unavailable", "unknown"]),
  planLabel: z.string().nullable(),
  remainingFraction: z.number().nullable(),
  remainingUsd: z.number().nullable(),
  fullUsd: z.number().nullable(),
  resetsAt: z.string().nullable(),
  pace: z.number().nullable(),
  detail: z.string(),
});

const decisionRecordSchema = z.object({
  at: z.string(),
  title: z.string(),
  mode: z.enum(routingModes),
  tier: tierSchema,
  needs: z.array(z.string()),
  classifiedBy: z.enum(["explicit", "llm", "heuristic"]),
  provider: z.string(),
  model: z.string(),
  reason: z.string(),
});
export type DecisionRecord = z.infer<typeof decisionRecordSchema>;

/** Live pool state and the latest routing decisions, for the settings screen. */
export const routerStatus = defineRpc({
  name: "router.status",
  input: z.object({}),
  output: z.object({
    pools: z.array(poolStatusSchema),
    paused: z.array(z.object({ route: z.string(), until: z.string(), why: z.string() })),
    providerModels: z.array(z.object({ provider: z.string(), model: z.string() })),
    decisionModels: z.array(
      z.object({ id: z.string(), name: z.string(), usdPerMTok: z.number().nullable() }),
    ),
    decisions: z.array(decisionRecordSchema),
  }),
});
