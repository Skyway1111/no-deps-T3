import { createFileRoute } from "~/ui-core/router";

import { OpenSourceLicensesPanel } from "../components/settings/OpenSourceLicenses";

export const Route = createFileRoute("/_chat/settings/open-source-licenses")({
  component: OpenSourceLicensesPanel,
});
