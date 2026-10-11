/** Owns the create hook: turns an `auto/<mode>` request into a concrete provider and model. */
import type { AgentSessionConfig } from "@getpaseo/protocol/agent-types";
import {
  autoProviderId,
  routingModes,
  tiers,
  type ClassifierSettings,
  type DecisionRecord,
  type RouterSettings,
  type RoutingMode,
  type Tier,
} from "../shared/router.ts";
import type { Classification, ProviderCatalog, QuotaSnapshot, TaskText } from "./contracts.ts";
import { NoRouteError, selectRoute } from "./policy.ts";

export interface RouterGateway {
  readCatalog(cwd: string): Promise<ProviderCatalog>;
  findSpawn(title: string): Promise<Spawn | null>;
}

export interface Spawn {
  prompt: string;
  pinned: boolean;
}

export interface RouterDeps {
  readSettings(): Promise<RouterSettings>;
  readQuota(settings: RouterSettings): Promise<QuotaSnapshot>;
  classify(
    task: TaskText,
    settings: ClassifierSettings,
    capabilities: readonly string[],
    signal: AbortSignal,
  ): Promise<Classification>;
  now(): number;
  log(event: string, fields: Record<string, unknown>): void;
}

const derivedCapabilities = ["vision", "image_generation"];
const keptDecisions = 20;
// Paseo announces a created agent within seconds; silence this long means creation failed.
const startGraceMs = 90_000;
// A first turn failing this soon never got going: bad login, no credits, limit already hit.
const failFastMs = 180_000;
const trackedAgents = 200;

interface Launch {
  route: string;
  provider: string;
  title: string;
  at: number;
}

export interface PausedRoute {
  route: string;
  until: string;
  why: string;
}

const spawnRuleHeading = "## Spawning agents: use the Auto router";

/** Appended to new agents' system prompts so they route their own sub-agents. */
export const spawnRule = `${spawnRuleHeading}
When you create an agent, for example with the Paseo create_agent tool, do not choose a provider or model yourself. Pass one of these as the provider and model:
- \`auto/economic\`: cheapest model that fits the task. Use it for mechanical or repetitive work.
- \`auto/balanced\`: spends subscription quota evenly. Use it for everything else.
- \`auto/performance\`: most capable model. Use it for high-risk work, or after a cheaper run failed.
The router reads the task title and prompt, judges the difficulty and picks the provider, model, permission mode and thinking level. Describe the real work in both and leave the mode unset. When you know the difficulty, set the thinking option to \`tiny\`, \`quick\`, \`normal\` or \`hard\`. When the task needs a capability, append it, as in \`auto/balanced+image_generation\`.
Move up one mode at a time, and only after a run actually failed. If creation fails with "No route can serve this task", the error says why each model was passed over: fix the request or wait for the reset it names. A concrete provider and model that you name yourself is replaced by the router's choice. When the user asks for a specific model, name it and add \`labels: { "auto-router": "pin" }\` to the create call so it is kept.`;

export class AutoRouter {
  private readonly deps: RouterDeps;
  private readonly decisions: DecisionRecord[] = [];
  /** Routed creations not yet announced by Paseo, oldest first. */
  private readonly launching: Launch[] = [];
  /** Announced agents whose first turn has not ended, by agent id. */
  private readonly started = new Map<string, Launch>();
  private readonly pauses = new Map<string, { until: number; why: string }>();
  private pauseMs = 0;

  constructor(deps: RouterDeps) {
    this.deps = deps;
  }

  /**
   * Runs for every created agent. Example: `auto/balanced` becomes `claude/claude-haiku-5-5`;
   * concrete providers keep their choice unless enforcement finds a pending agent spawn.
   */
  async route(
    config: AgentSessionConfig,
    gateway: RouterGateway,
    signal: AbortSignal,
  ): Promise<AgentSessionConfig | undefined> {
    const auto = config.provider === autoProviderId;
    // Unreadable settings may fail an `auto` request, but never an unrelated creation.
    const settings = auto
      ? await this.deps.readSettings()
      : await this.deps.readSettings().catch(() => null);
    const routed = auto
      ? await this.pick(config, settings!, gateway, signal, null)
      : settings?.enforce
        ? await this.enforceRouting(config, settings, gateway, signal)
        : config;
    if (settings?.injectSpawnRule && !routed.systemPrompt?.includes(spawnRuleHeading)) {
      return {
        ...routed,
        systemPrompt: [routed.systemPrompt, spawnRule].filter(Boolean).join("\n\n"),
      };
    }
    return routed === config ? undefined : routed;
  }

