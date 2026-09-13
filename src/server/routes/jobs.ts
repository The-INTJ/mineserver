import { Hono } from "hono";
import type { AppContext } from "../context.ts";
import { notFound } from "../errors.ts";

export function jobRoutes(ctx: AppContext) {
  const app = new Hono();
  app.get("/jobs", (c) => c.json({ jobs: ctx.jobs.list() }));
  app.get("/jobs/:id", (c) => {
    const job = ctx.jobs.get(c.req.param("id"));
    if (!job) throw notFound("JOB_NOT_FOUND", `No job ${c.req.param("id")}`);
    return c.json(job);
  });
  return app;
}
