import { createFileRoute } from "~/ui-core/router";

import { VoiceSettingsPanel } from "../components/settings/VoiceSettingsPanel";

export const Route = createFileRoute("/_chat/settings/voice")({
  component: VoiceSettingsPanel,
});
