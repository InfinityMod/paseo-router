# Auto router

Auto router chooses the provider and model for a new agent, so the agent that spawns it does not have to. Select `auto/economic`, `auto/balanced` or `auto/performance` wherever Paseo asks for a provider and model, including the `create_agent` tool. The agent then starts on a real provider such as Claude, Codex or Oh My Pi.

## How a model is chosen

1. A classifier reads the task and sorts it into one of four difficulty bands: tiny, quick, normal or hard. It also notes capabilities the task cannot do without, such as image generation.
2. Models that are not installed, lack a needed capability, or draw on an empty quota pool are removed.
3. Among the models allowed for that band, the mode decides:

| Mode        | Picks                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Economic    | Subscription quota before credits. Among subscriptions, the cheapest model by list price, with quota that would expire unused counted as cheaper.                                           |
| Balanced    | Subscription quota before credits. Among subscriptions, the pool with the most quota left for the time left, so pools drain evenly and little expires. Close calls go to the cheaper model. |
| Performance | The most capable model in the band, whatever it draws on.                                                                                                                                   |

Subscription quota is already paid for and is lost when its window resets. OpenRouter credits are real money and keep. So economic and balanced only fall back to credits when no subscription model in the band has quota.

Expiry is measured as pace: the share of quota left divided by the share of the window's time left. A pool with 80 percent left one hour before a five-hour window resets has a pace of 4 and is used first. A pool with 30 percent left at the start of its window has a pace of 0.3 and is spared. With several windows, the lowest pace counts.

Pools whose provider reports no quota at all, such as Kimi, are used only when no pool with visible quota fits. When no model in the band is usable, the next harder band is tried, then easier ones. If nothing is usable, the agent is not created and the error lists why each model was passed over.

A model that fails to start is paused for 30 minutes and other models take its place. That covers an agent that is never created and a first turn that fails within three minutes, for example on an expired login or empty credits. The pause length is `pauseMinutes` in the settings; 0 turns it off. Pauses are forgotten when the plugin reloads.

To skip the classifier, set the thinking option to `tiny`, `quick`, `normal` or `hard`. To require a capability, append it to the mode: `auto/performance+image_generation`.

## Quota and remaining tokens

Subscription pools (Claude, Codex, Kimi, Z.ai) use the plan and usage windows that Paseo already shows under Usage. Each plan has an estimated dollar value per window. Remaining share times that value, divided by a model's list price, gives the tokens that model can still spend. The shipped values for Claude Pro and Codex Pro Lite were measured in October 2026 by pricing local session logs against the reported usage share. Claude Max scales Pro by 5 and 20. Other plans have no value until you add one in the settings, so only their remaining share is used.

The OpenRouter pool reads your credit balance. List prices and image capabilities for all models come from OpenRouter's public model list.

## Setup

- `OPENROUTER_API_KEY` in the daemon's environment enables the classifier and the OpenRouter balance. Without it, the classifier falls back to keyword rules and OpenRouter models are skipped.
- The classifier defaults to TypeSafe's decision model `typesafe/jev-1.13`, asked through OpenRouter's Decisions API. Any decision model on OpenRouter can be selected. It answers one difficulty question and one yes-or-no question per capability, at about 0.04 dollars per million input tokens.
- Requires Paseo 0.11.2 or later.

## Settings

Settings > Plugins > Auto router shows each pool's plan, remaining share and dollar value, any paused models, and the latest routing decisions with their reasons.

- **Tell agents to use the router.** On by default. Adds a short rule to the system prompt of every new agent, whatever its provider, telling it to spawn its own agents through `auto`. Agents that already exist are not changed.
- **Route every agent that agents spawn.** On by default. When an agent spawns another agent and names a concrete provider and model, the router replaces that choice. Agents you start yourself keep the model you picked. A spawn carrying the label `auto-router: pin` is also left alone, for the cases where you tell an agent to use a specific model. If routing fails, the agent starts on the model that was named.
- **Force mode.** Set economic, balanced or performance to use that mode for every routed agent, whichever one the spawning agent asked for. Off honours the request.
- **Reserve.** A subscription or balance at or below this share is left alone, 15 percent by default. Routed agents share quota with the agent that spawned them, and the reserve keeps that agent working.
- **Models and providers.** One switch per model and one per provider. A model that is off stays in the catalog but is never chosen.
- **Classifier.** Choose the decision model from the ones OpenRouter offers, or switch the classifier off so keyword rules decide. A model blocked by your OpenRouter guardrails fails, keyword rules take over, and the failure is shown under the selector.

The catalog editor holds the full configuration as JSON: routes with their bands, quality and price, pools with their plan values, the token estimate per band, and the permission mode used per provider.

## What it sends and where

The task title and prompt, cut to 6,000 characters, go to OpenRouter's Decisions endpoint. Your OpenRouter key is sent only to OpenRouter. Nothing else leaves the machine.

## Limits

- Only agents created through Paseo are routed. Sub-agents that a provider starts inside its own session, such as Claude's built-in task agents, never reach the plugin.
- A spawn is recognised by the spawning agent's pending `create_agent` call. If that call cannot be read, the named model is kept.
- Paseo does not pass the prompt to plugins at creation. The plugin reads it from the spawning agent's pending `create_agent` call. Agents started from the app or the CLI are classified by title only.
- The classifier adds one model call to each routed creation.
- A capability counts as required when the classifier rates it at 0.7 or more.
- Quality scores and bands are set by hand in the catalog.
- New agents get the permission mode configured per provider. The defaults are Auto for Claude, Auto-review for Codex and Full Access for Oh My Pi.
- Usage data is refreshed by Paseo every five minutes, so a pool can run out between two reads.
- Pace is known for five-hour, daily, weekly and monthly windows. Other windows are compared by their remaining share.
