import { randomUUID } from "node:crypto";
import type { Job } from "../shared/types.ts";

/**
 * In-memory registry of long-running work (modpack import, runtime install). The HTTP handler
 * returns the job id immediately; UI and MCP poll GET /api/jobs/:id. Jobs die with the daemon,
 * which is fine: every job is idempotent and re-runnable.
 */
export class JobRegistry {
  private jobs = new Map<string, Job>();

  list(): Job[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .slice(0, 50);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  /** Start work; `run` receives a progress reporter. Errors are captured onto the job. */
  start<T>(
    kind: string,
    title: string,
    run: (report: (message: string, progress?: number) => void) => Promise<T>,
  ): Job {
    const job: Job = {
      id: randomUUID().slice(0, 8),
      kind,
      title,
      status: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      message: "starting",
      progress: null,
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    const report = (message: string, progress?: number) => {
      job.message = message;
      if (progress !== undefined) job.progress = Math.max(0, Math.min(1, progress));
    };
    void run(report)
      .then((result) => {
        job.status = "done";
        job.result = result;
        job.progress = 1;
        job.finishedAt = new Date().toISOString();
      })
      .catch((err: Error) => {
        job.status = "error";
        job.error = err.message;
        job.finishedAt = new Date().toISOString();
      });
    return job;
  }

  /** Refuse to start a second job of the same kind while one runs. */
  running(kind: string): Job | undefined {
    return [...this.jobs.values()].find((j) => j.kind === kind && j.status === "running");
  }
}
