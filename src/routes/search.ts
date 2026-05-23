import { Router, type IRouter } from "express";
import { ilike, or, sql } from "drizzle-orm";
import { db, modelsTable, datasetsTable, organizationsTable, usersTable } from "@pullbase/db";
import { GlobalSearchQueryParams, GlobalSearchResponse } from "@pullbase/api-zod";
import { inArray } from "drizzle-orm";

const router: IRouter = Router();

router.get("/search", async (req, res): Promise<void> => {
  const parsed = GlobalSearchQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { q, limit: rawLimit } = parsed.data;
  const limit = rawLimit ?? 10;
  const pattern = `%${q}%`;

  const [modelRows, datasetRows, orgRows] = await Promise.all([
    db.select().from(modelsTable)
      .where(or(ilike(modelsTable.name, pattern), ilike(sql`coalesce(${modelsTable.description}, '')`, pattern)))
      .limit(limit),
    db.select().from(datasetsTable)
      .where(or(ilike(datasetsTable.name, pattern), ilike(sql`coalesce(${datasetsTable.description}, '')`, pattern)))
      .limit(limit),
    db.select().from(organizationsTable)
      .where(or(ilike(organizationsTable.name, pattern), ilike(sql`coalesce(${organizationsTable.description}, '')`, pattern)))
      .limit(limit),
  ]);

  const ownerAddresses = [
    ...new Set([...modelRows.map((m) => m.ownerAddress), ...datasetRows.map((d) => d.ownerAddress)]),
  ];
  const users = ownerAddresses.length > 0
    ? await db.select({ walletAddress: usersTable.walletAddress, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.walletAddress, ownerAddresses))
    : [];
  const userMap: Record<string, string> = {};
  for (const u of users) userMap[u.walletAddress] = u.username;

  const models = modelRows.map((m) => ({
    type: "model" as const, id: m.id, name: m.name,
    ownerAddress: m.ownerAddress, ownerUsername: userMap[m.ownerAddress] ?? m.ownerAddress.slice(0, 8),
    description: m.description ?? null, task: m.task, isOnChain: m.isOnChain,
  }));
  const datasets = datasetRows.map((d) => ({
    type: "dataset" as const, id: d.id, name: d.name,
    ownerAddress: d.ownerAddress, ownerUsername: userMap[d.ownerAddress] ?? d.ownerAddress.slice(0, 8),
    description: d.description ?? null, task: d.task, isOnChain: d.isOnChain,
  }));
  const organizations = orgRows.map((o) => ({
    type: "organization" as const, id: o.id, name: o.name,
    ownerAddress: null, ownerUsername: null,
    description: o.description ?? null, task: null, isOnChain: null,
  }));

  const total = models.length + datasets.length + organizations.length;
  res.json(GlobalSearchResponse.parse({ models, datasets, organizations, total }));
});

export default router;
