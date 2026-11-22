import { createFileRoute } from "~/ui-core/router";

// Renamed to /settings/labs; the settings route redirects old links.
export const Route = createFileRoute("/_chat/settings/beta")({});
