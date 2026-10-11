/** Tests for the route-selection policy: hard gates, difficulty bands, budget, mode pick and decision fields. */
import assert from "node:assert/strict";
import { test } from "node:test";
import { settingsSchema } from "../shared/router.ts";
import type { RouterSettings, Tier } from "../shared/router.ts";
import type { PoolState, ProviderCatalog, QuotaSnapshot, RouteRequest } from "./contracts.ts";
import { NoRouteError, selectRoute } from "./policy.ts";

// Settings go through the schema so defaults (tierTokens, minFraction, thinking, capabilities) apply.
function settingsWith(routes: unknown[], extra: Record<string, unknown> = {}): RouterSettings {
  return settingsSchema.parse({ routes, ...extra });
}

function route(over: Record<string, unknown>): Record<string, unknown> {
  return {
    provider: "claude",
    model: "m-a",
    pool: "claude",
    tiers: ["quick"],
    quality: 70,
    ...over,
  };
}

// Default pool is healthy: 90% left, $100 left of a $100 window.
function quota(pools: Record<string, Partial<PoolState>> = {}, prices = {}): QuotaSnapshot {
  return {
    pools: Object.fromEntries(
      Object.entries(pools).map(([id, over]) => [
        id,
        {
          poolId: id,
          status: "available",
          planLabel: null,
          remainingFraction: 0.9,
          remainingUsd: 100,
          fullUsd: 100,
          modelFractions: {},
          resetsAt: null,
          pace: null,
          detail: "",
          ...over,
        },
      ]),
    ),
    prices,
  };
}

const open: ProviderCatalog = {
  claude: { models: {} },
  codex: { models: {} },
  omp: { models: {} },
};

function req(
  tier: Tier,
  mode: RouteRequest["mode"] = "economic",
  needs: string[] = [],
): RouteRequest {
  return { mode, tier, needs };
}

test("economic picks the cheapest route in the band", () => {
  const settings = settingsWith([
    route({ model: "m-a", costPerMTok: 5, quality: 90 }),
    route({ provider: "codex", pool: "codex", model: "m-b", costPerMTok: 1, quality: 60 }),
  ]);
  const decision = selectRoute(req("quick"), settings, quota({ claude: {}, codex: {} }), open);
  assert.equal(decision.route.model, "m-b");
});

test("performance picks the highest quality route in the band", () => {
  const settings = settingsWith([
    route({ model: "m-a", costPerMTok: 5, quality: 90 }),
    route({ provider: "codex", pool: "codex", model: "m-b", costPerMTok: 1, quality: 60 }),
  ]);
  const decision = selectRoute(
    req("quick", "performance"),
    settings,
    quota({ claude: {}, codex: {} }),
    open,
  );
  assert.equal(decision.route.model, "m-a");
});

test("balanced picks the pool with the most headroom", () => {
  const settings = settingsWith([
    route({ model: "m-a", costPerMTok: 1 }),
    route({ provider: "codex", pool: "codex", model: "m-b", costPerMTok: 1 }),
  ]);
  const decision = selectRoute(
    req("quick", "balanced"),
    settings,
    quota({ claude: { remainingFraction: 0.5 }, codex: { remainingFraction: 0.8 } }),
    open,
  );
  assert.equal(decision.route.model, "m-b");
});

test("balanced tie within 0.05 picks the cheaper route", () => {
  const settings = settingsWith([
    route({ model: "m-a", costPerMTok: 3, quality: 90 }),
    route({ provider: "codex", pool: "codex", model: "m-b", costPerMTok: 1, quality: 60 }),
  ]);
  const decision = selectRoute(
    req("quick", "balanced"),
    settings,
    quota({ claude: { remainingFraction: 0.8 }, codex: { remainingFraction: 0.78 } }),
    open,
  );
  assert.equal(decision.route.model, "m-b");
});

