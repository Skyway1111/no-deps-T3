import { createFileRoute } from "~/ui-core/router";

// Renamed to /settings/maintenance; the settings route redirects old links.
export const Route = createFileRoute("/_chat/settings/storage")({});
