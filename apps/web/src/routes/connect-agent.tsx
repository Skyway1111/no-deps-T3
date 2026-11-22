import { createFileRoute } from "~/ui-core/router";

import { ConnectAgentSurface } from "../components/auth/ConnectAgentSurface";

export const Route = createFileRoute("/connect-agent")({
  component: ConnectAgentSurface,
});
