import { createFileRoute } from "~/ui-core/router";

import { AppearanceSettingsPanel } from "../components/settings/AppearanceSettingsPanel";

function SettingsAppearanceRoute() {
  return <AppearanceSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/appearance")({
  component: SettingsAppearanceRoute,
});
