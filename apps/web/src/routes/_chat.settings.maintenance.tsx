import { createFileRoute } from "~/ui-core/router";
import { MaintenanceSettingsPanel } from "../components/settings/SettingsPanels";

export const Route = createFileRoute("/_chat/settings/maintenance")({
  component: MaintenanceSettingsPanel,
});
