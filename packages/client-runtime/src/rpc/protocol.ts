import { WsRpcGroup } from "@t3tools/contracts";
import {
  decodeWireChunks,
  encodeWireChunk,
  encodeWireChunks,
  WIRE_FRAME_QUERY_PARAM,
} from "@t3tools/shared/core/codec";
import * as Effect from "effect/Effect";
import { RpcClient } from "effect/rpc";
import * as Socket from "effect/socket/Socket";

export const makeWsRpcProtocolClient = RpcClient.make(WsRpcGroup);
type RpcClientFactory = typeof makeWsRpcProtocolClient;
export type WsRpcProtocolClient =
  RpcClientFactory extends Effect.Effect<infer Client, any, any> ? Client : never;

// Pings go out every 5 seconds, and a server busy for a few seconds stops
// answering them. Allow 15 seconds without any frame before dropping the socket.
export const PING_TIMEOUT = "15 seconds";

export { WIRE_FRAME_QUERY_PARAM };
export type WsRpcFramingMode = "json" | "binary";

/**
 * Wraps a WebSocket `Socket` with compact binary wire framing when `mode === "binary"`,
 * while always decoding inbound binary frames and preserving backward-compatible JSON fallback.
 */
export function withWsRpcFraming(socket: Socket.Socket, mode: WsRpcFramingMode): Socket.Socket {
  const reader = Effect.map(socket.reader, (base) => ({
    upgrade: base.upgrade,
    pull: Effect.map(base.pull, decodeWireChunks),
  }));
  if (mode !== "binary") {
    return Socket.make({ reader, writer: socket.writer });
  }
  return Socket.make({
    reader,
    writer: Effect.map(socket.writer, (writer) => ({
      write: (chunk) => writer.write(encodeWireChunk(chunk)),
      writeAll: (chunks) => {
        const frame = encodeWireChunks(chunks);
        return frame === null ? Effect.void : writer.write(frame);
      },
    })),
  });
}
