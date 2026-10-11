import assert from "node:assert/strict";
import { test } from "node:test";
import { classifierSchema } from "../shared/router.ts";
import type { FetchJson, TaskText } from "./contracts.ts";
import { classify, classifyHeuristically, listDecisionModels } from "./classifier.ts";

const env = { TEST_KEY: "sk-test" };
const task: TaskText = { title: "Add retry to the sync worker", prompt: null, systemPrompt: null };

function settings(overrides: Record<string, unknown> = {}) {
  return classifierSchema.parse({ apiKeyEnv: "TEST_KEY", ...overrides });
}

/** Shape of an OpenRouter Decisions reply, as documented for typesafe/jev-1.13. */
function decisions(tier: unknown, nouls: Record<string, number> = {}, confidence?: number) {
  return {
    model: "typesafe/jev-1.13",
    answers: {
      tier: { type: "choice", choice: tier, ...(confidence === undefined ? {} : { confidence }) },
      ...Object.fromEntries(
        Object.entries(nouls).map(([key, noul]) => [key, { type: "noul", noul }]),
      ),
    },
    usage: { input_tokens: 600, output_tokens: 100, cost: 0.000025 },
  };
}

function fakeFetch(reply: unknown | (() => Promise<unknown>)) {
  const calls: { url: string; init: Parameters<FetchJson>[1] }[] = [];
  const fetchJson: FetchJson = async (url, init) => {
    calls.push({ url, init });
    return typeof reply === "function" ? (reply as () => Promise<unknown>)() : reply;
  };
  return { calls, fetchJson };
}

function requestBody(calls: { init: Parameters<FetchJson>[1] }[]) {
  return JSON.parse(calls[0].init.body ?? "{}") as {
    model: string;
    state: Record<string, string>;
    questions: Record<string, { type: string; instructions: string; criteria?: object }>;
  };
}

test("the task goes to the Decisions endpoint as a tier choice plus one question per capability", async () => {
  const { calls, fetchJson } = fakeFetch(decisions("quick", {}, 0.93));
  const result = await classify(
    { title: "Rename helper", prompt: "Rename foo to bar in three files.", systemPrompt: "Rules" },
    settings(),
    ["image_generation", "browser"],
    { fetchJson, env },
  );

  assert.deepEqual(result, {
    tier: "quick",
    needs: [],
    reason: "Jev: quick, confidence 0.93",
    source: "llm",
  });
  assert.equal(calls.length, 1);
  const [call] = calls;
  assert.equal(call.url, "https://openrouter.ai/api/alpha/decisions");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.headers?.Authorization, "Bearer sk-test");
  assert.equal(call.init.headers?.["Content-Type"], "application/json");
  assert.equal(call.init.timeoutMs, 12_000);
  const body = requestBody(calls);
  assert.equal(body.model, "typesafe/jev-1.13");
  assert.deepEqual(body.state, {
    title: "Rename helper",
    task: "Rename foo to bar in three files.",
    system_prompt: "Rules",
  });
  assert.equal(body.questions.tier.type, "choice");
  assert.deepEqual(Object.keys(body.questions.tier.criteria ?? {}), [
    "tiny",
    "quick",
    "normal",
    "hard",
  ]);
  assert.equal(body.questions.needs_image_generation.type, "noul");
  assert.match(body.questions.needs_image_generation.instructions, /generating new images/);
  assert.match(body.questions.needs_browser.instructions, /require the "browser" capability/);
});

test("a capability counts as needed only at a likelihood of 0.7 or more", async () => {
  const { fetchJson } = fakeFetch(
    decisions("normal", { needs_image_generation: 0.7, needs_vision: 0.69, needs_other: 0.99 }),
  );
  const result = await classify(task, settings(), ["image_generation", "vision"], {
    fetchJson,
    env,
  });
  assert.deepEqual(result, {
    tier: "normal",
    needs: ["image_generation"],
    reason: "Jev: normal",
    source: "llm",
  });
});

test("an unknown tier falls back to the heuristic with a classifier failed prefix", async () => {
  const { fetchJson } = fakeFetch(decisions("epic"));
  const result = await classify(task, settings(), [], { fetchJson, env });
  assert.equal(result.source, "heuristic");
  assert.equal(result.tier, "quick");
  assert.match(result.reason, /^classifier failed: reply has no valid tier \("epic"\); /);
});

test("a reply without answers falls back to the heuristic", async () => {
  const { fetchJson } = fakeFetch({ error: { message: "nope" } });
  const result = await classify(task, settings(), [], { fetchJson, env });
  assert.equal(result.source, "heuristic");
  assert.match(result.reason, /^classifier failed: reply has no valid tier/);
});

test("fetchJson rejection falls back and carries the error message in the reason", async () => {
  const { fetchJson } = fakeFetch(async () => {
    throw new Error("HTTP 503 Service Unavailable");
  });
  const result = await classify(task, settings(), [], { fetchJson, env });
  assert.equal(result.source, "heuristic");
  assert.match(result.reason, /^classifier failed: HTTP 503 Service Unavailable; /);
});

test("a rejected AbortError falls back without throwing", async () => {
  const { fetchJson } = fakeFetch(async () => {
    throw new DOMException("The operation was aborted", "AbortError");
  });
  const result = await classify(task, settings(), [], { fetchJson, env });
  assert.equal(result.source, "heuristic");
  assert.match(result.reason, /^classifier failed: The operation was aborted; /);
});

