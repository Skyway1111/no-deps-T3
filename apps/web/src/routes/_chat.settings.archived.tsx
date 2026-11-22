import { createFileRoute } from "~/ui-core/router";

import { ArchivedThreadsPanel } from "../components/settings/ArchivedThreadsPanel";

export const Route = createFileRoute("/_chat/settings/archived")({
  component: ArchivedThreadsPanel,
});
