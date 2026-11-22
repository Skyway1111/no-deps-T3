import { createFileRoute } from "~/ui-core/router";
import { ThreadsSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/threads")({
  component: ThreadsSettingsPanel,
});
