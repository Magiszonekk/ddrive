import { describe, expect, it } from "vitest";
import { chunkFileStream } from "../chunker.js";

function makeStream(data: Uint8Array, readSize: number): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= data.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + readSize, data.length);
      controller.enqueue(data.subarray(offset, end));
      offset = end;
    },
  });
}

describe("chunkFileStream buffer ownership", () => {
  // The regression guard for the fixed-size accumulator rewrite: consumers
  // (benchmark-browser-e2e collects chunks into an array; upload retries hold a
  // chunk across attempts) must each own their bytes. Recycling one buffer
  // would alias every retained chunk to the last chunk's contents, which small
  // single-chunk unit tests cannot catch.
  it("gives each yielded chunk its own buffer when chunks are retained", async () => {
    const chunkSize = 16;
    const total = chunkSize * 5;
    const data = new Uint8Array(total);
    for (let i = 0; i < total; i++) data[i] = i % 251;

    const collected: Uint8Array[] = [];
    for await (const chunk of chunkFileStream(makeStream(data, 7), chunkSize)) {
      collected.push(chunk.data);
    }

    expect(collected).toHaveLength(5);
    // Every retained chunk still matches its own slice of the source.
    for (let i = 0; i < collected.length; i++) {
      expect(Array.from(collected[i]!)).toEqual(
        Array.from(data.subarray(i * chunkSize, (i + 1) * chunkSize)),
      );
    }
    // And no two chunks share the same underlying ArrayBuffer.
    const buffers = new Set(collected.map((c) => c.buffer));
    expect(buffers.size).toBe(collected.length);
  });

  it("copies the tail instead of pinning a full-size buffer", async () => {
    const chunkSize = 64;
    const data = new Uint8Array(chunkSize + 3).fill(9);
    const chunks: Uint8Array[] = [];
    for await (const c of chunkFileStream(makeStream(data, 5), chunkSize)) chunks.push(c.data);

    expect(chunks).toHaveLength(2);
    const tail = chunks[1]!;
    expect(tail.byteLength).toBe(3);
    // .slice() (a copy) — a .subarray() view would keep the whole 64-byte
    // accumulator alive for a 3-byte remainder.
    expect(tail.buffer.byteLength).toBe(3);
  });

  it("reassembles byte-identically across ragged read sizes", async () => {
    const chunkSize = 32;
    const total = 32 * 7 + 11;
    const data = new Uint8Array(total);
    for (let i = 0; i < total; i++) data[i] = (i * 31) % 256;

    for (const readSize of [1, 3, 32, 33, 100]) {
      const out: number[] = [];
      let expectedIndex = 0;
      for await (const c of chunkFileStream(makeStream(data, readSize), chunkSize)) {
        expect(c.index).toBe(expectedIndex++);
        out.push(...c.data);
      }
      expect(out).toEqual(Array.from(data));
    }
  });
});
