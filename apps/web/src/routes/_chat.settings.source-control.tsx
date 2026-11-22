import { createFileRoute } from "~/ui-core/router";

import { SourceControlSettingsPanel } from "../components/settings/SourceControlSettings";

export const Route = createFileRoute("/_chat/settings/source-control")({
  component: SourceControlSettingsPanel,
});
