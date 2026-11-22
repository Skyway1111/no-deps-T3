import { createFileRoute } from "~/ui-core/router";

import { KeybindingsSettingsPanel } from "../components/settings/KeybindingsSettings";

export const Route = createFileRoute("/_chat/settings/keybindings")({
  component: KeybindingsSettingsPanel,
});