  private async enforceRouting(
    config: AgentSessionConfig,
    settings: RouterSettings,
    gateway: RouterGateway,
    signal: AbortSignal,
  ): Promise<AgentSessionConfig> {
    const title = config.title ?? "";
    let spawn: Spawn | null;
    try {
      spawn = await gateway.findSpawn(title);
    } catch (error) {
      this.deps.log("enforce_skipped", { title, reason: String(error) });
      return config;
    }
    if (!spawn) return config;
    if (spawn.pinned) {
      this.deps.log("enforce_skipped", { title, reason: "pinned" });
      return config;
    }
    try {
      return await this.pick(config, settings, gateway, signal, {
        prompt: spawn.prompt,
        replaced: `${config.provider}/${config.model ?? "default"}`,
      });
    } catch (error) {
      this.deps.log("enforce_skipped", {
        title,
        reason: error instanceof Error ? error.message : String(error),
      });
      return config;
    }
  }

  private async pick(
    config: AgentSessionConfig,
    settings: RouterSettings,
    gateway: RouterGateway,
    signal: AbortSignal,
    enforced: { prompt: string; replaced: string } | null,
  ): Promise<AgentSessionConfig> {
    const [requested = "", ...explicitNeeds] = enforced
      ? ["balanced"]
      : (config.model ?? "balanced").split("+");
    const forced = settings.forceMode !== "off";
    const modeName = forced ? settings.forceMode : requested;
    if (!isRoutingMode(modeName)) {
      throw new Error(
        `Unknown auto mode "${modeName}". Use auto/economic, auto/balanced or auto/performance.`,
      );
    }
    this.pauseMs = settings.pauseMinutes * 60_000;
    this.expireLaunches();
    const title = config.title ?? "";
    const [quota, catalog, classification] = await Promise.all([
      this.deps.readQuota(settings),
      gateway.readCatalog(config.cwd),
      this.classify(config, title, settings, gateway, signal, enforced?.prompt),
    ]);
    const needs = [...new Set([...classification.needs, ...explicitNeeds])];
    const paused = this.paused();
    const skipped = paused.map(
      (pause) => `${pause.route}: ${pause.why}, paused until ${pause.until}`,
    );
    const routes = settings.routes.filter(
      (route) => !paused.some((pause) => pause.route === routeKey(route)),
    );
    const decision = withSkipped(skipped, () =>
      selectRoute(
        { mode: modeName, tier: classification.tier, needs },
        { ...settings, routes },
        quota,
        catalog,
      ),
    );
    const record: DecisionRecord = {
      at: new Date(this.deps.now()).toISOString(),
      title,
      mode: modeName,
      tier: classification.tier,
      needs,
      classifiedBy: classification.source,
      provider: decision.route.provider,
      model: decision.route.model,
      reason: [
        classification.reason.replace(/\.+$/, ""),
        enforced ? `Replaced requested ${enforced.replaced}` : "",
        !enforced && forced && requested !== modeName
          ? `Mode forced in settings (asked for ${requested})`
          : "",
        decision.reason,
        tokensLeft(decision.remainingTokens),
      ]
        .filter(Boolean)
        .join(". "),
    };
    this.decisions.unshift(record);
    this.decisions.length = Math.min(this.decisions.length, keptDecisions);
    this.deps.log("routed", { ...record, rejected: [...skipped, ...decision.rejected] });
    this.launching.push({
      route: routeKey(decision.route),
      provider: decision.route.provider,
      title,
      at: this.deps.now(),
    });

    // The remaining selections belonged to `auto`; the chosen provider would reject them.
    const {
      modeId: _modeId,
      thinkingOptionId: _thinking,
      featureValues: _features,
      ...rest
    } = config;
    return {
      ...rest,
      provider: decision.route.provider,
      model: decision.route.model,
      ...(decision.modeId ? { modeId: decision.modeId } : {}),
      ...(decision.thinkingOptionId ? { thinkingOptionId: decision.thinkingOptionId } : {}),
    };
  }

