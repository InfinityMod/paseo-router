/** Settings screen: live quota pools, recent decisions, reserve and model switches, raw settings JSON. */
import { useEffect, useState, type ReactElement } from "react";
import type { RpcOutput } from "@getpaseo/plugin";
import {
  type PluginSurfaceProps,
  type SettingsState,
  useRpc,
  useSettings,
} from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Text, TextInput, View } from "react-native";
import {
  routerSettings,
  routerStatus,
  routingModes,
  settingsSchema,
  tiers,
  type Route,
  type RouterSettings,
} from "../shared/router.ts";

type PluginTheme = PluginSurfaceProps["theme"];
type PluginLayout = PluginSurfaceProps["layout"];
type RouterStatus = RpcOutput<typeof routerStatus>;
type RouterSettingsState = SettingsState<typeof settingsSchema>;
/** Editor text plus the revision it was seeded from; saves use that revision. */
interface Draft {
  text: string;
  revision: string;
}

/** Router status and settings. Paseo owns scrolling, so the root is a plain View. */
export function RouterSettingsScreen({ theme, layout }: PluginSurfaceProps): ReactElement {
  const readStatus = useRpc(routerStatus);
  const status = useQuery({
    queryKey: ["router", "status"],
    queryFn: () => readStatus({}),
    refetchInterval: 60_000,
  });
  const settings = useSettings(routerSettings);
  const pools = status.data?.pools ?? [];
  const paused = status.data?.paused ?? [];
  const decisions = status.data?.decisions.slice(0, 10) ?? [];
  return (
    <View
      style={{ gap: 16, padding: layout.compact ? 12 : 20, backgroundColor: theme.colors.surface0 }}
    >
      <SettingsSection title="Pools">
        <SettingsCard>
          {status.error && <SettingsRow label="Status unavailable" error={status.error.message} />}
          {status.isPending && <SettingsRow label="Loading…" />}
          {pools.map((pool) => (
            <SettingsRow
              key={pool.poolId}
              label={pool.poolId}
              hint={`${pool.planLabel ?? "no plan"} · ${pool.detail}`}
            >
              <Text style={{ color: theme.colors.foregroundMuted }}>{poolTrailing(pool)}</Text>
            </SettingsRow>
          ))}
          {paused.map((pause) => (
            <SettingsRow
              key={pause.route}
              label={`${pause.route} paused`}
              hint={`${pause.why} · until ${new Date(pause.until).toLocaleTimeString()}`}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Recent decisions">
        <SettingsCard>
          {status.data && decisions.length === 0 && <SettingsRow label="No agents routed yet" />}
          {decisions.map((decision, index) => (
            <SettingsRow
              key={`${decision.at}:${index}`}
              label={decision.title}
              hint={`${decision.mode} · ${decision.tier} (${decision.classifiedBy}) → ${decision.provider}/${decision.model} — ${decision.reason}`}
            />
          ))}
        </SettingsCard>
      </SettingsSection>
      <ModelsSection settings={settings} models={status.data?.providerModels ?? []} />
      <ClassifierSection
        settings={settings}
        models={status.data?.decisionModels ?? []}
        lastReason={status.data?.decisions[0]?.reason ?? ""}
      />
      <CatalogSection settings={settings} theme={theme} layout={layout} />
    </View>
  );
}

function poolTrailing(pool: RouterStatus["pools"][number]): string {
  const parts: string[] = [pool.status];
  if (pool.remainingFraction !== null) {
    parts.push(`${Math.round(pool.remainingFraction * 100)}%`);
  }
  if (pool.remainingUsd !== null) {
    parts.push(`$${pool.remainingUsd.toFixed(2)}`);
  }
  if (pool.pace !== null) {
    parts.push(`pace ${pool.pace.toFixed(1)}x`);
  }
  return parts.join(" · ");
}

/** Explains a settings state that cannot be edited. Empty string when ready. */
function settingsNotice(settings: RouterSettingsState): string {
  switch (settings.status) {
    case "loading":
      return "Loading settings…";
    case "error":
      return `Settings unavailable: ${settings.error}`;
    case "invalid":
      return `Stored settings are invalid: ${settings.error}`;
    case "ready":
      return "";
  }
}

const reserveChoices = [0.03, 0.05, 0.1, 0.15, 0.2, 0.3, 0.5];

/** Routing controls for provider pools and model routes. Each change saves at once. */
function ModelsSection({
  settings,
  models,
}: {
  settings: RouterSettingsState;
  models: RouterStatus["providerModels"];
}): ReactElement {
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [selectedPools, setSelectedPools] = useState<Record<string, string>>({});
  const [selectedTiers, setSelectedTiers] = useState<Record<string, Route["tiers"]>>({});
  const [openCategories, setOpenCategories] = useState<string | null>(null);
  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Models and providers">
        <SettingsCard>
          <SettingsRow label={settingsNotice(settings)} />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const { values, revision, saving } = settings;
  const setEnabled = (matches: (route: Route) => boolean, enabled: boolean): void =>
    void settings.save(
      {
        ...values,
        routes: values.routes.map((route) => (matches(route) ? { ...route, enabled } : route)),
      },
      revision,
    );
  // A reserve typed into the catalog stays selectable next to the presets.
  const reserves = [...new Set([...reserveChoices, values.minFraction])].sort((a, b) => a - b);
  const poolIds = [...new Set(values.routes.map((route) => route.pool))];
  const availableModels = models.filter(
    ({ provider, model }) =>
      !values.routes.some((route) => route.provider === provider && route.model === model),
  );
  return (
    <>
      <SettingsSection title="Routing">
        <SettingsCard>
          <SettingsSwitch
            label="Tell agents to use the router"
            hint="Adds a short rule to the system prompt of every new agent, so it spawns its own sub-agents through auto. Agents that already exist are not changed."
            value={values.injectSpawnRule}
            disabled={saving}
            onValueChange={(injectSpawnRule) =>
              void settings.save({ ...values, injectSpawnRule }, revision)
            }
          />
          <SettingsSwitch
            label="Route every agent that agents spawn"
            hint="Replaces a provider and model an agent names with the router's choice. Agents you start yourself, and spawns labelled auto-router: pin, are left alone."
            value={values.enforce}
            disabled={saving}
            onValueChange={(enforce) => void settings.save({ ...values, enforce }, revision)}
          />
          <SettingsSelect
            label="Force mode"
            hint="Every routed agent uses this mode, whichever one the spawning agent asked for."
            value={values.forceMode}
            options={[
              { label: "Off: use the requested mode", value: "off" },
              ...routingModes.map((mode) => ({
                label: mode[0].toUpperCase() + mode.slice(1),
                value: mode,
              })),
            ]}
            disabled={saving}
            onValueChange={(forceMode: RouterSettings["forceMode"]) =>
              void settings.save({ ...values, forceMode }, revision)
            }
          />
          <SettingsSelect
            label="Keep in reserve"
            hint="A subscription or balance at or below this share is left alone, so the agents that spawn others keep working."
            value={String(values.minFraction)}
            options={reserves.map((share) => ({
              label: `${Math.round(share * 100)}%`,
              value: String(share),
            }))}
            disabled={saving}
            onValueChange={(share) =>
              void settings.save({ ...values, minFraction: Number(share) }, revision)
            }
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Models and providers">
        {poolIds.map((poolId) => {
          const routes = values.routes.filter((route) => route.pool === poolId);
          return (
            <SettingsCard key={poolId}>
              <SettingsSwitch
                label={`Use ${poolId}`}
                hint="Switches every model of this provider on or off."
                value={routes.some((route) => route.enabled)}
                disabled={saving}
                onValueChange={(enabled) => setEnabled((route) => route.pool === poolId, enabled)}
              />
              {routes.map((route) => {
                const categoryKey = `route:${route.provider}/${route.model}`;
                const categoriesOpen = openCategories === categoryKey;
                return (
                  <View
                    key={`${route.provider}/${route.model}`}
                    style={{ gap: 4, paddingVertical: 8 }}
                  >
                    <SettingsSwitch
                      label={`${route.provider}/${route.model}`}
                      hint={`${route.tiers.join(", ")} tasks · quality ${route.quality}`}
                      value={route.enabled}
                      disabled={saving}
                      onValueChange={(enabled) =>
                        setEnabled((candidate) => candidate === route, enabled)
                      }
                    />
                    <SettingsAction
                      label={`Task categories: ${route.tiers.join(", ")}`}
                      actionLabel={categoriesOpen ? "Done" : "Edit"}
                      disabled={saving}
                      onPress={() => setOpenCategories(categoriesOpen ? null : categoryKey)}
                    />
                    {categoriesOpen &&
                      tiers.map((tier) => (
                        <SettingsSwitch
                          key={tier}
                          label={tier}
                          value={route.tiers.includes(tier)}
                          disabled={saving || (route.tiers.length === 1 && route.tiers[0] === tier)}
                          onValueChange={(included) =>
                            void settings.save(
                              {
                                ...values,
                                routes: values.routes.map((candidate) =>
                                  candidate === route
                                    ? {
                                        ...candidate,
                                        tiers: included
                                          ? [...new Set([...candidate.tiers, tier])]
                                          : candidate.tiers.filter((value) => value !== tier),
                                      }
                                    : candidate,
                                ),
                              },
                              revision,
                            )
                          }
                        />
                      ))}
                  </View>
                );
              })}
            </SettingsCard>
          );
        })}
      </SettingsSection>
      <SettingsSection title="Available provider models">
        {availableModels.length === 0 && (
          <SettingsCard>
            <SettingsRow label="No additional provider models available" />
          </SettingsCard>
        )}
        {[...new Set(availableModels.map(({ provider }) => provider))].map((provider) => {
          const providerModels = availableModels.filter((entry) => entry.provider === provider);
          const defaultPool =
            values.routes.find((route) => route.provider === provider)?.pool ??
            values.pools.find((pool) => pool.id === provider)?.id ??
            values.pools[0]?.id ??
            "";
          const model =
            providerModels.find((entry) => entry.model === selectedModels[provider]) ??
            providerModels[0];
          const pool = selectedPools[provider] ?? defaultPool;
          const categories: Route["tiers"] = selectedTiers[provider] ?? ["quick"];
          const categoryKey = `provider:${provider}`;
          const categoriesOpen = openCategories === categoryKey;
          return (
            <SettingsCard key={provider}>
              <SettingsRow label={`${provider} · ${providerModels.length} additional models`} />
              <SettingsSelect
                label="Model"
                value={model.model}
                options={providerModels.map(({ model }) => ({ label: model, value: model }))}
                disabled={saving}
                onValueChange={(value) =>
                  setSelectedModels({ ...selectedModels, [provider]: value })
                }
              />
              <SettingsSelect
                label="Pool"
                value={pool}
                options={values.pools.map(({ id }) => ({ label: id, value: id }))}
                disabled={saving || values.pools.length === 0}
                onValueChange={(value) => setSelectedPools({ ...selectedPools, [provider]: value })}
              />
              <SettingsAction
                label={`Task categories: ${categories.join(", ") || "none selected"}`}
                actionLabel={categoriesOpen ? "Done" : "Edit"}
                disabled={saving}
                onPress={() => setOpenCategories(categoriesOpen ? null : categoryKey)}
              />
              {categoriesOpen &&
                tiers.map((tier) => (
                  <SettingsSwitch
                    key={tier}
                    label={tier}
                    value={categories.includes(tier)}
                    disabled={saving}
                    onValueChange={(included) =>
                      setSelectedTiers({
                        ...selectedTiers,
                        [provider]: included
                          ? [...new Set([...categories, tier])]
                          : categories.filter((value) => value !== tier),
                      })
                    }
                  />
                ))}
              <SettingsAction
                label={`Add ${model.model} to routing`}
                actionLabel="Add model"
                disabled={saving || pool === "" || categories.length === 0}
                onPress={() =>
                  void settings.save(
                    {
                      ...values,
                      routes: [
                        ...values.routes,
                        {
                          provider,
                          model: model.model,
                          pool,
                          tiers: categories,
                          quality: 50,
                          capabilities: [],
                          thinking: {},
                          enabled: true,
                        },
                      ],
                    },
                    revision,
                  )
                }
              />
            </SettingsCard>
          );
        })}
      </SettingsSection>
    </>
  );
}

function ClassifierSection({
  settings,
  models,
  lastReason,
}: {
  settings: RouterSettingsState;
  models: RouterStatus["decisionModels"];
  lastReason: string;
}): ReactElement {
  const current = settings.status === "ready" ? settings.values.classifier.model : "";
  // The saved model stays selectable even when OpenRouter's list is unavailable.
  const options = [
    ...models.map((model) => ({
      label:
        model.usdPerMTok === null
          ? model.name
          : `${model.name} · $${model.usdPerMTok.toFixed(2)} per M tokens`,
      value: model.id,
    })),
    ...(models.some((model) => model.id === current) ? [] : [{ label: current, value: current }]),
  ];
  // A model the account may not use only shows up as a failed classification.
  const failure = /^classifier failed: [^;]*/.exec(lastReason)?.[0] ?? null;
  return (
    <SettingsSection title="Classifier">
      <SettingsCard>
        {settings.status === "ready" && (
          <SettingsSelect
            label="Decision model"
            hint="Asked through OpenRouter's Decisions API. Models blocked by your OpenRouter guardrails fail and keyword rules decide."
            error={failure}
            value={current}
            options={options}
            disabled={settings.saving}
            onValueChange={(model) =>
              void settings.save(
                { ...settings.values, classifier: { ...settings.values.classifier, model } },
                settings.revision,
              )
            }
          />
        )}
        {settings.status === "ready" ? (
          <SettingsSwitch
            label="Classify tasks with the decision model"
            hint="Keyword rules decide when this is off or the model cannot be reached."
            value={settings.values.classifier.enabled}
            disabled={settings.saving}
            onValueChange={(enabled) =>
              void settings.save(
                { ...settings.values, classifier: { ...settings.values.classifier, enabled } },
                settings.revision,
              )
            }
          />
        ) : (
          <SettingsRow label={settingsNotice(settings)} />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}

function CatalogSection({
  settings,
  theme,
  layout,
}: {
  settings: RouterSettingsState;
  theme: PluginTheme;
  layout: PluginLayout;
}): ReactElement {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  // Set after our own save or reset: the next ready state replaces the draft with the stored one.
  const [reseedPending, setReseedPending] = useState(false);
  // An untouched draft follows saves made elsewhere, so its revision never goes stale.
  const [dirty, setDirty] = useState(false);

  const storedRevision = settings.status === "ready" ? settings.revision : null;
  useEffect(() => {
    if (settings.status !== "ready") return;
    if (draft === null || reseedPending || !dirty) {
      setDraft({ text: JSON.stringify(settings.values, null, 2), revision: settings.revision });
      setReseedPending(false);
      setDirty(false);
    }
  }, [settings.status, storedRevision]);

  const notice = settingsNotice(settings);

  function saveDraft(): void {
    if (settings.status !== "ready" || draft === null) return;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(draft.text);
    } catch (error) {
      setDraftError(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const parsed = settingsSchema.safeParse(parsedJson);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      setDraftError(`${path}: ${issue.message}`);
      return;
    }
    setDraftError(null);
    void settings.save(parsed.data, draft.revision).then((saved) => {
      if (saved) setReseedPending(true);
    });
  }

  function resetDocument(): void {
    setDraftError(null);
    void settings.reset().then((done) => {
      if (done) setReseedPending(true);
    });
  }

  return (
    <SettingsSection title="Catalog (advanced)">
      <SettingsCard>
        {notice !== "" && <SettingsRow label={notice} />}
        {draft !== null && (
          <View style={{ gap: 8, padding: layout.compact ? 8 : 12 }}>
            <TextInput
              multiline
              value={draft.text}
              accessibilityLabel="Router settings JSON"
              onChangeText={(text) => {
                setDirty(true);
                setDraft((current) => current && { ...current, text });
              }}
              autoCapitalize="none"
              autoCorrect={false}
              textAlignVertical="top"
              style={{
                minHeight: 320,
                fontFamily: layout.platform === "ios" ? "Menlo" : "monospace",
                fontSize: 12,
                color: theme.colors.foreground,
                backgroundColor: theme.colors.surface2,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 6,
                padding: 8,
              }}
            />
            {draftError && <Text style={{ color: theme.colors.statusDanger }}>{draftError}</Text>}
            {settings.saveError && (
              <Text style={{ color: theme.colors.statusDanger }}>{settings.saveError}</Text>
            )}
          </View>
        )}
        {draft !== null && (
          <SettingsAction
            label="Save"
            actionLabel="Save"
            disabled={settings.saving}
            onPress={saveDraft}
          />
        )}
        {(settings.status === "ready" || settings.status === "invalid") && (
          <SettingsAction
            label="Reset to defaults"
            actionLabel="Reset"
            disabled={settings.saving}
            onPress={resetDocument}
          />
        )}
      </SettingsCard>
    </SettingsSection>
  );
}
