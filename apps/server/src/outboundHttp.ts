import * as NodeNet from "node:net";

/** Node 26 bundles h2-capable undici 8; Node 22/24 and Electron stay on HTTP/1.1 with 6/7. */
export const builtinFetchUsesHttp2 = (bundledUndiciVersion: string | undefined) =>
  Number.parseInt(bundledUndiciVersion ?? "", 10) >= 8;

type Dispatcher = { readonly constructor: new (options?: object) => Dispatcher };
// undici 8 reads `.2` and mirrors a Dispatcher1Wrapper into `.1` for older copies.
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.2");
const LEGACY_GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");

/**
 * Rebuilds the built-in fetch dispatcher with Node's own undici classes, so no
 * npm undici is needed. Preserves the EnvHttpProxyAgent from --use-env-proxy.
 */
export function installHttp1FetchDispatcher(): void {
  void globalThis.Headers; // Loads Node's bundled undici, which installs the default dispatcher.
  const global = globalThis as unknown as Record<symbol, Dispatcher | undefined>;
  const current = global[GLOBAL_DISPATCHER] ?? global[LEGACY_GLOBAL_DISPATCHER];
  if (current === undefined) return;
  const Dispatcher = current.constructor;
  const next =
    Dispatcher.name === "EnvHttpProxyAgent"
      ? new Dispatcher({
          allowH2: false,
          // ProxyAgent's proxy connector ignores allowH2; empty proxies make an HTTP/1.1 direct agent.
          clientFactory: () => new Dispatcher({ allowH2: false, httpProxy: "", httpsProxy: "" }),
        })
      : new Dispatcher({ allowH2: false });
  if (global[GLOBAL_DISPATCHER] === undefined) {
    global[LEGACY_GLOBAL_DISPATCHER] = next;
    return;
  }
  global[GLOBAL_DISPATCHER] = next;
  const Legacy = global[LEGACY_GLOBAL_DISPATCHER]?.constructor;
  if (Legacy?.name === "Dispatcher1Wrapper") global[LEGACY_GLOBAL_DISPATCHER] = new Legacy(next);
}

/** Avoids uncaught idle-timeout errors on h2 streams (https://github.com/nodejs/undici/issues/5936). */
export function keepOutboundFetchOnHttp1(): void {
  if (builtinFetchUsesHttp2(process.versions.undici)) installHttp1FetchDispatcher();
}

// @types/node does not declare setTypeOfService yet.
type TypeOfServiceSocket = {
  setTypeOfService?: (this: NodeNet.Socket, typeOfService: number) => NodeNet.Socket;
};

// Bundled undici calls this from a socket callback without catching. On macOS,
// EINVAL after a peer reset must not exit the server over an optional QoS hint.
export function ignoreMacosTypeOfServiceEinval(
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Runs before ACP dispatch without loading the Effect graph.
  platform = process.platform,
  socketPrototype: TypeOfServiceSocket = NodeNet.Socket.prototype as TypeOfServiceSocket,
): void {
  if (platform !== "darwin") return;
  const setTypeOfService = socketPrototype.setTypeOfService;
  if (typeof setTypeOfService !== "function") return;
  socketPrototype.setTypeOfService = function (...args) {
    try {
      return setTypeOfService.apply(this, args);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EINVAL") return this;
      throw error;
    }
  };
}

/**
 * Node's 250 ms Happy Eyeballs attempt timeout abandons a working-but-slow IPv4
 * connect when IPv6 is advertised but unroutable, which broke the ACP registry
 * fetch. A larger `--network-family-autoselection-attempt-timeout` still wins.
 */
export function extendConnectionAttemptTimeout(): void {
  NodeNet.setDefaultAutoSelectFamilyAttemptTimeout(
    Math.max(NodeNet.getDefaultAutoSelectFamilyAttemptTimeout(), 1_000),
  );
}