  recent(): readonly DecisionRecord[] {
    return this.decisions;
  }

  /** Paseo announced an agent; a matching routed creation has its session. */
  agentCreated(agent: { id: string; provider: string; title: string | null }): void {
    const index = this.launching.findIndex(
      (launch) => launch.provider === agent.provider && launch.title === (agent.title ?? ""),
    );
    if (index < 0) return;
    const [launch] = this.launching.splice(index, 1);
    this.started.set(agent.id, launch);
    this.deps.log("launch_started", { agentId: agent.id, route: launch.route });
    if (this.started.size > trackedAgents) this.started.delete([...this.started.keys()][0]);
  }

  /** Judges only an agent's first turn: later failures say nothing about starting. */
  turnEnded(agentId: string, error: string | null): void {
    const launch = this.started.get(agentId);
    if (!launch) return;
    this.started.delete(agentId);
    this.deps.log("first_turn_ended", { agentId, route: launch.route, error });
    if (error !== null && this.deps.now() - launch.at <= failFastMs) {
      this.pause(launch.route, `first turn failed (${error.slice(0, 120)})`, this.deps.now());
    }
  }

  /** Routes currently skipped because they failed to start. */
  paused(): PausedRoute[] {
    const now = this.deps.now();
    for (const [route, pause] of this.pauses) if (pause.until <= now) this.pauses.delete(route);
    return [...this.pauses].map(([route, pause]) => ({
      route,
      until: new Date(pause.until).toISOString(),
      why: pause.why,
    }));
  }

  private expireLaunches(): void {
    const now = this.deps.now();
    while (this.launching.length > 0 && now - this.launching[0].at > startGraceMs) {
      const launch = this.launching.shift()!;
      this.pause(launch.route, "agent was never created", launch.at);
    }
  }

  private pause(route: string, why: string, from: number): void {
    if (this.pauseMs <= 0) return;
    this.pauses.set(route, { until: from + this.pauseMs, why });
    this.deps.log("route_paused", { route, why, minutes: this.pauseMs / 60_000 });
  }

  private async classify(
    config: AgentSessionConfig,
    title: string,
    settings: RouterSettings,
    gateway: RouterGateway,
    signal: AbortSignal,
    enforcedPrompt?: string,
  ): Promise<Classification> {
    if (enforcedPrompt === undefined && isTier(config.thinkingOptionId)) {
      return { tier: config.thinkingOptionId, needs: [], reason: "", source: "explicit" };
    }
    const prompt =
      enforcedPrompt ??
      (await gateway
        .findSpawn(title)
        .then((spawn) => spawn?.prompt ?? null)
        .catch((error: unknown) => {
          this.deps.log("spawn_prompt_unreadable", { error: String(error) });
          return null;
        }));
    this.deps.log("classifying", { title, promptChars: prompt?.length ?? null });
    const capabilities = [
      ...new Set([
        ...settings.routes.flatMap((route) => route.capabilities),
        ...derivedCapabilities,
      ]),
    ];
    return this.deps.classify(
      { title, prompt, systemPrompt: config.systemPrompt ?? null },
      settings.classifier,
      capabilities,
      signal,
    );
  }
}

function routeKey(route: { provider: string; model: string }): string {
  return `${route.provider}/${route.model}`;
}

/** Keeps paused routes in the failure text, so "no route" explains every exclusion. */
function withSkipped<Result>(skipped: string[], select: () => Result): Result {
  try {
    return select();
  } catch (error) {
    if (error instanceof NoRouteError) throw new NoRouteError([...skipped, ...error.rejected]);
    throw error;
  }
}

function tokensLeft(tokens: number | null): string {
  if (tokens === null) return "";
  const amount = tokens >= 1e6 ? `${(tokens / 1e6).toFixed(1)}M` : `${Math.round(tokens / 1e3)}k`;
  return `About ${amount} tokens left at this model's price`;
}

function isRoutingMode(value: string): value is RoutingMode {
  return (routingModes as readonly string[]).includes(value);
}

function isTier(value: string | undefined): value is Tier {
  return (tiers as readonly string[]).includes(value ?? "");
}
