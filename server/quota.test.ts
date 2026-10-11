/** Tests for the quota reader: usage windows, credit balances, the price table and their caches. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsSchema } from "../shared/router.ts";
import { QuotaReader, openRouterBaseUrl } from "./quota.ts";
import type { FetchJson } from "./contracts.ts";
import type { QuotaDeps, UsageEntry } from "./quota.ts";

// Verbatim shape from the live daemon.
const fixture: { providers: UsageEntry[] } = {
  providers: [
    {
      providerId: "claude",
      status: "available",
      planLabel: "Pro ai",
      windows: [
        {
          id: "five_hour",
          usedPct: 37,
          remainingPct: 63,
          resetsAt: "2026-10-11T04:40:00.175394+00:00",
        },
        {
          id: "weekly",
          usedPct: 10,
          remainingPct: 90,
          resetsAt: "2026-10-15T04:00:00.175411+00:00",
        },
        {
          id: "weekly_model_fable",
          usedPct: 0,
          remainingPct: 100,
          resetsAt: "2026-10-15T04:00:00+00:00",
        },
      ],
      error: null,
    },
    {
      providerId: "claude",
      status: "unavailable",
      planLabel: null,
      windows: [],
      error: "Login expired 28d ago. Run pi to refresh it.",
    },
    {
      providerId: "codex",
      status: "available",
      planLabel: "prolite",
      windows: [
        { id: "weekly", usedPct: 100, remainingPct: 0, resetsAt: "2026-10-15T11:52:11.000Z" },
      ],
      error: null,
    },
    { providerId: "kimi", status: "available", planLabel: null, windows: [], error: null },
    {
      providerId: "zai",
      status: "unavailable",
      planLabel: null,
      windows: [],
      error: "No active coding plan",
    },
  ],
};

interface FetchCall {
  url: string;
  headers?: Record<string, string>;
}

const defaultRespond = (url: string) =>
  url.endsWith("/credits") ? { data: { total_credits: 20, total_usage: 8 } } : { data: [] };

const modelsRespond = (data: unknown[]) => (url: string) =>
  url.endsWith("/models") ? { data } : defaultRespond(url);

function fakeDeps(
  options: {
    usage?: () => Promise<{ providers: readonly UsageEntry[] }>;
    respond?: (url: string) => unknown;
    env?: Record<string, string | undefined>;
    now?: () => number;
  } = {},
) {
  const calls: FetchCall[] = [];
  const fetchJson: FetchJson = async (url, init) => {
    calls.push({ url, headers: init.headers });
    return (options.respond ?? defaultRespond)(url);
  };
  const deps: QuotaDeps = {
    listUsage: options.usage ?? (async () => fixture),
    fetchJson,
    env: options.env ?? {},
    now: options.now ?? (() => 0),
  };
  const countCalls = (suffix: string) => calls.filter((call) => call.url.endsWith(suffix)).length;
  return { deps, calls, countCalls };
}

const read = (deps: QuotaDeps, input: object = {}) =>
  new QuotaReader(deps).read(settingsSchema.parse(input));

const creditsInput = { pools: [{ id: "openrouter", kind: "credits" }] };
const creditsEnv = { OPENROUTER_API_KEY: "sk-test" };
const HOUR = 60 * 60_000;

test("default settings map the live usage fixture onto pools", async () => {
  const { deps } = fakeDeps();
  const { pools } = await read(deps);

  assert.deepEqual(Object.keys(pools).sort(), ["claude", "codex", "kimi", "openrouter", "zai"]);

  const claude = pools.claude;
  assert.equal(claude.status, "available");
  assert.equal(claude.planLabel, "Pro ai");
  assert.equal(claude.remainingFraction, 0.63);
  assert.ok(Math.abs(claude.remainingUsd! - 53.55) < 1e-9);
  assert.equal(claude.fullUsd, 85);
  assert.deepEqual(claude.modelFractions, { fable: 1 });
  assert.equal(claude.resetsAt, "2026-10-11T04:40:00.175394+00:00");
  assert.equal(claude.detail, "Pro ai: five_hour 63%, weekly 90%");

  const codex = pools.codex;
  assert.equal(codex.status, "exhausted");
  assert.equal(codex.remainingFraction, 0);
  assert.equal(codex.remainingUsd, 0);

  assert.equal(pools.kimi.status, "unknown");
  assert.equal(pools.kimi.detail, "no usage windows reported");

  assert.equal(pools.zai.status, "unavailable");
  assert.equal(pools.zai.detail, "No active coding plan");

  assert.equal(pools.openrouter.status, "unavailable");
  assert.equal(pools.openrouter.detail, "OPENROUTER_API_KEY is not set");
});

test("an unavailable duplicate login is ignored when an available one exists", async () => {
  const [live, expired] = fixture.providers;
  for (const providers of [
    [expired, live],
    [live, expired],
  ]) {
    const { deps } = fakeDeps({ usage: async () => ({ providers }) });
    const { pools } = await read(deps);
    assert.equal(pools.claude.status, "available");
    assert.equal(pools.claude.remainingFraction, 0.63);
  }
});

test("a usedPct-only window gives the remaining share", async () => {
  const usage = {
    providers: [
      {
        providerId: "kimi",
        status: "available",
        planLabel: null,
        windows: [{ id: "weekly", usedPct: 25 }],
        error: null,
      },
    ] satisfies UsageEntry[],
  };
  const { deps } = fakeDeps({ usage: async () => usage });
  const { pools } = await read(deps, { pools: [{ id: "kimi", kind: "subscription" }] });
  assert.equal(pools.kimi.status, "available");
  assert.equal(pools.kimi.remainingFraction, 0.75);
});

test("a plan with no matching label leaves dollar values null", async () => {
  const { deps } = fakeDeps();
  const { pools } = await read(deps, {
    pools: [
      { id: "claude", kind: "subscription", plans: [{ match: "max", windowUsd: { weekly: 200 } }] },
    ],
  });
  assert.equal(pools.claude.status, "available");
  assert.equal(pools.claude.remainingFraction, 0.63);
  assert.equal(pools.claude.remainingUsd, null);
  assert.equal(pools.claude.fullUsd, null);
});

test("a pool with no usage entry is unknown", async () => {
  const { deps } = fakeDeps({ usage: async () => ({ providers: [] }) });
  const { pools } = await read(deps, { pools: [{ id: "claude", kind: "subscription" }] });
  assert.equal(pools.claude.status, "unknown");
  assert.equal(pools.claude.detail, "no usage report");
  assert.equal(pools.claude.remainingFraction, null);
  assert.deepEqual(pools.claude.modelFractions, {});
});

test("a rejected usage listing marks subscription pools unknown without throwing", async () => {
  const { deps } = fakeDeps({
    usage: async () => {
      throw new Error("daemon down");
    },
  });
  const { pools } = await read(deps);
  for (const id of ["claude", "codex", "kimi", "zai"]) {
    assert.equal(pools[id].status, "unknown");
    assert.equal(pools[id].detail, "daemon down");
  }
});

test("a positive credit balance is clamped to a full pool", async () => {
  const { deps } = fakeDeps({
    env: creditsEnv,
    respond: (url) =>
      url.endsWith("/credits")
        ? { data: { total_credits: 30, total_usage: 0 } }
        : defaultRespond(url),
  });
  const { pools } = await read(deps, creditsInput);
  assert.equal(pools.openrouter.status, "available");
  assert.equal(pools.openrouter.remainingFraction, 1);
  assert.equal(pools.openrouter.remainingUsd, 30);
  assert.equal(pools.openrouter.fullUsd, 20);
  assert.equal(pools.openrouter.detail, "$30.00 credits left");
});

test("a negative credit balance is exhausted", async () => {
  const { deps } = fakeDeps({
    env: creditsEnv,
    respond: (url) =>
      url.endsWith("/credits")
        ? { data: { total_credits: 5, total_usage: 7 } }
        : defaultRespond(url),
  });
  const { pools } = await read(deps, creditsInput);
  assert.equal(pools.openrouter.status, "exhausted");
  assert.equal(pools.openrouter.remainingUsd, -2);
  assert.equal(pools.openrouter.remainingFraction, 0);
  assert.equal(pools.openrouter.detail, "-$2.00 credits left");
});

test("a missing API key makes no credits request", async () => {
  const { deps, calls } = fakeDeps({ env: { OPENROUTER_API_KEY: "" } });
  const { pools } = await read(deps, creditsInput);
  assert.equal(pools.openrouter.status, "unavailable");
  assert.equal(pools.openrouter.detail, "OPENROUTER_API_KEY is not set");
  assert.equal(
    calls.some((call) => call.url.endsWith("/credits")),
    false,
  );
});

test("the credits request carries the Bearer key and the /credits URL", async () => {
  const { deps, calls } = fakeDeps({ env: creditsEnv });
  await read(deps, creditsInput);
  const call = calls.find((candidate) => candidate.url.endsWith("/credits"));
  assert.equal(call?.url, `${openRouterBaseUrl}/credits`);
  assert.equal(call?.headers?.Authorization, "Bearer sk-test");
});

test("credit balance is cached for 60 seconds, then refetched", async () => {
  let now = 0;
  const { deps, countCalls } = fakeDeps({ env: creditsEnv, now: () => now });
  const reader = new QuotaReader(deps);
  const input = settingsSchema.parse(creditsInput);

  await reader.read(input);
  now = 59_000;
  await reader.read(input);
  assert.equal(countCalls("/credits"), 1);

  now = 61_000;
  await reader.read(input);
  assert.equal(countCalls("/credits"), 2);
});

test("a credit failure is unknown and is not cached", async () => {
  let fail = true;
  const { deps, countCalls } = fakeDeps({
    env: creditsEnv,
    respond: (url) => {
      if (url.endsWith("/credits") && fail) throw new Error("upstream 502");
      return defaultRespond(url);
    },
  });
  const reader = new QuotaReader(deps);
  const input = settingsSchema.parse(creditsInput);

  const failed = (await reader.read(input)).pools.openrouter;
  assert.equal(failed.status, "unknown");
  assert.equal(failed.detail, "upstream 502");
  assert.equal(failed.remainingUsd, null);

  fail = false;
  const recovered = (await reader.read(input)).pools.openrouter;
  assert.equal(recovered.status, "available");
  assert.equal(countCalls("/credits"), 2);
});

test("price table converts per-token prices and reports image modalities", async () => {
  const { deps } = fakeDeps({
    respond: modelsRespond([
      {
        id: "vendor/vision",
        pricing: { prompt: "0.00000015", completion: "0.0000005" },
        architecture: { input_modalities: ["text", "image"], output_modalities: ["text", "image"] },
      },
      {
        id: "vendor/text",
        pricing: { prompt: "0.000001", completion: "0.000001" },
        architecture: { input_modalities: ["text"], output_modalities: ["text"] },
      },
    ]),
  });
  const { prices } = await read(deps, { pools: [] });
  assert.ok(Math.abs(prices["vendor/vision"].costPerMTok - 0.2375) < 1e-9);
  assert.deepEqual(prices["vendor/vision"].capabilities, ["vision", "image_generation"]);
  assert.ok(Math.abs(prices["vendor/text"].costPerMTok - 1) < 1e-9);
  assert.deepEqual(prices["vendor/text"].capabilities, []);
});

test("malformed price entries are skipped", async () => {
  const { deps } = fakeDeps({
    respond: modelsRespond([
      null,
      { id: "no-price", pricing: { prompt: "x", completion: "1" }, architecture: {} },
      { id: 7, pricing: { prompt: "1", completion: "1" } },
      { id: "missing-pricing" },
      { id: "ok", pricing: { prompt: "0.000001", completion: "0.000001" } },
    ]),
  });
  const { prices } = await read(deps, { pools: [] });
  assert.deepEqual(Object.keys(prices), ["ok"]);
});

test("price table is cached for six hours", async () => {
  let now = 0;
  const { deps, countCalls } = fakeDeps({ now: () => now, respond: modelsRespond([]) });
  const reader = new QuotaReader(deps);
  const input = settingsSchema.parse({ pools: [] });

  await reader.read(input);
  now = 6 * HOUR - 1;
  await reader.read(input);
  assert.equal(countCalls("/models"), 1);

  now = 6 * HOUR + 1;
  await reader.read(input);
  assert.equal(countCalls("/models"), 2);
});

test("a price failure falls back to the last table", async () => {
  let now = 0;
  let fail = false;
  const { deps } = fakeDeps({
    now: () => now,
    respond: (url) => {
      if (!url.endsWith("/models")) return defaultRespond(url);
      if (fail) throw new Error("models down");
      return { data: [{ id: "ok", pricing: { prompt: "0.000001", completion: "0.000001" } }] };
    },
  });
  const reader = new QuotaReader(deps);
  const input = settingsSchema.parse({ pools: [] });

  fail = true;
  assert.deepEqual((await reader.read(input)).prices, {});

  fail = false;
  assert.deepEqual(Object.keys((await reader.read(input)).prices), ["ok"]);

  now = 7 * HOUR;
  fail = true;
  assert.deepEqual(Object.keys((await reader.read(input)).prices), ["ok"]);
});

test("pace compares quota left with time left in the scarcest window", async () => {
  // Four of five hours remain for 63% of the session; 99h20m of the week remain for 90%.
  const now = Date.parse("2026-10-11T00:40:00.175394Z");
  const { pools } = await read(fakeDeps({ now: () => now }).deps);
  assert.ok(Math.abs(pools.claude.pace! - 0.63 / 0.8) < 1e-9);
  assert.equal(pools.codex.pace, 0);
  assert.equal(pools.kimi.pace, null);
  assert.equal(pools.openrouter.pace, null);
});

test("quota about to expire has a high pace, and unknown windows have none", async () => {
  const resetsAt = "2026-10-11T05:00:00Z";
  const usage = async () => ({
    providers: [
      {
        providerId: "claude",
        status: "available" as const,
        planLabel: "Pro",
        windows: [{ id: "five_hour", remainingPct: 80, resetsAt }],
      },
      {
        providerId: "codex",
        status: "available" as const,
        planLabel: "prolite",
        windows: [
          { id: "primary", remainingPct: 80, resetsAt },
          { id: "weekly", remainingPct: 50 },
        ],
      },
    ],
  });
  const now = Date.parse(resetsAt) - HOUR;
  const { pools } = await read(fakeDeps({ usage, now: () => now }).deps);
  assert.ok(Math.abs(pools.claude.pace! - 4) < 1e-9);
  assert.equal(pools.codex.pace, null);
});
