import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import { settingsSchema } from "../shared/router.ts";
import type { Classification, PoolState, ProviderCatalog, TaskText } from "./contracts.ts";
import { PaseoRouterGateway, type RouterSdk } from "./paseo.ts";
import { AutoRouter, spawnRule, type RouterGateway, type Spawn } from "./router.ts";

const settings = settingsSchema.parse({
  routes: [
    {
      provider: "claude",
      model: "big",
      pool: "claude",
      tiers: ["hard"],
      quality: 90,
      costPerMTok: 10,
      thinking: { hard: "high" },
    },
    {
      provider: "omp",
      model: "small",
      pool: "zai",
      tiers: ["tiny", "quick", "normal"],
      quality: 50,
      costPerMTok: 1,
    },
    {
      provider: "codex",
      model: "painter",
      pool: "codex",
      tiers: ["quick"],
      quality: 60,
      costPerMTok: 2,
      capabilities: ["image_generation"],
    },
  ],
});

const catalog: ProviderCatalog = {
  claude: { models: { big: ["high"] } },
  omp: { models: {} },
  codex: { models: {} },
};

function pool(poolId: string): PoolState {
  return {
    poolId,
    status: "available",
    planLabel: null,
    remainingFraction: 0.8,
    remainingUsd: null,
    fullUsd: null,
    modelFractions: {},
    resetsAt: null,
    pace: null,
    detail: "",
  };
}

function harness(
  options: {
    classification?: Classification;
    findSpawn?: () => Promise<Spawn | null>;
    catalog?: ProviderCatalog;
    pauseMinutes?: number;
    forceMode?: "off" | "economic" | "balanced" | "performance";
    injectSpawnRule?: boolean;
    enforce?: boolean;
    settingsError?: string;
  } = {},
) {
  const clock = { value: Date.parse("2026-10-11T00:00:00Z") };
  const tasks: TaskText[] = [];
  const titles: string[] = [];
  const events: string[] = [];
  const router = new AutoRouter({
    readSettings: async () => {
      if (options.settingsError) throw new Error(options.settingsError);
      return {
        ...settings,
        pauseMinutes: options.pauseMinutes ?? 30,
        forceMode: options.forceMode ?? "off",
        injectSpawnRule: options.injectSpawnRule ?? false,
        enforce: options.enforce ?? false,
      };
    },
    readQuota: async () => ({
      pools: { claude: pool("claude"), zai: pool("zai"), codex: pool("codex") },
      prices: {},
    }),
    classify: async (task) => {
      tasks.push(task);
      return (
        options.classification ?? { tier: "quick", needs: [], reason: "small edit", source: "llm" }
      );
    },
    now: () => clock.value,
    log: (event) => events.push(event),
  });
  const gateway: RouterGateway = {
    readCatalog: async () => options.catalog ?? catalog,
    findSpawn: async (title) => {
      titles.push(title);
      return options.findSpawn ? options.findSpawn() : null;
    },
  };
  const route = (config: Partial<AgentSessionConfig>) =>
    router.route(
      { provider: "auto", cwd: "/repo", title: "Fix flaky test", ...config },
      gateway,
      new AbortController().signal,
    );
  return { router, route, tasks, titles, events, clock };
}

test("other providers pass through without any lookup", async () => {
  const { route, tasks, titles } = harness();
  assert.equal(await route({ provider: "claude", model: "big" }), undefined);
  assert.deepEqual([tasks, titles], [[], []]);
});

test("enforcement replaces a concrete request using the pending spawn prompt", async () => {
  const { route, router, tasks, titles } = harness({
    enforce: true,
    findSpawn: async () => ({ prompt: "Build a small fix", pinned: false }),
  });
  const routed = await route({ provider: "claude", model: "big" });
  assert.equal(`${routed?.provider}/${routed?.model}`, "omp/small");
  assert.equal(router.recent()[0].mode, "balanced");
  assert.match(router.recent()[0].reason, /Replaced requested claude\/big/);
  assert.equal(tasks[0].prompt, "Build a small fix");
  assert.deepEqual(titles, ["Fix flaky test"]);
});

test("enforcement leaves creations without a pending spawn untouched", async () => {
  const { route, tasks, titles } = harness({ enforce: true });
  assert.equal(await route({ provider: "claude", model: "big" }), undefined);
  assert.deepEqual([tasks, titles], [[], ["Fix flaky test"]]);
});

