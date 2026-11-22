import { parseUrl } from "@t3tools/shared/url";

/** The schemes the host opens outside the app; it refuses any other, such as `javascript:`, `file:` or `tel:`. */
const schemes = new Set(["http:", "https:", "mailto:"]);

/** A document's link address, normalized, when the host may open it; undefined otherwise, so the link stays text. */
export function externalUrl(href: string) {
  const url = parseUrl(href);
  return url && schemes.has(url.protocol) ? url.href : undefined;
}
