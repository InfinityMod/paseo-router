/** Task classifier: a decision model reads a new agent's task; keyword rules answer when it cannot. */
import type { ClassifierSettings, Tier } from "../shared/router.ts";
import { tiers } from "../shared/router.ts";
import type { Classification, FetchJson, TaskText } from "./contracts.ts";

export interface ClassifierDeps {
  fetchJson: FetchJson;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
}

const hardPattern =
  /\b(architect\w*|design\w*|migrat\w*|concurren\w*|race condition|deadlock|security|persistence|protocol|schema|root cause|performance|refactor\w*)\b/;
const tinyPattern = /\b(typo|rename|bump|comment|format\w*|one[- ]line|whitespace)\b/;
const imagePattern =
  /\b(generate|create|draw|make|design|render)\b[^.\n]{0,40}\b(image|picture|illustration|icon|logo|artwork)s?\b/;
const visionPattern = /\b(screenshot|attached image|mockup|look at (the|this) (image|picture))\b/;

export const decisionsUrl = "https://openrouter.ai/api/alpha/decisions";

export const decisionModelsUrl = "https://openrouter.ai/api/v1/models?output_modalities=decisions";

export interface DecisionModel {
  id: string;
  name: string;
  /** USD per million input tokens; decision models charge nothing for output. */
  usdPerMTok: number | null;
}

/** Decision models OpenRouter offers now. Example: feeds the model selector in Settings. */
export async function listDecisionModels(fetchJson: FetchJson): Promise<DecisionModel[]> {
  const data = ((await fetchJson(decisionModelsUrl, { method: "GET" })) as { data?: unknown })
    ?.data;
  if (!Array.isArray(data)) throw new Error("malformed models response");
  return data.flatMap((model) => {
    if (typeof model?.id !== "string") return [];
    const price = Number(model.pricing?.prompt);
    return [
      {
        id: model.id,
        name: typeof model.name === "string" ? model.name : model.id,
        usdPerMTok: Number.isFinite(price) ? price * 1e6 : null,
      },
    ];
  });
}

// A wrongly required capability can leave no usable model, so only clear answers count.
const needThreshold = 0.7;

const tierCriteria: Record<Tier, string> = {
  tiny: "A small, localized, low-risk and unambiguous change: a few lines in one file.",
  quick:
    "A localized low-risk or mechanical change across a few call sites, with no contract, schema or persistence change.",
  normal:
    "A bounded feature or bug fix that needs reading call sites and conventions and adding focused tests.",
  hard: "High-risk or cross-module work: concurrency, persistence, protocols, security, performance invariants, architecture, design or planning, or deep root-cause analysis.",
};

const needQuestions: Record<string, string> = {
  image_generation:
    "Does completing the task require generating new images, such as illustrations, icons or artwork?",
  vision: "Does completing the task require looking at images, screenshots or mockups?",
};

/** Never throws: any failure falls back to the keyword rules and says why in `reason`. */
export async function classify(
  task: TaskText,
  settings: ClassifierSettings,
  capabilities: readonly string[],
  deps: ClassifierDeps,
): Promise<Classification> {
  if (!settings.enabled) {
    return prefixed(classifyHeuristically(task, capabilities), "classifier disabled; ");
  }
  const apiKey = deps.env[settings.apiKeyEnv];
  if (!apiKey) {
    return prefixed(
      classifyHeuristically(task, capabilities),
      `${settings.apiKeyEnv} is not set; `,
    );
  }
  try {
    const response = await deps.fetchJson(decisionsUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: settings.model,
        state: taskState(task),
        questions: {
          tier: {
            type: "choice",
            instructions: "How difficult is the coding task?",
            criteria: tierCriteria,
          },
          ...Object.fromEntries(
            capabilities.map((capability) => [
              needKey(capability),
              {
                type: "noul",
                instructions:
                  needQuestions[capability] ??
                  `Does completing the task require the "${capability}" capability?`,
              },
            ]),
          ),
        },
      }),
      signal: deps.signal,
      timeoutMs: settings.timeoutMs,
    });
    return parseAnswers(response, capabilities);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return prefixed(classifyHeuristically(task, capabilities), `classifier failed: ${message}; `);
  }
}

export function classifyHeuristically(
  task: TaskText,
  capabilities: readonly string[],
): Classification {
  const text = `${task.title}\n${task.prompt ?? ""}`.toLowerCase();
  const length = text.length;
  const needs: string[] = [];
  if (capabilities.includes("image_generation") && imagePattern.test(text)) {
    needs.push("image_generation");
  }
  if (capabilities.includes("vision") && visionPattern.test(text)) needs.push("vision");

  const hard = hardPattern.exec(text);
  if (hard) return { tier: "hard", needs, reason: `keyword: ${hard[1]}`, source: "heuristic" };
  const tiny = tinyPattern.exec(text);
  if (tiny && length < 400) {
    return { tier: "tiny", needs, reason: `keyword: ${tiny[1]}`, source: "heuristic" };
  }
  if (length < 600) return { tier: "quick", needs, reason: "short task", source: "heuristic" };
  return { tier: "normal", needs, reason: "long task", source: "heuristic" };
}

function prefixed(result: Classification, prefix: string): Classification {
  return { ...result, reason: prefix + result.reason };
}

/** A capability named "tier" must not replace the difficulty question. */
function needKey(capability: string): string {
  return `needs_${capability}`;
}

function taskState(task: TaskText): Record<string, string> {
  return {
    title: task.title,
    ...(task.prompt ? { task: truncatePrompt(task.prompt) } : {}),
    ...(task.systemPrompt ? { system_prompt: task.systemPrompt.slice(0, 1500) } : {}),
  };
}

/** Keeps the start and end of long prompts, where the goal and the constraints usually sit. */
function truncatePrompt(prompt: string): string {
  if (prompt.length <= 6000) return prompt;
  return `${prompt.slice(0, 4000)}\n[... truncated ...]\n${prompt.slice(-2000)}`;
}

function parseAnswers(response: unknown, capabilities: readonly string[]): Classification {
  const answers = (response as { answers?: Record<string, Record<string, unknown>> } | null)
    ?.answers;
  const tier = answers?.tier?.choice;
  if (!isTier(tier)) throw new Error(`reply has no valid tier (${JSON.stringify(tier)})`);
  const needs = capabilities.filter((capability) => {
    const likelihood = answers?.[needKey(capability)]?.noul;
    return typeof likelihood === "number" && likelihood >= needThreshold;
  });
  const confidence = answers?.tier?.confidence;
  const reason =
    typeof confidence === "number"
      ? `Jev: ${tier}, confidence ${confidence.toFixed(2)}`
      : `Jev: ${tier}`;
  return { tier, needs, reason, source: "llm" };
}

function isTier(value: unknown): value is Tier {
  return tiers.includes(value as Tier);
}