test("pool with status exhausted is skipped", () => {
  const settings = settingsWith([
    route({ model: "m-a", costPerMTok: 1 }),
    route({ provider: "codex", pool: "codex", model: "m-b", costPerMTok: 5 }),
  ]);
  const decision = selectRoute(
    req("quick"),
    settings,
    quota({ claude: { status: "exhausted" }, codex: {} }),
    open,
  );
  assert.equal(decision.route.model, "m-b");
  assert.deepEqual(decision.rejected, ["claude/m-a: pool exhausted"]);
});

test("fraction at or below minFraction is skipped", () => {
  const settings = settingsWith([
    route({ model: "m-a", costPerMTok: 1 }),
    route({ provider: "codex", pool: "codex", model: "m-b", costPerMTok: 5 }),
  ]);
  const decision = selectRoute(
    req("quick"),
    settings,
    quota({ claude: { remainingFraction: 0.15 }, codex: {} }),
    open,
  );
  assert.equal(decision.route.model, "m-b");
  assert.deepEqual(decision.rejected, ["claude/m-a: held in reserve (15% left)"]);
});

test("model-scoped fraction rejects only the route whose model contains the keyword", () => {
  const settings = settingsWith([
    route({ model: "claude-fable-5-1", quality: 98 }),
    route({ model: "claude-opus-5-5", quality: 92 }),
  ]);
  const decision = selectRoute(
    req("quick", "performance"),
    settings,
    quota({ claude: { modelFractions: { fable: 0 } } }),
    open,
  );
  assert.equal(decision.route.model, "claude-opus-5-5");
  assert.deepEqual(decision.rejected, ["claude/claude-fable-5-1: pool exhausted"]);
});

test("capability need filters routes using prices[priceRef].capabilities", () => {
  const settings = settingsWith([
    route({ model: "m-a", priceRef: "p/a", costPerMTok: undefined }),
    route({ provider: "codex", pool: "codex", model: "m-b", priceRef: "p/b" }),
  ]);
  const decision = selectRoute(
    req("quick", "economic", ["image_generation"]),
    settings,
    quota(
      { claude: {}, codex: {} },
      {
        "p/a": { costPerMTok: 1, capabilities: [] },
        "p/b": { costPerMTok: 2, capabilities: ["image_generation"] },
      },
    ),
    open,
  );
  assert.equal(decision.route.model, "m-b");
  assert.deepEqual(decision.rejected, ["claude/m-a: lacks image_generation"]);
});

test("provider missing from the catalog is rejected", () => {
  const settings = settingsWith([
    route({ provider: "codex", pool: "codex", model: "m-a", costPerMTok: 1 }),
    route({ model: "m-b", costPerMTok: 5 }),
  ]);
  const decision = selectRoute(req("quick"), settings, quota({ claude: {}, codex: {} }), {
    claude: { models: {} },
  });
  assert.equal(decision.route.model, "m-b");
  assert.deepEqual(decision.rejected, ["codex/m-a: provider unavailable"]);
});

test("model not offered by a non-empty catalog is rejected", () => {
  const settings = settingsWith([
    route({ model: "m-a", costPerMTok: 1 }),
    route({ model: "m-b", costPerMTok: 5 }),
  ]);
  const decision = selectRoute(req("quick"), settings, quota({ claude: {} }), {
    claude: { models: { "m-b": ["low"] } },
  });
  assert.equal(decision.route.model, "m-b");
  assert.deepEqual(decision.rejected, ["claude/m-a: model not offered"]);
});

test("empty catalog models accepts any model", () => {
  const settings = settingsWith([route({ model: "anything-x" })]);
  const decision = selectRoute(req("quick"), settings, quota({ claude: {} }), {
    claude: { models: {} },
  });
  assert.equal(decision.route.model, "anything-x");
  assert.deepEqual(decision.rejected, []);
});

