import { createFileRoute } from "~/ui-core/router";

import { GuestPage } from "../components/guest/GuestPage";

export const Route = createFileRoute("/guest")({
  component: GuestPage,
});
