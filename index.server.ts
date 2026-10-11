/** Public server entrypoint: registers the `auto` provider, the create hook and the status RPC. */
import type { PaseoApi } from "@getpaseo/client";
import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { classify, listDecisionModels, type DecisionModel } from "./server/classifier.ts";
import type { FetchJson } from "./server/contracts.ts";
import { PaseoRouterGateway } from "./server/paseo.ts";
import { createAutoProvider } from "./server/provider.ts";
import { QuotaReader } from "./server/quota.ts";
import { AutoRouter } from "./server/router.ts";
import { routerSettings, routerStatus, type RouterSettings } from "./shared/router.ts";

// Routing runs inside a create hook that Paseo aborts after 30 seconds.
const httpTimeoutMs = 10_000;
const modelListTtlMs = 6 * 60 * 60_000;

const fetchJson: FetchJson = async (url, { signal, timeoutMs, ...init }) => {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  const timer = setTimeout(abort, timeoutMs ?? httpTimeoutMs);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${errorText(await response.text())}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
};

/** Providers answer errors as {"error": {"message"}}; the message alone keeps reasons readable. */
function errorText(body: string): string {
  try {
    const message: unknown = JSON.parse(body)?.error?.message;
    if (typeof message === "string") return message;
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return body.slice(0, 200);
}

/** Register automatic routing. Example: Paseo calls contribute(server) on activation. */
export default function contribute(server: PluginServerContext): PluginCleanup {
  const settings = server.registerSettings(routerSettings);
  // The SDK only arrives with a hook or RPC call, so quota reads borrow the latest one.
  let paseo: PaseoApi | undefined;
  const quota = new QuotaReader({
    listUsage: () => {
      if (!paseo) throw new Error("Paseo is not connected yet");
      return paseo.providers.listUsage();
    },
    fetchJson,
    env: process.env,
    now: Date.now,
  });
  const readSettings = async (): Promise<RouterSettings> => {
    const state = await settings.read();
    if (state.status === "ready") return state.values;
    throw new Error(
      `Auto router settings are invalid (${state.error}). Fix them in Settings > Plugins.`,
    );
  };
  const router = new AutoRouter({
    readSettings,
    readQuota: (values) => quota.read(values),
    classify: (task, classifier, capabilities, signal) =>
      classify(task, classifier, capabilities, { fetchJson, env: process.env, signal }),
    now: Date.now,
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  });

  let decisionModels: { at: number; list: DecisionModel[] } | undefined;
  const readDecisionModels = async (): Promise<DecisionModel[]> => {
    if (decisionModels && Date.now() - decisionModels.at < modelListTtlMs) {
      return decisionModels.list;
    }
    try {
      decisionModels = { at: Date.now(), list: await listDecisionModels(fetchJson) };
    } catch (error) {
      console.error("Decision model list unavailable", error);
    }
    return decisionModels?.list ?? [];
  };

  server.registerProvider(createAutoProvider());
  server.before("agent.create", async ({ request }, context) => {
    paseo = context.paseo;
    const config = await router.route(
      request.config,
      new PaseoRouterGateway(context.paseo),
      context.signal,
    );
    return config ? { ...request, config } : undefined;
  });
  server.on("agent.created", (event) => router.agentCreated(event.agent));
  server.on("agent.turn_ended", (event) =>
    router.turnEnded(
      event.agent.id,
      event.outcome.kind === "failed" ? event.outcome.error.message : null,
    ),
  );
  server.handle(routerStatus, async (_input, context) => {
    paseo = context.paseo;
    const [snapshot, models] = await Promise.all([
      quota.read(await readSettings()),
      readDecisionModels(),
    ]);
    return {
      pools: Object.values(snapshot.pools).map(({ modelFractions: _models, ...pool }) => pool),
      paused: router.paused(),
      decisionModels: models,
      decisions: [...router.recent()],
    };
  });
  // Paseo removes the hook, listeners and provider when the plugin stops.
  return () => {};
}
