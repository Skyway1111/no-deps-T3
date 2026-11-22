import { assert, describe, it } from "@effect/vitest";

import { windowHandle } from "./WindowsForeground.ts";

describe("Windows native window handles", () => {
  it("reads 4- and 8-byte handles and rejects others", () => {
    const wide = Buffer.alloc(8);
    wide.writeBigUInt64LE(41n);
    assert.equal(windowHandle(wide), 41n);
    assert.equal(windowHandle(Buffer.from([41, 0, 0, 0])), 41n);
    assert.throws(() => windowHandle(Buffer.alloc(6)));
  });
});
