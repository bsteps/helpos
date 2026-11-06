import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLocalFileStore, type FileStore, InvalidFileKeyError } from "./index.ts";

describe("local file store", () => {
  let dir: string;
  let store: FileStore;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "files-"));
    store = createLocalFileStore(dir);
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("stores and returns bytes", async () => {
    await store.put("tenant-a/file-1", new Uint8Array([1, 2, 3]));
    expect(await store.get("tenant-a/file-1")).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("returns null for a missing key", async () => {
    expect(await store.get("tenant-a/missing")).toBeNull();
  });

  it("never overwrites an existing key", async () => {
    await store.put("tenant-a/once", new Uint8Array([1]));
    await expect(store.put("tenant-a/once", new Uint8Array([2]))).rejects.toThrow();
    expect(await store.get("tenant-a/once")).toEqual(new Uint8Array([1]));
  });

  it.each(["../escape", "a/../../escape", "/abs", "a\\b", "", "A/upper", "a/", "a//b"])(
    "rejects the unsafe key %j",
    async (key) => {
      await expect(store.put(key, new Uint8Array())).rejects.toThrow(InvalidFileKeyError);
      await expect(store.get(key)).rejects.toThrow(InvalidFileKeyError);
    },
  );
});
