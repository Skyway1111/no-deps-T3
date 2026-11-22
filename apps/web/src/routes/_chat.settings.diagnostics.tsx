import { createFileRoute } from "~/ui-core/router";

import { DiagnosticsSettingsPanel } from "../components/settings/DiagnosticsSettings";

export const Route = createFileRoute("/_chat/settings/diagnostics")({
  component: DiagnosticsSettingsPanel,
});
