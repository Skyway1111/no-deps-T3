import * as Layer from "../Layer.ts";
import { layer as fetchLayer } from "../http/FetchHttpClient.ts";
import type { HttpClient } from "../http/HttpClient.ts";

/** Node 22's global fetch is undici; both layers use it. */
export const layerUndici: Layer.Layer<HttpClient> = fetchLayer;
export const layer = fetchLayer;