test("band escalates to a harder band when the requested band is empty", () => {
  const settings = settingsWith([route({ model: "m-a", tiers: ["normal"] })]);
  const decision = selectRoute(req("quick"), settings, quota({ claude: {} }), open);
  assert.equal(decision.route.model, "m-a");
  assert.equal(
    decision.reason,
    'economic: claude/m-a for a quick task; pool claude 90% left; no eligible route in "quick", used "normal"',
  );
});

test("unaffordable in-band route loses to an affordable harder-band route", () => {
  const settings = settingsWith([
    route({ model: "m-a", tiers: ["quick"], costPerMTok: 10 }),
    route({ provider: "codex", pool: "codex", model: "m-b", tiers: ["hard"], costPerMTok: 1 }),
  ]);
  const decision = selectRoute(
    req("quick"),
    settings,
    quota({ claude: { remainingUsd: 0.01, remainingFraction: 0.5 }, codex: {} }),
    open,
  );
  assert.equal(decision.route.model, "m-b");
  assert.match(decision.reason, /used "hard"/);
  assert.doesNotMatch(decision.reason, /quota may not cover/);
  assert.deepEqual(decision.rejected, ["claude/m-a: about 1000 tokens left, task needs 80000"]);
});

test("when nothing is affordable pass 2 still returns a route and the reason mentions quota", () => {
  const settings = settingsWith([route({ model: "m-a", costPerMTok: 10 })]);
  const decision = selectRoute(
    req("quick"),
    settings,
    quota({ claude: { remainingUsd: 0.01 } }),
    open,
  );
  assert.equal(decision.route.model, "m-a");
  assert.equal(decision.remainingTokens, 1000);
  assert.equal(
    decision.reason,
    "economic: claude/m-a for a quick task; pool claude 90% left; quota may not cover the task",
  );
});

test("no eligible route throws NoRouteError carrying the reasons", () => {
  const settings = settingsWith([route({ provider: "codex", pool: "codex", model: "m-a" })]);
  assert.throws(
    () => selectRoute(req("quick"), settings, quota({ codex: {} }), { claude: { models: {} } }),
    (error: unknown) => {
      assert.ok(error instanceof NoRouteError);
      assert.deepEqual(error.rejected, ["codex/m-a: provider unavailable"]);
      return true;
    },
  );
});

test("thinkingOptionId is dropped when the catalog does not offer it", () => {
  const settings = settingsWith([route({ model: "m-a", thinking: { quick: "medium" } })]);
  const decision = selectRoute(req("quick"), settings, quota({ claude: {} }), {
    claude: { models: { "m-a": ["low", "high"] } },
  });
  assert.equal(decision.thinkingOptionId, null);
});

test("modeId falls back to providerModes", () => {
  const settings = settingsWith([route({ model: "m-a" })], { providerModes: { claude: "plan" } });
  const decision = selectRoute(req("quick"), settings, quota({ claude: {} }), open);
  assert.equal(decision.modeId, "plan");
});

test("costPerMTok overrides the priceRef price", () => {
  const settings = settingsWith([
    route({ model: "m-a", priceRef: "p/a", costPerMTok: 10 }),
    route({ provider: "codex", pool: "codex", model: "m-b", costPerMTok: 5 }),
  ]);
  const decision = selectRoute(
    req("quick"),
    settings,
    quota({ claude: {}, codex: {} }, { "p/a": { costPerMTok: 1, capabilities: [] } }),
    open,
  );
  assert.equal(decision.route.model, "m-b");
});

test("missing pool state is treated as unknown and stays eligible", () => {
  const settings = settingsWith([route({ model: "m-a", pool: "ghost" })]);
  const decision = selectRoute(req("quick"), settings, quota({}), open);
  assert.equal(decision.route.model, "m-a");
  assert.equal(decision.remainingTokens, null);
  assert.deepEqual(decision.rejected, []);
});

