import { useAtomValue } from "@effect/atom-react";
import {
  EMPTY_V2_ITEM_SUPPORT,
  resolveV2ItemSupport,
  v2ItemSupportEqual,
  type V2ItemSupport,
} from "@t3tools/client-runtime/state/item-support";
import type { EnvironmentId, ThreadId, TurnItemId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { Atom } from "effect/reactivity";

import { environmentThreadDetails } from "./threads";

function supportKey(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
}): string {
  return JSON.stringify(input);
}

function parseSupportKey(key: string): {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly itemId: TurnItemId;
} {
  return JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  };
}

// Follows the structure, so streamed text does not rescan the thread for every mounted row.
// `item` is the item as of the last structure change.
const itemSupportAtomFamily = Atom.family((key: string) => {
  const target = parseSupportKey(key);
  const ref = scopeThreadRef(target.environmentId, target.threadId);
  return Atom.make((get): V2ItemSupport => {
    if (get(environmentThreadDetails.quietThreadAtom(ref)) === null) return EMPTY_V2_ITEM_SUPPORT;
    const scoped = get.once(environmentThreadDetails.threadAtom(ref));
    return scoped === null
      ? EMPTY_V2_ITEM_SUPPORT
      : resolveV2ItemSupport(scoped.projection, target.itemId);
  }).pipe(Atom.withEquality(v2ItemSupportEqual), Atom.withLabel(`web-v2-item-support:${key}`));
});

export function useV2ItemSupport(input: {
  readonly environmentId: EnvironmentId;
  readonly sourceThreadId: ThreadId;
  readonly sourceItemId: TurnItemId;
}): V2ItemSupport {
  return useAtomValue(
    itemSupportAtomFamily(
      supportKey({
        environmentId: input.environmentId,
        threadId: input.sourceThreadId,
        itemId: input.sourceItemId,
      }),
    ),
  );
}