test("enforcement leaves pinned spawns untouched and logs the skip", async () => {
  const { route, tasks, events } = harness({
    enforce: true,
    findSpawn: async () => ({ prompt: "Use this model", pinned: true }),
  });
  assert.equal(await route({ provider: "claude", model: "big" }), undefined);
  assert.deepEqual(tasks, []);
  assert.ok(events.includes("enforce_skipped"));
});

test("enforcement fails open when routing has no route or spawn lookup fails", async () => {
  const noRoute = harness({
    enforce: true,
    catalog: {},
    findSpawn: async () => ({ prompt: "Build a fix", pinned: false }),
  });
  assert.equal(await noRoute.route({ provider: "claude", model: "big" }), undefined);
  assert.ok(noRoute.events.includes("enforce_skipped"));

  const unreadable = harness({
    enforce: true,
    findSpawn: async () => {
      throw new Error("timeline unavailable");
    },
  });
  assert.equal(await unreadable.route({ provider: "claude", model: "big" }), undefined);
  assert.ok(unreadable.events.includes("enforce_skipped"));
});

test("forced mode wins during enforcement without an asked-for explanation", async () => {
  const { route, router } = harness({
    enforce: true,
    forceMode: "performance",
    findSpawn: async () => ({ prompt: "Build a small fix", pinned: false }),
  });
  await route({ provider: "claude", model: "big" });
  assert.equal(router.recent()[0].mode, "performance");
  assert.doesNotMatch(router.recent()[0].reason, /asked for/);
});

test("enforcement ignores a concrete provider's thinking option as difficulty", async () => {
  const { route, tasks } = harness({
    enforce: true,
    findSpawn: async () => ({ prompt: "Build a small fix", pinned: false }),
  });
  await route({ provider: "claude", model: "big", thinkingOptionId: "hard" });
  assert.equal(tasks.length, 1);
});

test("disabled enforcement does not look up a concrete provider's spawn", async () => {
  const { route, titles, tasks } = harness({ enforce: false });
  assert.equal(await route({ provider: "claude", model: "big" }), undefined);
  assert.deepEqual([titles, tasks], [[], []]);
});

test("auto/economic becomes the cheapest route and drops the auto selections", async () => {
  const { route } = harness();
  const config = await route({
    model: "economic",
    thinkingOptionId: "auto",
    featureValues: { stale: true },
    systemPrompt: "Be terse",
    mcpServers: { tools: { type: "http", url: "http://localhost:1/mcp" } },
  });
  assert.deepEqual(config, {
    provider: "omp",
    model: "small",
    modeId: "full",
    cwd: "/repo",
    title: "Fix flaky test",
    systemPrompt: "Be terse",
    mcpServers: { tools: { type: "http", url: "http://localhost:1/mcp" } },
  });
});

test("an explicit difficulty skips the classifier and sets the route's thinking option", async () => {
  const { route, router, tasks } = harness();
  const config = await route({ model: "performance", thinkingOptionId: "hard" });
  assert.equal(config?.provider, "claude");
  assert.equal(config?.model, "big");
  assert.equal(config?.thinkingOptionId, "high");
  assert.equal(config?.modeId, "auto");
  assert.equal(tasks.length, 0);
  assert.equal(router.recent()[0].classifiedBy, "explicit");
});

test("a +capability suffix restricts routes to models offering it", async () => {
  const { route } = harness();
  const config = await route({ model: "economic+image_generation" });
  assert.equal(`${config?.provider}/${config?.model}`, "codex/painter");
});

test("a classified need restricts routes the same way", async () => {
  const { route } = harness({
    classification: { tier: "quick", needs: ["image_generation"], reason: "", source: "llm" },
  });
  const config = await route({ model: "economic" });
  assert.equal(`${config?.provider}/${config?.model}`, "codex/painter");
});

test("a missing model means balanced", async () => {
  const { route, router } = harness();
  await route({});
  assert.equal(router.recent()[0].mode, "balanced");
});

test("an unknown mode fails with the valid choices", async () => {
  const { route } = harness();
  await assert.rejects(route({ model: "fastest" }), /auto\/economic, auto\/balanced/);
});

test("the spawning agent's prompt reaches the classifier", async () => {
  const { route, tasks, titles } = harness({
    findSpawn: async () => ({ prompt: "Full task text", pinned: false }),
  });
  await route({ model: "balanced", systemPrompt: "Rules" });
  assert.deepEqual(titles, ["Fix flaky test"]);
  assert.deepEqual(tasks, [
    { title: "Fix flaky test", prompt: "Full task text", systemPrompt: "Rules" },
  ]);
});

