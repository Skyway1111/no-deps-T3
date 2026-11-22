import { createFileRoute } from "~/ui-core/router";

import { SnapShotSettings } from "../components/settings/SnapShotSettings";

function SettingsSnapShotRoute() {
  return <SnapShotSettings />;
}

export const Route = createFileRoute("/_chat/settings/snap-shot")({
  component: SettingsSnapShotRoute,
});
