import type { Request, Response, NextFunction } from "express";

type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();

export function rateLimit(opts: { windowMs: number; max: number; key?: string }) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.ip ?? "unknown";
    const key = `${opts.key ?? "default"}:${ip}`;
    const now = Date.now();
    const b = buckets.get(key);

    if (!b || b.resetAt < now) {
      buckets.set(key, { count: 1, resetAt: now + opts.windowMs });
      next();
      return;
    }

    if (b.count >= opts.max) {
      const retryMs = Math.max(0, b.resetAt - now);
      res.setHeader("Retry-After", Math.ceil(retryMs / 1000));
      res.status(429).json({ error: `Rate limit exceeded. Try again in ${Math.ceil(retryMs / 1000)}s.` });
      return;
    }

    b.count += 1;
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of buckets) {
    if (v.resetAt < now) buckets.delete(k);
  }
}, 60_000).unref();
