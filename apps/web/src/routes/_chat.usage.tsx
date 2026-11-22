import { createFileRoute } from "~/ui-core/router";

import { UsagePage } from "../components/usage/UsagePage";

export const Route = createFileRoute("/_chat/usage")({
  component: UsagePage,
});
