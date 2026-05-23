import { Router, type IRouter } from "express";
import { eq, ilike, and, desc, sql, inArray } from "drizzle-orm";
import { db, organizationsTable, orgMembersTable, modelsTable, modelTagsTable, datasetsTable, usersTable } from "@pullbase/db";
import {
  ListOrganizationsQueryParams,
  ListOrganizationsResponse,
  GetOrganizationParams,
  GetOrganizationResponse,
} from "@pullbase/api-zod";

const router: IRouter = Router();

router.get("/organizations", async (req, res): Promise<void> => {
  const parsed = ListOrganizationsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, sort, page, limit } = parsed.data;
  const offset = ((page ?? 1) - 1) * (limit ?? 24);
  const pageSize = limit ?? 24;

  const where = search ? ilike(organizationsTable.name, `%${search}%`) : undefined;

  const orderBy = sort === "alphabetical"
    ? organizationsTable.name
    : desc(organizationsTable.createdAt);

  const [rows, [{ count }]] = await Promise.all([
    db.select().from(organizationsTable).where(where).orderBy(orderBy).limit(pageSize).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(organizationsTable).where(where),
  ]);

  const orgIds = rows.map((o) => o.id);

  const [memberCounts, modelCounts, datasetCounts] = await Promise.all([
    orgIds.length > 0
      ? db.select({ orgId: orgMembersTable.orgId, count: sql<number>`count(*)::int` })
          .from(orgMembersTable).where(inArray(orgMembersTable.orgId, orgIds))
          .groupBy(orgMembersTable.orgId)
      : Promise.resolve([]),
    orgIds.length > 0
      ? db.select({ orgId: modelsTable.orgId, count: sql<number>`count(*)::int` })
          .from(modelsTable).where(inArray(modelsTable.orgId!, orgIds))
          .groupBy(modelsTable.orgId)
      : Promise.resolve([]),
    orgIds.length > 0
      ? db.select({ orgId: datasetsTable.orgId, count: sql<number>`count(*)::int` })
          .from(datasetsTable).where(inArray(datasetsTable.orgId!, orgIds))
          .groupBy(datasetsTable.orgId)
      : Promise.resolve([]),
  ]);

  const memberMap: Record<number, number> = {};
  for (const m of memberCounts) memberMap[m.orgId] = m.count;
  const modelMap: Record<number, number> = {};
  for (const m of modelCounts) if (m.orgId) modelMap[m.orgId] = m.count;
  const datasetMap: Record<number, number> = {};
  for (const d of datasetCounts) if (d.orgId) datasetMap[d.orgId] = d.count;

  const items = rows.map((o) => ({
    ...o,
    memberCount:  memberMap[o.id]  ?? 0,
    modelCount:   modelMap[o.id]   ?? 0,
    datasetCount: datasetMap[o.id] ?? 0,
  }));

  res.json(ListOrganizationsResponse.parse({ items, total: count, page: page ?? 1, limit: pageSize }));
});

router.get("/organizations/:id", async (req, res): Promise<void> => {
  const params = GetOrganizationParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, params.data.id));
  if (!org) {
    res.status(404).json({ error: "Organization not found" });
    return;
  }

  const [members, modelRows, [{ memberCount }], [{ modelCount }], [{ datasetCount }], [{ totalDownloads }]] = await Promise.all([
    db.select().from(orgMembersTable).where(eq(orgMembersTable.orgId, org.id)),
    db.select().from(modelsTable).where(eq(modelsTable.orgId, org.id)).limit(12),
    db.select({ memberCount: sql<number>`count(*)::int` }).from(orgMembersTable).where(eq(orgMembersTable.orgId, org.id)),
    db.select({ modelCount: sql<number>`count(*)::int` }).from(modelsTable).where(eq(modelsTable.orgId, org.id)),
    db.select({ datasetCount: sql<number>`count(*)::int` }).from(datasetsTable).where(eq(datasetsTable.orgId, org.id)),
    db.select({ totalDownloads: sql<number>`coalesce(sum(download_count), 0)::int` }).from(modelsTable).where(eq(modelsTable.orgId, org.id)),
  ]);

  const modelIds = modelRows.map((m) => m.id);
  const tags = modelIds.length > 0
    ? await db.select().from(modelTagsTable).where(inArray(modelTagsTable.modelId, modelIds))
    : [];
  const tagMap: Record<number, string[]> = {};
  for (const t of tags) {
    if (!tagMap[t.modelId]) tagMap[t.modelId] = [];
    tagMap[t.modelId].push(t.tag);
  }

  const userAddresses = [...new Set(modelRows.map((m) => m.ownerAddress))];
  const users = userAddresses.length > 0
    ? await db.select({ walletAddress: usersTable.walletAddress, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.walletAddress, userAddresses))
    : [];
  const userMap: Record<string, string> = {};
  for (const u of users) userMap[u.walletAddress] = u.username;

  const models = modelRows.map((m) => ({
    ...m,
    tags: tagMap[m.id] ?? [],
    ownerUsername: userMap[m.ownerAddress] ?? m.ownerAddress.slice(0, 8),
    orgName: org.name,
  }));

  res.json(GetOrganizationResponse.parse({
    ...org,
    memberCount,
    modelCount,
    datasetCount,
    totalDownloads,
    models,
  }));
});

export default router;
