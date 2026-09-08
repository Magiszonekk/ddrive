import { beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "@ddv4/config";
import { LEGACY_UPLOAD_CHUNK_SIZE_BYTES } from "../../lib/upload-constants.js";
import { useUploadStore } from "../../stores/upload.js";

describe("upload cancellation store semantics", () => {
  beforeEach(() => {
    // Drop any rows left by a previous test so ids don't collide.
    const s = useUploadStore.getState();
    for (const id of Array.from(s.uploads.keys())) s.removeUpload(id);
  });

  it("marks the row CANCELLED immediately, before the pipeline unwinds", () => {
    const s = useUploadStore.getState();
    const controller = new AbortController();
    s.addUpload("f1", 3, 100, "a.bin");
    s.registerController("f1", controller);
    s.updateUpload("f1", { status: "UPLOADING" as never });

    s.cancelUpload("f1");

    expect(controller.signal.aborted).toBe(true);
    expect(useUploadStore.getState().getUpload("f1")?.status).toBe("CANCELLED");
  });

  it("treats CANCELLED as terminal: late progress updates cannot revive it", () => {
    const s = useUploadStore.getState();
    s.addUpload("f2", 3, 100, "b.bin");
    s.registerController("f2", new AbortController());
    s.cancelUpload("f2");

    // In-flight chunk resolving after the abort — this used to flip the row
    // back to UPLOADING and make the cancel look like it did nothing.
    s.updateUpload("f2", { status: "UPLOADING" as never, bytesUploaded: 50 });

    const row = useUploadStore.getState().getUpload("f2");
    expect(row?.status).toBe("CANCELLED");
    expect(row?.bytesUploaded).toBe(0);
  });

  it("keeps the controller registered across the placeholder -> realFileId swap", () => {
    const s = useUploadStore.getState();
    const controller = new AbortController();
    const placeholder = "pending:xyz";

    s.addUpload(placeholder, 3, 100, "c.bin");
    s.registerController(placeholder, controller);

    // The swap window: the row is dropped but the controller must survive, or a
    // click on X landing here silently no-ops (`?.abort()` on a missing entry).
    s.removeUploadKeepController(placeholder);
    s.cancelUpload(placeholder);

    expect(controller.signal.aborted).toBe(true);
  });

  it("plain removeUpload still unregisters the controller", () => {
    const s = useUploadStore.getState();
    const controller = new AbortController();
    s.addUpload("f3", 1, 10);
    s.registerController("f3", controller);
    s.removeUpload("f3");
    s.cancelUpload("f3");
    expect(controller.signal.aborted).toBe(false);
  });
});

describe("upload concurrency memory budget", () => {
  it("derives a worker count that fits the budget and still covers 8 webhooks", () => {
    const concurrency = Math.max(
      2,
      Math.min(
        config.defaultUploadConcurrency,
        Math.floor(config.uploadInFlightBudgetBytes / (LEGACY_UPLOAD_CHUNK_SIZE_BYTES * 2)),
      ),
    );

    expect(concurrency).toBe(12);
    // Must not drop below the Discord webhook pool size or fan-out throttles.
    expect(concurrency).toBeGreaterThanOrEqual(8);
    // And must stay inside the declared in-flight budget.
    expect(concurrency * LEGACY_UPLOAD_CHUNK_SIZE_BYTES * 2).toBeLessThanOrEqual(
      config.uploadInFlightBudgetBytes,
    );
  });
});

describe("blob upload honours AbortSignal", () => {
  it("passes the caller's signal straight into fetch()", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ blobId: "b", sizeBytes: "1", storageKind: "LOCAL", storagePath: "p" }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { uploadBlobToApi } = await import("../../lib/api.js");
    const controller = new AbortController();
    await uploadBlobToApi("blob:1", new Uint8Array([1, 2, 3]), {
      authToken: "t",
      signal: controller.signal,
    });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
    // And the body is the view itself — no defensive .buffer.slice() copy.
    expect(init.body).toBeInstanceOf(Uint8Array);

    vi.unstubAllGlobals();
  });
});
