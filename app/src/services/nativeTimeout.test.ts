import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeTimeoutError, withNativeTimeout } from "./nativeTimeout";

afterEach(() => {
  vi.useRealTimers();
});

describe("withNativeTimeout", () => {
  it("returns the operation result when it resolves before the timeout", async () => {
    await expect(withNativeTimeout(Promise.resolve("ready"), "test", 100)).resolves.toBe("ready");
  });

  it("rejects when the operation does not resolve before the timeout", async () => {
    vi.useFakeTimers();

    const result = withNativeTimeout(
      new Promise<string>(() => undefined),
      "native call",
      100,
    ).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(100);

    expect(await result).toBeInstanceOf(NativeTimeoutError);
  });
});
