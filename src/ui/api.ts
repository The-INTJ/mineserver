import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, Job, LogLine, ServerState, StatusResponse } from "../shared/types.ts";

export class RequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  if (res.ok) return (await res.json()) as T;
  let err: ApiError = { error: res.statusText, code: "HTTP" };
  try {
    err = (await res.json()) as ApiError;
  } catch {
    /* keep default */
  }
  throw new RequestError(res.status, err.code, err.error);
}

export const api = {
  get: <T>(path: string) => fetch(`/api${path}`).then((r) => handle<T>(r)),
  post: <T>(path: string, body?: unknown) =>
    fetch(`/api${path}`, {
      method: "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  put: <T>(path: string, body: unknown) =>
    fetch(`/api${path}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => handle<T>(r)),
  del: <T>(path: string) => fetch(`/api${path}`, { method: "DELETE" }).then((r) => handle<T>(r)),
  upload: <T>(
    path: string,
    files: FileList | File[],
    field = "files",
    extra: Record<string, string> = {},
  ) => {
    const fd = new FormData();
    for (const f of Array.from(files)) fd.append(field, f);
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return fetch(`/api${path}`, { method: "POST", body: fd }).then((r) => handle<T>(r));
  },
};

/** Poll a job until it finishes; resolves with the final job, rejects on error. */
export async function pollJob(
  id: string,
  onUpdate?: (job: Job) => void,
  intervalMs = 1500,
): Promise<Job> {
  for (;;) {
    const job = await api.get<Job>(`/jobs/${encodeURIComponent(id)}`);
    onUpdate?.(job);
    if (job.status === "done") return job;
    if (job.status === "error") throw new Error(job.error ?? "job failed");
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/** Polls /api/status; the SSE `state` event triggers an immediate refresh so buttons react instantly. */
export function useStatus(intervalMs = 4000) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setStatus(await api.get<StatusResponse>("/status"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), intervalMs);
    return () => clearInterval(t);
  }, [refresh, intervalMs]);
  return { status, error, refresh };
}

/** Live log tail over SSE with reconnect; `state` events are surfaced via onState. */
export function useLogStream(onState?: (s: ServerState) => void, cap = 1500) {
  const [lines, setLines] = useState<LogLine[]>([]);
  const lastSeq = useRef(0);
  const session = useRef("");
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    let es: EventSource | null = null;
    let closed = false;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const connect = () => {
      es = new EventSource(`/api/logs/stream?since=${lastSeq.current}&session=${session.current}`);
      es.addEventListener("session", (ev) => {
        const next = JSON.parse((ev as MessageEvent).data) as string;
        if (session.current !== next) {
          lastSeq.current = 0;
          setLines([]);
        }
        session.current = next;
      });
      es.addEventListener("log", (ev) => {
        const line = JSON.parse((ev as MessageEvent).data) as LogLine;
        lastSeq.current = line.seq;
        setLines((prev) =>
          prev.length >= cap ? [...prev.slice(prev.length - cap + 1), line] : [...prev, line],
        );
      });
      es.addEventListener("state", (ev) =>
        onStateRef.current?.(JSON.parse((ev as MessageEvent).data) as ServerState),
      );
      es.onerror = () => {
        es?.close();
        if (!closed) retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      es?.close();
    };
  }, [cap]);
  return lines;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
