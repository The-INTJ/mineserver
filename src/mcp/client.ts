/**
 * Thin HTTP client for the daemon. The MCP server never touches the process, files or state
 * directly: everything goes through the same API the UI uses, so it can run from any Claude
 * Code session while the daemon keeps sole ownership of the Java child.
 */
export class DaemonClient {
  constructor(readonly baseUrl = process.env.MINESERVER_URL ?? "http://127.0.0.1:3400") {}

  async get(path: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
    const url = new URL(`/api${path}`, this.baseUrl);
    for (const [k, v] of Object.entries(query ?? {}))
      if (v !== undefined) url.searchParams.set(k, String(v));
    return this.handle(await fetch(url));
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(new URL(`/api${path}`, this.baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return this.handle(res);
  }

  async text(path: string): Promise<string> {
    const res = await fetch(new URL(`/api${path}`, this.baseUrl));
    if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
    return res.text();
  }

  private async handle(res: Response): Promise<unknown> {
    const text = await res.text();
    let json: unknown = text;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON body, keep text */
    }
    if (!res.ok) {
      const e = json as { error?: string; code?: string };
      throw new Error(`${res.status} ${e?.code ?? ""}: ${e?.error ?? text}`);
    }
    return json;
  }
}