test("an unreadable spawn prompt still routes on the title", async () => {
  const { route, tasks, events } = harness({
    findSpawn: async () => {
      throw new Error("timeline unavailable");
    },
  });
  const config = await route({ model: "balanced" });
  assert.equal(config?.provider, "omp");
  assert.equal(tasks[0].prompt, null);
  assert.ok(events.includes("spawn_prompt_unreadable"));
});

test("no usable route fails the creation with the reasons", async () => {
  const { route } = harness({ catalog: {} });
  await assert.rejects(route({ model: "balanced" }), /omp\/small: provider unavailable/);
});

test("decisions are kept newest first and capped", async () => {
  const { route, router } = harness();
  for (let index = 0; index < 22; index += 1) await route({ title: `Task ${index}` });
  assert.equal(router.recent().length, 20);
  assert.equal(router.recent()[0].title, "Task 21");
  assert.equal(
    router.recent()[0].reason,
    "small edit. balanced: omp/small for a quick task; pool zai 80% left",
  );
});

function sdk(timelines: Record<string, unknown[]>, agents: unknown[]): RouterSdk {
  return {
    providers: {
      snapshot: async () => ({
        entries: [
          {
            provider: "claude",
            status: "ready",
            enabled: true,
            models: [{ id: "big", thinkingOptions: [{ id: "low" }, { id: "high" }] }],
          },
          { provider: "omp", status: "ready", enabled: true },
          { provider: "pi", status: "unavailable", enabled: false },
          { provider: "muse", status: "error", enabled: true },
          { provider: "codex", status: "ready", enabled: false },
        ],
      }),
    },
    agents: {
      list: async () => ({ entries: agents.map((agent) => ({ agent })) }),
      ref: (id: string) => ({
        timeline: {
          refetch: async () => ({ entries: (timelines[id] ?? []).map((item) => ({ item })) }),
        },
      }),
    },
  } as unknown as RouterSdk;
}

function spawnCall(
  title: string,
  initialPrompt: string,
  status = "running",
  labels?: Record<string, string>,
) {
  return {
    type: "tool_call",
    name: "mcp__paseo__create_agent",
    status,
    detail: {
      type: "unknown",
      input: { title, initialPrompt, ...(labels ? { labels } : {}) },
      output: null,
    },
  };
}

test("the catalog lists ready, enabled providers with their thinking options", async () => {
  assert.deepEqual(await new PaseoRouterGateway(sdk({}, [])).readCatalog("/repo"), {
    claude: { models: { big: ["low", "high"] } },
    omp: { models: {} },
  });
});

test("the spawn prompt comes from the running create_agent call with the same title", async () => {
  const gateway = new PaseoRouterGateway(
    sdk(
      {
        idle: [spawnCall("Fix flaky test", "from an idle agent")],
        other: [spawnCall("Another task", "wrong title")],
        parent: [
          spawnCall("Fix flaky test", "finished earlier", "completed"),
          { type: "assistant_message", text: "Spawning" },
          spawnCall("Fix flaky test", "the real prompt"),
        ],
      },
      [
        { id: "idle", status: "idle", archivedAt: null },
        { id: "other", status: "running", archivedAt: null },
        { id: "parent", status: "running", archivedAt: null },
      ],
    ),
  );
  assert.deepEqual(await gateway.findSpawn("Fix flaky test"), {
    prompt: "the real prompt",
    pinned: false,
  });
  assert.equal(await gateway.findSpawn("Unrelated"), null);
});

test("the spawn lookup reports only the explicit auto-router pin label", async () => {
  const gateway = new PaseoRouterGateway(
    sdk(
      {
        pinned: [spawnCall("Pinned", "keep this", "running", { "auto-router": "pin" })],
        ordinary: [spawnCall("Ordinary", "route this")],
      },
      [
        { id: "pinned", status: "running", archivedAt: null },
        { id: "ordinary", status: "running", archivedAt: null },
      ],
    ),
  );
  assert.deepEqual(await gateway.findSpawn("Pinned"), { prompt: "keep this", pinned: true });
  assert.deepEqual(await gateway.findSpawn("Ordinary"), { prompt: "route this", pinned: false });
});

const minute = 60_000;

async function launch(run: ReturnType<typeof harness>, agentId: string): Promise<string> {
  const config = await run.route({ model: "economic" });
  run.router.agentCreated({ id: agentId, provider: config!.provider, title: "Fix flaky test" });
  return `${config?.provider}/${config?.model}`;
}

