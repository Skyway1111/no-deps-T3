import { createFileRoute } from "~/ui-core/router";

import { PullRequestsPage } from "../components/pullRequest/PullRequestsPage";
import { validatePullRequestsSearch } from "../components/pullRequest/pullRequestsRouteSearch";

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: validatePullRequestsSearch,
  component: PullRequestsPage,
});
