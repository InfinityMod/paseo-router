# Paseo Auto router

Auto router chooses a provider and model when a Paseo agent is created. It considers the task's difficulty, required capabilities, available providers, remaining quota, cost, and when subscription quota expires.

Instead of maintaining model choices in every agent's prompt, ask for `auto/economic`, `auto/balanced`, or `auto/performance`. The plugin makes the choice and starts the agent on a real provider.

## Choose a routing mode

| Mode               | Use it for                                        | Selection                                                                                                                               |
| ------------------ | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `auto/economic`    | Mechanical work and tasks where cost matters most | Uses subscription quota first, then chooses the cheapest suitable model. Quota close to expiry is discounted.                           |
| `auto/balanced`    | Everyday development                              | Uses subscription quota first and favors pools with more quota left relative to the time until reset. Close calls go to cheaper models. |
| `auto/performance` | Work that needs stronger capabilities             | Chooses the highest-ranked available model suitable for the difficulty band, including paid credit pools.                               |

Economic and balanced prefer subscription quota because it is already paid for and disappears at reset. OpenRouter credits are used when no subscription model in the task's band is eligible. A reserve protects quota shared with the parent agent.

Difficulty has four bands: `tiny`, `quick`, `normal`, and `hard`. The classifier chooses a band from the task. If that band has no eligible model, the router tries harder bands, then easier ones. Pools without visible quota are considered after pools with known usable quota.

## Install

Requirements:

- Paseo **0.11.2 or later** on the daemon and client.
- Plugins enabled in **Settings → Plugins → Enable plugins**. Paseo plugins run as trusted code with the daemon user's access.
- At least one configured provider with an eligible model.
- Access to this repository while it is private.

The example uses `~/Documents/Development`; another directory works too.

```sh
mkdir -p ~/Documents/Development
cd ~/Documents/Development
git clone git@github.com:InfinityMod/paseo-router.git
cd paseo-router
paseo plugin install "$PWD"
paseo plugin ls
```

The installed ID is `paseo-router`. Local source changes take effect after:

```sh
paseo plugin reload paseo-router
```

## Use it

In Paseo's model picker, select the Auto provider and a routing mode. Through the `create_agent` MCP tool, put the provider and mode together in `provider`:

```json
{
  "provider": "auto/balanced",
  "title": "Add retry support",
  "initialPrompt": "Add bounded retries for failed API requests. Follow the existing client conventions, add regression tests, and report verification results."
}
```

Describe the real work in both the title and prompt. The router normally recovers an agent-spawned task's prompt from the parent's pending tool call; agents created from the app or CLI are classified by title alone.

Optional hints:

- Set `settings.thinkingOptionId` to `tiny`, `quick`, `normal`, or `hard` to skip classification. The router maps the band to the chosen provider's supported thinking setting.
- Require a capability in the provider string, for example `auto/performance+image_generation`. Models without it are excluded.
- When a specific concrete model must be kept, add `labels: { "auto-router": "pin" }` to the creation request. Pinning bypasses enforcement for a concrete provider/model.

## Configure it

Open **Settings → Plugins → Auto router**. The screen shows pool usage, plans, paused models, and recent decisions with their reasons.

| Setting                                    | What it changes                                                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Tell agents to use the router**          | Adds routing instructions to every new agent's system prompt. On by default; existing agents keep their saved instructions.                             |
| **Route every agent that agents spawn**    | Replaces concrete model choices in recognized agent-spawned requests. On by default. Agents started by the user and pinned requests keep their choices. |
| **Force mode**                             | Forces economic, balanced, or performance on routed requests. Off honors the requested mode. Capability requirements still apply.                       |
| **Keep in reserve**                        | Leaves pools at or below `minFraction` alone. The default is 15%; choose a reserve appropriate to your shared quota.                                    |
| **Models and providers**                   | Includes or excludes individual models or all models of a provider.                                                                                     |
| **Decision model**                         | Selects an OpenRouter decision model. The default is `typesafe/jev-1.13`.                                                                               |
| **Classify tasks with the decision model** | Enables decision-model classification; when off, keyword rules choose the difficulty.                                                                   |
| **Catalog editor**                         | Edits routes, bands, quality scores, plan values, estimated task tokens, permission modes, and pause duration.                                          |

Set `OPENROUTER_API_KEY` in the **daemon process's environment** to enable the decision model, credit balance checks, and OpenRouter routes. A variable set in an unrelated terminal does not reach an already-running desktop daemon. Without the key, keyword rules classify tasks and OpenRouter credit routes are skipped. A failed or blocked classifier request also falls back to keyword rules.

Settings are stored per daemon at `$PASEO_HOME/plugin-settings/paseo-router/router.json` (normally `~/.paseo/plugin-settings/paseo-router/router.json`). Reloads preserve them. Removing the installation deletes its settings.

## Boundaries and privacy

- Only agents created through Paseo reach the plugin. Provider-internal sub-agents, such as Claude's built-in task agents, are outside its control.
- Enforcement depends on recognizing the parent's pending `create_agent` call. If recognition or routing fails for a concrete request, the requested model is kept. An explicit `auto` request with no eligible model fails with a reason list.
- Model quality scores, bands, and subscription dollar values are configurable estimates. Remaining token estimates are approximate, not provider guarantees. Usage snapshots may be several minutes old.
- A failed start or early first-turn failure pauses that route for 30 minutes by default. Reloading clears these temporary pauses.
- Routed requests receive the configured permission mode for their chosen provider; review those settings before use.
- With the classifier enabled, the task title, a bounded prompt excerpt, and a bounded system-prompt excerpt are sent to OpenRouter. The API key is sent to OpenRouter for authenticated requests. See [the overview](OVERVIEW.md) for more detail.

## Troubleshoot and develop

```sh
paseo plugin ls
paseo plugin logs paseo-router
```

If a request fails, check the reason list for disabled models, missing capabilities, reserve, exhausted quota, or paused routes. Classifier guardrail and credit failures appear in the settings and decision reasons.

Development requires **Node.js 24 or later**:

```sh
npm ci --ignore-scripts
npm run check
```

The check typechecks against the pinned Paseo SDK, runs deterministic tests, and checks Prettier formatting. `server/router.ts` owns orchestration; `server/policy.ts` owns selection; quota, classification, and SDK adapters are separate modules. This repository develops independently of the Lumvise checkout.
