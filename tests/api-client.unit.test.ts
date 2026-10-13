import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError, clearSession, useGame } from "../apps/web/src/store";

function stalledResponse(signal: AbortSignal) {
  // Deliver valid headers and the beginning of JSON, then stall until abort.
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"message":'));
        signal.addEventListener(
          "abort",
          () =>
            controller.error(
              new DOMException("Aborted response body", "AbortError"),
            ),
          { once: true },
        );
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("API response transport recovery", () => {
  it("times out a stalled body and retries with the same idempotency key and intent", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_url, init) =>
        stalledResponse(init!.signal!),
      )
      .mockResolvedValueOnce(Response.json({ message: "交易完成" }));
    const operation = api("/market/listing/buy", { quantity: 1 });
    await vi.advanceTimersByTimeAsync(12000);
    await expect(operation).resolves.toEqual({ message: "交易完成" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const first = fetchMock.mock.calls[0][1]!,
      retry = fetchMock.mock.calls[1][1]!;
    expect(
      (first.headers as Record<string, string>)["Idempotency-Key"],
    ).toMatch(/^[0-9a-f-]{36}$/);
    expect(retry.headers).toEqual(first.headers);
    expect(retry.body).toBe(first.body);
    expect(first.signal?.aborted).toBe(true);
  });
  it("ends after two incomplete responses instead of leaving the UI busy forever", async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => stalledResponse(init!.signal!));
    const rejected = expect(
      api("/game/collect", { buildingId: "test" }),
    ).rejects.toThrow("已提交的操作会在重连后核对");
    await vi.advanceTimersByTimeAsync(24000);
    await rejected;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it("retries a truncated JSON body with the original key", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response('{"message":'))
      .mockResolvedValueOnce(Response.json({ message: "already committed" }));
    await expect(
      api("/game/build", { kind: "purifier", x: 0, y: 0 }),
    ).resolves.toEqual({ message: "already committed" });
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual(
      fetchMock.mock.calls[0][1]?.headers,
    );
  });
  it("does not retry a complete business rejection", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ error: { message: "商品已售完" } }, { status: 409 }),
      );
    await expect(
      api("/market/listing/buy", { quantity: 1 }),
    ).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("authoritative state refresh coordination", () => {
  it("finishes each caller's refresh even while subsequent notifications are queued", async () => {
    let completeFirst!: (value: Response) => void;
    let completeSecond!: (value: Response) => void;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeFirst = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            completeSecond = resolve;
          }),
      );
    const first = useGame.getState().refresh();
    const second = useGame.getState().refresh();
    const coalesced = useGame.getState().refresh();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    completeFirst(
      Response.json({
        id: "island-a",
        serverTime: new Date().toISOString(),
        coins: 100,
      }),
    );
    await first;
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useGame.getState().state?.coins).toBe(100);
    // The first caller has resolved while the next network response is pending.
    expect(useGame.getState().syncing).toBe(true);
    completeSecond(
      Response.json({
        id: "island-a",
        serverTime: new Date().toISOString(),
        coins: 90,
      }),
    );
    await Promise.all([second, coalesced]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(useGame.getState().state?.coins).toBe(90);
    clearSession();
  });
  it("cannot restore a signed-out player's state from a late response", async () => {
    let complete!: (value: Response) => void;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const pending = useGame.getState().refresh();
    clearSession();
    complete(
      Response.json({
        id: "previous-session",
        serverTime: new Date().toISOString(),
        coins: 900,
      }),
    );
    await pending;
    expect(useGame.getState().state).toBeNull();
  });
});