test("disabled classifier makes no HTTP call", async () => {
  const { calls, fetchJson } = fakeFetch(decisions("hard"));
  const result = await classify(task, settings({ enabled: false }), [], { fetchJson, env });
  assert.equal(calls.length, 0);
  assert.equal(result.source, "heuristic");
  assert.match(result.reason, /^classifier disabled; /);
});

test("missing or empty API key makes no HTTP call", async () => {
  const { calls, fetchJson } = fakeFetch(decisions("hard"));
  const missing = await classify(task, settings(), [], { fetchJson, env: {} });
  const empty = await classify(task, settings(), [], { fetchJson, env: { TEST_KEY: "" } });
  assert.equal(calls.length, 0);
  assert.equal(missing.source, "heuristic");
  assert.match(missing.reason, /^TEST_KEY is not set; /);
  assert.match(empty.reason, /^TEST_KEY is not set; /);
});

test("a 9000-character prompt is truncated to its first 4000 and last 2000 characters", async () => {
  const head = "A".repeat(4000);
  const middle = "M".repeat(3000);
  const tail = "Z".repeat(2000);
  const { calls, fetchJson } = fakeFetch(decisions("normal"));
  await classify(
    { title: "Long", prompt: head + middle + tail, systemPrompt: null },
    settings(),
    [],
    { fetchJson, env },
  );
  assert.deepEqual(requestBody(calls).state, {
    title: "Long",
    task: `${head}\n[... truncated ...]\n${tail}`,
  });
});

test("a systemPrompt longer than 1500 characters keeps its first 1500", async () => {
  const { calls, fetchJson } = fakeFetch(decisions("normal"));
  await classify(
    { title: "Sys", prompt: null, systemPrompt: "S".repeat(1500) + "X".repeat(500) },
    settings(),
    [],
    { fetchJson, env },
  );
  assert.deepEqual(requestBody(calls).state, { title: "Sys", system_prompt: "S".repeat(1500) });
});

test("heuristic: hard keyword wins", () => {
  const result = classifyHeuristically(
    { title: "Migrate the session store", prompt: "typo fixes too", systemPrompt: null },
    [],
  );
  assert.deepEqual(result, {
    tier: "hard",
    needs: [],
    reason: "keyword: migrate",
    source: "heuristic",
  });
});

test("heuristic: tiny keyword in a short task", () => {
  const result = classifyHeuristically(
    { title: "Fix typo in README", prompt: null, systemPrompt: null },
    [],
  );
  assert.equal(result.tier, "tiny");
  assert.equal(result.reason, "keyword: typo");
});

test("heuristic: short task without keywords is quick", () => {
  const result = classifyHeuristically(
    { title: "Update button label", prompt: null, systemPrompt: null },
    [],
  );
  assert.deepEqual(
    { tier: result.tier, reason: result.reason },
    { tier: "quick", reason: "short task" },
  );
});

test("heuristic: long task without keywords is normal", () => {
  const result = classifyHeuristically(
    { title: "Add export", prompt: "word ".repeat(200), systemPrompt: null },
    [],
  );
  assert.deepEqual(
    { tier: result.tier, reason: result.reason },
    { tier: "normal", reason: "long task" },
  );
});

test("heuristic: image_generation needs when the capability is available", () => {
  const result = classifyHeuristically(
    { title: "Generate a logo for the landing page", prompt: null, systemPrompt: null },
    ["image_generation", "vision"],
  );
  assert.deepEqual(result.needs, ["image_generation"]);
});

test("heuristic: vision needs when the capability is available", () => {
  const result = classifyHeuristically(
    { title: "Match the screenshot of the dashboard", prompt: null, systemPrompt: null },
    ["image_generation", "vision"],
  );
  assert.deepEqual(result.needs, ["vision"]);
});

test("heuristic: no needs when the capability is not in the list", () => {
  const imageTask = { title: "Generate a logo", prompt: null, systemPrompt: null };
  const visionTask = { title: "Match the screenshot", prompt: null, systemPrompt: null };
  assert.deepEqual(classifyHeuristically(imageTask, []).needs, []);
  assert.deepEqual(classifyHeuristically(visionTask, ["image_generation"]).needs, []);
});

test("the decision model list keeps id, name and input price and skips malformed rows", async () => {
  const { calls, fetchJson } = fakeFetch({
    data: [
      { id: "typesafe/jev-1.13", name: "TypeSafe: Jev 1.13", pricing: { prompt: "0.000000042" } },
      { id: "openai/gpt-6-luna-decisions", pricing: {} },
      { name: "no id" },
    ],
  });
  const models = await listDecisionModels(fetchJson);
  assert.equal(calls[0].url, "https://openrouter.ai/api/v1/models?output_modalities=decisions");
  assert.equal(models.length, 2);
  assert.equal(models[0].name, "TypeSafe: Jev 1.13");
  assert.ok(Math.abs(models[0].usdPerMTok! - 0.042) < 1e-9);
  assert.deepEqual(models[1], {
    id: "openai/gpt-6-luna-decisions",
    name: "openai/gpt-6-luna-decisions",
    usdPerMTok: null,
  });
  await assert.rejects(listDecisionModels(fakeFetch({ error: "x" }).fetchJson), /malformed/);
});
