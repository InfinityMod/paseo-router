/** Internal adapter: reads provider catalogs and the spawning tool call through the Paseo SDK. */
import type { PaseoApi } from "@getpaseo/client";
import type { ProviderCatalog } from "./contracts.ts";
import type { RouterGateway, Spawn } from "./router.ts";

export type RouterSdk = {
  providers: Pick<PaseoApi["providers"], "snapshot">;
  agents: Pick<PaseoApi["agents"], "list" | "ref">;
};

const spawnTool = /create_agent$/;
// A spawning agent is mid tool call, so its request sits at the very end of its timeline.
const timelineTail = 8;
const maxParents = 12;

export class PaseoRouterGateway implements RouterGateway {
  private readonly paseo: RouterSdk;

  constructor(paseo: RouterSdk) {
    this.paseo = paseo;
  }

  async readCatalog(cwd: string): Promise<ProviderCatalog> {
    const snapshot = await this.paseo.providers.snapshot({ cwd });
    const catalog: ProviderCatalog = {};
    for (const entry of snapshot.entries) {
      if (entry.status !== "ready" || !entry.enabled) continue;
      catalog[entry.provider] = {
        models: Object.fromEntries(
          (entry.models ?? []).map((model) => [
            model.id,
            (model.thinkingOptions ?? []).map((option) => option.id),
          ]),
        ),
      };
    }
    return catalog;
  }

  /** The create hook receives no prompt; the parent's pending create_agent call still holds it. */
  async findSpawn(title: string): Promise<Spawn | null> {
    const { entries } = await this.paseo.agents.list();
    const parents = entries
      .map((entry) => entry.agent)
      .filter((agent) => agent.status === "running" && !agent.archivedAt)
      .slice(0, maxParents);
    const prompts = await Promise.all(
      parents.map(async (parent) => {
        const page = await this.paseo.agents
          .ref(parent.id)
          .timeline.refetch({ direction: "tail", limit: timelineTail });
        for (const { item } of page.entries.toReversed()) {
          if (item.type !== "tool_call" || item.status !== "running") continue;
          if (!spawnTool.test(item.name)) continue;
          const input = "input" in item.detail ? item.detail.input : null;
          if (!isRecord(input) || input.title !== title) continue;
          if (typeof input.initialPrompt === "string") {
            const labels = isRecord(input.labels) ? input.labels : {};
            return { prompt: input.initialPrompt, pinned: labels["auto-router"] === "pin" };
          }
        }
        return null;
      }),
    );
    return prompts.find((spawn) => spawn !== null) ?? null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