test("a pool that reports no quota is used only when no pool with visible quota fits", () => {
  const settings = settingsWith([
    route({ provider: "omp", pool: "kimi", model: "m-unknown", costPerMTok: 1, quality: 99 }),
    route({ model: "m-known", costPerMTok: 5 }),
  ]);
  const unknown = { status: "unknown", remainingFraction: null, remainingUsd: null } as const;
  for (const mode of ["economic", "balanced", "performance"] as const) {
    const decision = selectRoute(
      req("quick", mode),
      settings,
      quota({ kimi: unknown, claude: {} }),
      open,
    );
    assert.equal(decision.route.model, "m-known", mode);
  }
  const fallback = selectRoute(
    req("quick"),
    settings,
    quota({ kimi: unknown, claude: { status: "exhausted" } }),
    open,
  );
  assert.equal(fallback.route.model, "m-unknown");
  assert.match(fallback.reason, /pool kimi quota unknown/);
});

const paid = { provider: "omp", pool: "openrouter", model: "m-credits" } as const;

test("economic and balanced spend prepaid quota before cheaper credits", () => {
  const settings = settingsWith([
    route({ ...paid, costPerMTok: 0.1, quality: 99 }),
    route({ model: "m-prepaid", costPerMTok: 5 }),
  ]);
  const pools = quota({ openrouter: { remainingFraction: 1 }, claude: { remainingFraction: 0.2 } });
  assert.equal(
    selectRoute(req("quick", "economic"), settings, pools, open).route.model,
    "m-prepaid",
  );
  assert.equal(
    selectRoute(req("quick", "balanced"), settings, pools, open).route.model,
    "m-prepaid",
  );
  assert.equal(
    selectRoute(req("quick", "performance"), settings, pools, open).route.model,
    "m-credits",
  );
});

test("credits serve the band when no prepaid route in it has quota", () => {
  const settings = settingsWith([
    route({ ...paid, costPerMTok: 0.1 }),
    route({ model: "m-prepaid", costPerMTok: 5 }),
    route({ provider: "codex", pool: "codex", model: "m-harder", tiers: ["hard"] }),
  ]);
  const pools = quota({ openrouter: {}, claude: { status: "exhausted" }, codex: {} });
  for (const mode of ["economic", "balanced"] as const) {
    assert.equal(selectRoute(req("quick", mode), settings, pools, open).route.model, "m-credits");
  }
});

test("economic discounts prepaid quota that would expire unused", () => {
  const settings = settingsWith([
    route({ model: "m-scarce", costPerMTok: 1 }),
    route({ provider: "codex", pool: "codex", model: "m-expiring", costPerMTok: 3 }),
  ]);
  // codex has four times more quota than time left, so its list price counts a quarter.
  const decision = selectRoute(
    req("quick", "economic"),
    settings,
    quota({ claude: { pace: 0.5 }, codex: { pace: 4 } }),
    open,
  );
  assert.equal(decision.route.model, "m-expiring");
  assert.match(decision.reason, /pool codex 90% left, 4\.0x more quota than time before it resets/);
});

test("balanced follows quota against time left, not the share left alone", () => {
  const settings = settingsWith([
    route({ model: "m-full-early" }),
    route({ provider: "codex", pool: "codex", model: "m-half-late" }),
  ]);
  const decision = selectRoute(
    req("quick", "balanced"),
    settings,
    quota({
      claude: { remainingFraction: 0.9, pace: 0.9 },
      codex: { remainingFraction: 0.5, pace: 2.5 },
    }),
    open,
  );
  assert.equal(decision.route.model, "m-half-late");
});

test("a route switched off in settings is passed over and says why", () => {
  const settings = settingsWith([
    route({ model: "m-off", costPerMTok: 1, enabled: false }),
    route({ model: "m-on", costPerMTok: 9 }),
  ]);
  const decision = selectRoute(req("quick"), settings, quota({ claude: {} }), open);
  assert.equal(decision.route.model, "m-on");
  assert.deepEqual(decision.rejected, ["claude/m-off: switched off in settings"]);
});
