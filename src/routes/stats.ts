import { Router, type IRouter } from "express";
import { desc, sql, inArray } from "drizzle-orm";
import { db, modelsTable, datasetsTable, usersTable, organizationsTable, orgMembersTable, modelTagsTable, datasetTagsTable } from "@pullbase/db";
import {
  GetPlatformStatsResponse,
  GetTrendingResponse,
  ListTagsResponse,
} from "@pullbase/api-zod";

const router: IRouter = Router();

router.get("/stats/platform", async (_req, res): Promise<void> => {
  const [[models], [datasets], [users], [orgs]] = await Promise.all([
    db.select({ count: sql<number>`count(*)::int`, onChain: sql<number>`count(*) filter (where is_on_chain = true)::int`, downloads: sql<number>`coalesce(sum(download_count), 0)::int` }).from(modelsTable),
    db.select({ count: sql<number>`count(*)::int` }).from(datasetsTable),
    db.select({ count: sql<number>`count(*)::int` }).from(usersTable),
    db.select({ count: sql<number>`count(*)::int` }).from(organizationsTable),
  ]);

  res.json(GetPlatformStatsResponse.parse({
    totalModels:    models.count,
    totalDatasets:  datasets.count,
    totalUsers:     users.count,
    totalOrgs:      orgs.count,
    totalDownloads: models.downloads,
    onChainModels:  models.onChain,
  }));
});

router.get("/stats/trending", async (_req, res): Promise<void> => {
  const [trendingModels, trendingDatasets, topOrgs] = await Promise.all([
    db.select().from(modelsTable).orderBy(desc(modelsTable.downloadCount)).limit(6),
    db.select().from(datasetsTable).orderBy(desc(datasetsTable.downloadCount)).limit(4),
    db.select().from(organizationsTable)
      .orderBy(desc(sql`(
        SELECT count(*)::int FROM ${modelsTable}    WHERE ${modelsTable.orgId}    = ${organizationsTable.id}
      ) + (
        SELECT count(*)::int FROM ${orgMembersTable} WHERE ${orgMembersTable.orgId} = ${organizationsTable.id}
      )`))
      .limit(5),
  ]);

  const modelIds = trendingModels.map((m) => m.id);
  const dsIds = trendingDatasets.map((d) => d.id);
  const orgIds = topOrgs.map((o) => o.id);

  const [modelTags, dsTags, memberCounts, modelCounts, datasetCounts] = await Promise.all([
    modelIds.length > 0 ? db.select().from(modelTagsTable).where(inArray(modelTagsTable.modelId, modelIds)) : Promise.resolve([]),
    dsIds.length > 0 ? db.select().from(datasetTagsTable).where(inArray(datasetTagsTable.datasetId, dsIds)) : Promise.resolve([]),
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

  const mtMap: Record<number, string[]> = {};
  for (const t of modelTags) { if (!mtMap[t.modelId]) mtMap[t.modelId] = []; mtMap[t.modelId].push(t.tag); }
  const dtMap: Record<number, string[]> = {};
  for (const t of dsTags) { if (!dtMap[t.datasetId]) dtMap[t.datasetId] = []; dtMap[t.datasetId].push(t.tag); }
  const memberMap: Record<number, number> = {};
  for (const m of memberCounts) memberMap[m.orgId] = m.count;
  const modelMap: Record<number, number> = {};
  for (const m of modelCounts) if (m.orgId) modelMap[m.orgId] = m.count;
  const datasetMap: Record<number, number> = {};
  for (const d of datasetCounts) if (d.orgId) datasetMap[d.orgId] = d.count;

  res.json(GetTrendingResponse.parse({
    models: trendingModels.map((m) => ({ ...m, tags: mtMap[m.id] ?? [], ownerUsername: m.ownerAddress.slice(0, 8) })),
    datasets: trendingDatasets.map((d) => ({ ...d, sizeBytes: d.sizeBytes ? Number(d.sizeBytes) : null, tags: dtMap[d.id] ?? [], ownerUsername: d.ownerAddress.slice(0, 8) })),
    organizations: topOrgs.map((o) => ({
      ...o,
      memberCount: memberMap[o.id] ?? 0,
      modelCount: modelMap[o.id] ?? 0,
      datasetCount: datasetMap[o.id] ?? 0,
    })),
  }));
});

router.get("/tags", async (_req, res): Promise<void> => {
  const modelTags = await db
    .select({ name: modelTagsTable.tag, count: sql<number>`count(*)::int` })
    .from(modelTagsTable)
    .groupBy(modelTagsTable.tag)
    .orderBy(desc(sql`count(*)`))
    .limit(50);

  res.json(ListTagsResponse.parse(modelTags.map((t) => ({ name: t.name, count: t.count }))));
});

export default router;