test("a first turn that fails right away pauses that route, then it returns", async () => {
  const run = harness();
  assert.equal(await launch(run, "a1"), "omp/small");
  run.clock.value += minute;
  run.router.turnEnded("a1", "402 Insufficient credits");
  assert.deepEqual(run.router.paused(), [
    {
      route: "omp/small",
      until: "2026-10-11T00:31:00.000Z",
      why: "first turn failed (402 Insufficient credits)",
    },
  ]);
  assert.equal(await launch(run, "a2"), "codex/painter");
  run.clock.value += 31 * minute;
  assert.equal(await launch(run, "a3"), "omp/small");
  assert.ok(run.events.includes("route_paused"));
});

test("a clean first turn, a late failure and a later turn do not pause", async () => {
  const run = harness();
  await launch(run, "clean");
  run.router.turnEnded("clean", null);
  run.router.turnEnded("clean", "failed on the second turn");
  await launch(run, "slow");
  run.clock.value += 4 * minute;
  run.router.turnEnded("slow", "failed after working for a while");
  run.router.turnEnded("unrouted", "an agent this plugin did not route");
  assert.deepEqual(run.router.paused(), []);
});

test("a routed agent that Paseo never announces pauses its route", async () => {
  const run = harness();
  assert.equal((await run.route({ model: "economic" }))?.model, "small");
  run.clock.value += 2 * minute;
  assert.equal((await run.route({ model: "economic" }))?.model, "painter");
  assert.equal(run.router.paused()[0].why, "agent was never created");
});

test("pauseMinutes 0 never pauses", async () => {
  const run = harness({ pauseMinutes: 0 });
  await launch(run, "a1");
  run.router.turnEnded("a1", "boom");
  assert.deepEqual(run.router.paused(), []);
});

test("when the only usable route is paused the error says so", async () => {
  const run = harness({ catalog: { claude: { models: { big: ["high"] } } } });
  const config = await run.route({ model: "performance", thinkingOptionId: "hard" });
  run.router.agentCreated({ id: "big", provider: config!.provider, title: "Fix flaky test" });
  run.router.turnEnded("big", "login expired");
  await assert.rejects(
    run.route({ model: "performance", thinkingOptionId: "hard" }),
    /claude\/big: first turn failed \(login expired\), paused until 2026-10-11T00:30:00.000Z; omp\/small: provider unavailable/,
  );
});

test("a forced mode replaces the requested one and says so", async () => {
  const run = harness({ forceMode: "performance" });
  // Quick band: economic would take zai/small at $1, performance takes codex/painter at quality 60.
  const config = await run.route({ model: "economic" });
  assert.equal(`${config?.provider}/${config?.model}`, "codex/painter");
  const [record] = run.router.recent();
  assert.equal(record.mode, "performance");
  assert.match(
    record.reason,
    /Mode forced in settings \(asked for economic\)\. performance: codex/,
  );
});

test("a forced mode keeps capability suffixes and accepts any requested name", async () => {
  const run = harness({ forceMode: "economic" });
  const config = await run.route({ model: "fastest+image_generation" });
  assert.equal(`${config?.provider}/${config?.model}`, "codex/painter");
  await run.route({ model: "economic" });
  assert.doesNotMatch(run.router.recent()[0].reason, /forced/);
});

test("every new agent gets the spawn rule appended to its system prompt", async () => {
  const run = harness({ injectSpawnRule: true });
  const plain = await run.route({ provider: "claude", model: "big", systemPrompt: "Be terse" });
  assert.deepEqual(plain, {
    provider: "claude",
    model: "big",
    cwd: "/repo",
    title: "Fix flaky test",
    systemPrompt: `Be terse\n\n${spawnRule}`,
  });
  assert.deepEqual([run.tasks, run.titles], [[], []]);

  const routed = await run.route({ model: "economic" });
  assert.equal(routed?.provider, "omp");
  assert.equal(routed?.systemPrompt, spawnRule);
});

test("the spawn rule is never added twice", async () => {
  const run = harness({ injectSpawnRule: true });
  assert.equal(await run.route({ provider: "claude", systemPrompt: spawnRule }), undefined);
  const routed = await run.route({ model: "economic", systemPrompt: `Rules\n\n${spawnRule}` });
  assert.equal(routed?.systemPrompt, `Rules\n\n${spawnRule}`);
});

test("unreadable settings fail an auto request but never another provider's agent", async () => {
  const run = harness({ settingsError: "settings are invalid" });
  assert.equal(await run.route({ provider: "claude", model: "big" }), undefined);
  await assert.rejects(run.route({ model: "economic" }), /settings are invalid/);
});
