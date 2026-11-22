import { createFileRoute } from "~/ui-core/router";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: () => null,
});
