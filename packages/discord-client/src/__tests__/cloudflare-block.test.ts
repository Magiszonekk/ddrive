import { describe, expect, it, vi } from "vitest";
import { WebhookRateLimiter } from "../rate-limiter.js";
import { DiscordUnavailableError, getChunkUrl } from "../downloader.js";

const WEBHOOK = { id: "123", token: "tok" } as never;

/** Cloudflare edge block: HTML body, no x-ratelimit-* headers, huge retry-after. */
function cloudflare429(retryAfterSeconds: number): Response {
  return new Response("<!doctype html><title>Access denied</title>", {
    status: 429,
    headers: { "content-type": "text/html", "retry-after": String(retryAfterSeconds) },
  });
}

/** A real Discord per-route limit: JSON body plus rate-limit headers. */
function discord429(retryAfterSeconds: number): Response {
  return new Response(JSON.stringify({ message: "You are being rate limited." }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSeconds),
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset-after": String(retryAfterSeconds),
    },
  });
}

describe("Cloudflare IP block handling", () => {
  it("fails fast instead of sleeping out a 40-minute retry-after", async () => {
    // The prod bug: retry-after 2402s was slept through, up to 3 times, so a
    // single share download hung for ~2h and never sent response headers.
    const fetchMock = vi.fn().mockResolvedValue(cloudflare429(2402));
    vi.stubGlobal("fetch", fetchMock);

    const started = Date.now();
    await expect(getChunkUrl(WEBHOOK, "m1", new WebhookRateLimiter())).rejects.toThrow(
      DiscordUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(1000);
    // And it must not have burned retries against a blocked edge.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it("reports the block as such, with the remaining wait", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(cloudflare429(2402)));
    const err = await getChunkUrl(WEBHOOK, "m1", new WebhookRateLimiter()).catch((e) => e);
    expect(err).toBeInstanceOf(DiscordUnavailableError);
    expect(err.cloudflareBlocked).toBe(true);
    expect(err.retryAfterMs).toBe(2402 * 1000);
    expect(String(err.message)).toMatch(/Cloudflare/i);
    vi.unstubAllGlobals();
  });

  it("short-circuits later reads while the block is still active, without dialling out", async () => {
    const limiter = new WebhookRateLimiter();
    const fetchMock = vi.fn().mockResolvedValue(cloudflare429(600));
    vi.stubGlobal("fetch", fetchMock);

    await getChunkUrl(WEBHOOK, "m1", limiter).catch(() => undefined);
    expect(limiter.cloudflareBlockRemainingMs()).toBeGreaterThan(0);

    const callsAfterFirst = fetchMock.mock.calls.length;
    // Every webhook shares the IP, so a different sender must be blocked too.
    await expect(
      getChunkUrl({ id: "999", token: "other" } as never, "m2", limiter),
    ).rejects.toThrow(DiscordUnavailableError);
    // No new network attempt: hitting a blocked edge only prolongs the block.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);

    vi.unstubAllGlobals();
  });

  it("still waits out a SHORT genuine Discord rate limit", async () => {
    // Regression guard: the fix must not turn normal per-route throttling
    // (small retry-after, JSON + headers) into a hard failure.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(discord429(0.05))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: "m1", attachments: [{ url: "https://cdn/x", size: 1, filename: "x" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const url = await getChunkUrl(WEBHOOK, "m1", new WebhookRateLimiter());
    expect(url).toBe("https://cdn/x");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
  });

  it("refuses a long non-Cloudflare retry-after rather than hanging", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(discord429(3600)));
    const err = await getChunkUrl(WEBHOOK, "m1", new WebhookRateLimiter()).catch((e) => e);
    expect(err).toBeInstanceOf(DiscordUnavailableError);
    expect(err.cloudflareBlocked).toBe(false);
    vi.unstubAllGlobals();
  });
});
