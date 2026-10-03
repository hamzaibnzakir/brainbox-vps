/**
 * Transport abstraction: the real Tauri IPC in the desktop app, or an
 * in-memory mock backend when running in a plain browser (UI development,
 * Playwright E2E tests and screenshots).
 */

declare const __MOCK_BACKEND__: boolean;

export type Unlisten = () => void;

export interface Backend {
  readonly kind: "tauri" | "mock";
  invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, cb: (payload: T) => void): Promise<Unlisten>;
  /** Create a streaming channel to pass as a command argument. */
  channel<T>(onMessage: (msg: T) => void): unknown;
}

export const isTauri = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

let backendPromise: Promise<Backend> | null = null;

async function createTauri(): Promise<Backend> {
  const core = await import("@tauri-apps/api/core");
  const ev = await import("@tauri-apps/api/event");
  return {
    kind: "tauri",
    invoke: (cmd, args) => core.invoke(cmd, args),
    listen: async (event, cb) => ev.listen(event, (e) => cb(e.payload as never)),
    channel: (onMessage) => {
      const ch = new core.Channel<unknown>();
      ch.onmessage = onMessage as (m: unknown) => void;
      return ch;
    },
  };
}

export function getBackend(): Promise<Backend> {
  if (!backendPromise) {
    const useMock = (typeof __MOCK_BACKEND__ !== "undefined" && __MOCK_BACKEND__) || !isTauri;
    backendPromise = useMock ? import("./mock/mockBackend").then((m) => m.createMockBackend()) : createTauri();
  }
  return backendPromise;
}

/** Test hook: replace the backend. */
export function setBackend(b: Backend) {
  backendPromise = Promise.resolve(b);
}
