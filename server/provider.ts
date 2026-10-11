/** Owns the selectable `auto` provider entry. It only lists choices; the create hook swaps it out. */
import type {
  ProviderConnection,
  ProviderEvent,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { autoProviderId, tiers } from "../shared/router.ts";

const modeHint = "Append +capability to require one, e.g. performance+image_generation.";

/** Paseo rejects unknown providers before plugin hooks run, so `auto` must be a real entry. */
export function createAutoProvider(): ProviderRegistration {
  return {
    id: autoProviderId,
    label: "Auto",
    description:
      "Picks the provider and model for a new agent from remaining quota, cost and task difficulty",
    async connect(request) {
      if (!request.versions.includes(1)) throw new Error("Provider protocol version 1 is required");
      return createConnection();
    },
  };
}

function createConnection(): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  return {
    version: 1,
    capabilities: [],
    async send(input) {
      if (input.type === "sessions") {
        queueMicrotask(() => emit({ type: "sessions", requestId: input.requestId, sessions: [] }));
        return;
      }
      if (input.type !== "catalog") {
        throw new Error(
          "Auto only chooses a model while an agent is created. Pick a concrete provider here.",
        );
      }
      queueMicrotask(() =>
        emit({
          type: "catalog",
          requestId: input.requestId,
          catalog: {
            models: [
              {
                id: "economic",
                label: "Economic",
                description: `Cheapest model in the task's difficulty band. ${modeHint}`,
              },
              {
                id: "balanced",
                label: "Balanced",
                description: `Spends providers evenly: the pool with the most quota left. ${modeHint}`,
                isDefault: true,
              },
              {
                id: "performance",
                label: "Performance",
                description: `Most capable available model in the task's difficulty band. ${modeHint}`,
              },
            ],
            modes: [],
            thinkingOptions: [
              { id: "auto", label: "Auto difficulty", description: "Classify the task" },
              ...tiers.map((tier) => ({ id: tier, label: `${tier} task` })),
            ],
            defaultModel: "balanced",
            defaultThinkingOption: "auto",
          },
        }),
      );
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      listeners.clear();
    },
  };

  function emit(event: ProviderEvent): void {
    for (const listener of listeners) listener(event);
  }
}
