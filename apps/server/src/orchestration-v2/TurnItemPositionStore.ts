import { OrchestrationV2TurnItem, RunId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class TurnItemPositionStoreError extends Schema.TaggedError<TurnItemPositionStoreError>()(
  "TurnItemPositionStoreError",
  {
    threadId: ThreadId,
    turnItemId: TurnItemId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isTurnItemPositionStoreError = Schema.is(TurnItemPositionStoreError);

export interface TurnItemPositionStoreV2Shape {
  readonly allocate: (input: {
    readonly threadId: ThreadId;
    readonly turnItemId: TurnItemId;
    readonly runId: RunId | null;
    readonly runOrdinal?: number;
    // `run_start` takes the run's unused first slot, ahead of its items, and appends once it is taken.
    readonly placement?: "append" | "run_start";
    // Keep an existing position even when it lies outside the run's range.
    readonly keepExisting?: boolean;
  }) => Effect.Effect<number, TurnItemPositionStoreError>;
  readonly normalize: (
    item: OrchestrationV2TurnItem,
    runOrdinal?: number,
  ) => Effect.Effect<OrchestrationV2TurnItem, TurnItemPositionStoreError>;
}

export class TurnItemPositionStoreV2 extends Context.Service<
  TurnItemPositionStoreV2,
  TurnItemPositionStoreV2Shape
>()("t3/orchestration-v2/TurnItemPositionStore/TurnItemPositionStoreV2") {}

const RUN_ORDINAL_CACHE_LIMIT = 2_048;
const POSITION_CACHE_LIMIT = 8_192;

/** Insertion-ordered Map as an LRU: a hit moves its key to the newest end. */
const lruGet = <V>(map: Map<string, V>, key: string): V | undefined => {
  const value = map.get(key);
  if (value !== undefined) {
    map.delete(key);
    map.set(key, value);
  }
  return value;
};
const lruSet = <V>(map: Map<string, V>, key: string, value: V, limit: number) => {
  map.delete(key);
  map.set(key, value);
  if (map.size > limit) map.delete(map.keys().next().value!);
};

export const layer: Layer.Layer<TurnItemPositionStoreV2, never, SqlClient.SqlClient> = Layer.effect(
  TurnItemPositionStoreV2,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    // Streaming re-normalizes the same items on every delta. Rows never get deleted and run ordinals
    // never change, so cached values stay true once committed. Fills wait for `afterCommit`, which
    // drops a rolled-back transaction's or savepoint's callbacks; a move invalidates fills queued before it.
    const runOrdinals = new Map<string, number>();
    const positions = new Map<string, number>();
    let moves = 0;
    const rememberAfterCommit = (
      cache: Map<string, number>,
      limit: number,
      key: string,
      value: number,
    ) => {
      const movesAtFill = moves;
      return sql.afterCommit(
        Effect.sync(() => {
          if (moves === movesAtFill) lruSet(cache, key, value, limit);
        }),
      );
    };

    const allocate: TurnItemPositionStoreV2Shape["allocate"] =
      /* This helper runs for individual orchestration events; the enclosing operation owns the span. */
      Effect.fnUntraced(
        function* ({
          threadId,
          turnItemId,
          runId,
          runOrdinal: suppliedRunOrdinal,
          placement = "append",
          keepExisting = false,
        }) {
          const positionKey = `${threadId}\u0000${turnItemId}`;
          const runKey = runId === null ? undefined : `${threadId}\u0000${runId}`;
          const cached = lruGet(positions, positionKey);
          let current = cached;
          let runOrdinal =
            suppliedRunOrdinal ??
            (runKey === undefined ? null : (lruGet(runOrdinals, runKey) ?? null));
          const needsRun = runKey !== undefined && runOrdinal === null;
          if (current === undefined || needsRun) {
            const [row] = yield* sql<{
              readonly existing: number | null;
              readonly run_ordinal: number | null;
            }>`
              SELECT
                (
                  SELECT ordinal
                  FROM orchestration_v2_turn_item_positions
                  WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
                ) AS existing,
                ${
                  needsRun
                    ? sql`(
                        SELECT ordinal
                        FROM orchestration_v2_projection_runs
                        WHERE thread_id = ${threadId} AND run_id = ${runId}
                      )`
                    : sql`NULL`
                } AS run_ordinal
            `;
            if (needsRun && row?.run_ordinal != null) {
              runOrdinal = row.run_ordinal;
              yield* rememberAfterCommit(runOrdinals, RUN_ORDINAL_CACHE_LIMIT, runKey, runOrdinal);
            }
            current ??= row?.existing ?? undefined;
          }
          const lowerBound = runOrdinal === null ? 0 : runOrdinal * 1_000_000;
          const upperBound = runOrdinal === null ? 999_999 : lowerBound + 999_999;
          let allocated: ReadonlyArray<{ readonly ordinal: number }>;
          if (current !== undefined) {
            // A steer that missed its turn starts the next run; it moves into that run's range.
            if (
              keepExisting ||
              runOrdinal === null ||
              (current >= lowerBound && current <= upperBound)
            ) {
              if (cached === undefined) {
                yield* rememberAfterCommit(positions, POSITION_CACHE_LIMIT, positionKey, current);
              }
              return current;
            }
            moves++;
            positions.delete(positionKey);
            allocated = yield* sql<{ readonly ordinal: number }>`
            UPDATE orchestration_v2_turn_item_positions
            SET ordinal = (
              SELECT COALESCE(MAX(ordinal), ${lowerBound}) + 1
              FROM orchestration_v2_turn_item_positions
              WHERE thread_id = ${threadId}
                AND ordinal >= ${lowerBound}
                AND ordinal <= ${upperBound}
            )
            WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
            RETURNING ordinal
          `;
          } else {
            allocated = yield* sql<{ readonly ordinal: number }>`
            INSERT INTO orchestration_v2_turn_item_positions (thread_id, turn_item_id, ordinal)
            SELECT
              ${threadId},
              ${turnItemId},
              ${
                placement === "run_start"
                  ? sql`CASE WHEN COALESCE(MIN(ordinal), ${upperBound}) > ${lowerBound} THEN ${lowerBound} ELSE MAX(ordinal) + 1 END`
                  : sql`COALESCE(MAX(ordinal), ${lowerBound}) + 1`
              }
            FROM orchestration_v2_turn_item_positions
            WHERE thread_id = ${threadId}
              AND ordinal >= ${lowerBound}
              AND ordinal <= ${upperBound}
            ON CONFLICT(thread_id, turn_item_id) DO NOTHING
            RETURNING ordinal
          `;
          }
          // A conflicting insert returns nothing; read the row that won.
          const ordinal =
            allocated[0]?.ordinal ??
            (yield* sql<{ readonly ordinal: number }>`
              SELECT ordinal
              FROM orchestration_v2_turn_item_positions
              WHERE thread_id = ${threadId} AND turn_item_id = ${turnItemId}
              LIMIT 1
            `)[0]?.ordinal;
          if (ordinal === undefined) {
            return yield* new TurnItemPositionStoreError({
              threadId,
              turnItemId,
              cause: "Position allocation returned no row.",
            });
          }
          yield* rememberAfterCommit(positions, POSITION_CACHE_LIMIT, positionKey, ordinal);
          return ordinal;
        },
        (effect, { threadId, turnItemId }) =>
          effect.pipe(
            Effect.mapError((cause) =>
              isTurnItemPositionStoreError(cause)
                ? cause
                : new TurnItemPositionStoreError({ threadId, turnItemId, cause }),
            ),
          ),
      );

    return TurnItemPositionStoreV2.of({
      allocate,
      // Per-event normalization shares the enclosing orchestration span.
      normalize: Effect.fnUntraced(function* (item, runOrdinal) {
        return yield* allocate({
          threadId: item.threadId,
          turnItemId: item.id,
          runId: item.runId,
          // Queued steers keep their submission order until their run starts (see Orchestrator).
          keepExisting: item.status === "pending",
          ...(runOrdinal === undefined ? {} : { runOrdinal }),
        }).pipe(Effect.map((ordinal) => (item.ordinal === ordinal ? item : { ...item, ordinal })));
      }),
    });
  }),
);
