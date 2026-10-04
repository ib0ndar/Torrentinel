import { describe, expect, it } from "vitest";
import { assertPublicHttpUrl, BlockedDestinationError, isPublicAddress, publicOnlyLookup } from "./egress.js";

describe("outbound destination guard", () => {
  it("accepts public addresses and rejects local, private and reserved ones", () => {
    for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2002:0808:0808::1"]) {
      expect(isPublicAddress(address), address).toBe(true);
    }
    for (const address of [
      "127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
      "224.0.0.1", "255.255.255.255", "::1", "::", "fe80::1", "fd00::1", "fc00::1", "ff02::1",
      "::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:192.168.0.10", "64:ff9b::a00:1", "2002:c0a8:0101::1", "not-an-address",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
  });

  it("rejects private IP literals and non-HTTP schemes before connecting", async () => {
    await expect(assertPublicHttpUrl("http://127.0.0.1:8080/")).rejects.toBeInstanceOf(BlockedDestinationError);
    await expect(assertPublicHttpUrl("http://[::1]/")).rejects.toBeInstanceOf(BlockedDestinationError);
    await expect(assertPublicHttpUrl("http://169.254.169.254/latest/meta-data/")).rejects.toBeInstanceOf(BlockedDestinationError);
    await expect(assertPublicHttpUrl("file:///etc/passwd")).rejects.toThrow("Unsupported URL scheme");
    await expect(assertPublicHttpUrl("https://8.8.8.8/")).resolves.toBeUndefined();
  });

  it("rejects host names that resolve to local addresses at connection time", async () => {
    await expect(assertPublicHttpUrl("http://localhost/")).rejects.toBeInstanceOf(BlockedDestinationError);
    const result = await new Promise<{ error: NodeJS.ErrnoException | null }>((resolve) => {
      publicOnlyLookup("localhost", { all: true }, (error) => resolve({ error }));
    });
    expect(result.error).toBeInstanceOf(BlockedDestinationError);
  });
});
