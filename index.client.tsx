/** Public client entrypoint: adds the Auto router settings screen. */
import type { PluginCleanup } from "@getpaseo/plugin";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { RouterSettingsScreen } from "./client/settings.tsx";

/** Add the router settings screen under Settings → Plugins → Auto router. */
export default function contribute(client: PluginClientContext): PluginCleanup {
  const removeSettings = client.addSettingsScreen({
    id: "router",
    title: "Auto router",
    icon: "Route",
    Component: RouterSettingsScreen,
  });
  return () => removeSettings();
}
