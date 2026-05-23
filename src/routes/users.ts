import { Router, type IRouter } from "express";
import { eq, sql, inArray, desc, and } from "drizzle-orm";
import { db, usersTable, modelsTable, datasetsTable, modelTagsTable, datasetTagsTable,
  pullRequestsTable, discussionsTable, modelVersionsTable } from "@pullbase/db";
import {
  GetUserProfileParams,
  GetUserProfileResponse,
  GetUserModelsParams,
  GetUserModelsResponse,
  UpsertUserBody,
  UpsertUserResponse,
  GetUserDashboardParams,
  GetUserDashboardResponse,
} from "@pullbase/api-zod";

const router: IRouter = Router();

router.post("/users/upsert", async (req, res): Promise<void> => {
  const body = UpsertUserBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { walletAddress, username, displayName } = body.data;
  const shortAddr = walletAddress.slice(0, 6) + "..." + walletAddress.slice(-4);
  const finalUsername = username || shortAddr;

  const [existing] = await db.select().from(usersTable).where(eq(usersTable.walletAddress, walletAddress));
  if (existing) {
    const [updated] = await db.update(usersTable)
      .set({ username: finalUsername, displayName: displayName || existing.displayName })
      .where(eq(usersTable.walletAddress, walletAddress))
      .returning();
    const [modelCount] = await db.select({ count: sql<number>`count(*)::int` }).from(modelsTable).where(eq(modelsTable.ownerAddress, walletAddress));
    const [datasetCount] = await db.select({ count: sql<number>`count(*)::int` }).from(datasetsTable).where(eq(datasetsTable.ownerAddress, walletAddress));
    res.json(UpsertUserResponse.parse({ ...updated, modelCount: modelCount.count, datasetCount: datasetCount.count, starCount: 0 }));
    return;
  }

  const [created] = await db.insert(usersTable).values({ walletAddress, username: finalUsername, displayName }).returning();
  res.json(UpsertUserResponse.parse({ ...created, modelCount: 0, datasetCount: 0, starCount: 0 }));
});

router.get("/users/:walletAddress", async (req, res): Promise<void> => {
  const params = GetUserProfileParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [user] = await db.select().from(usersTable).where(eq(usersTable.walletAddress, params.data.walletAddress));
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }

  const [[{ modelCount }], [{ datasetCount }]] = await Promise.all([
    db.select({ modelCount: sql<number>`count(*)::int` }).from(modelsTable).where(eq(modelsTable.ownerAddress, user.walletAddress)),
    db.select({ datasetCount: sql<number>`count(*)::int` }).from(datasetsTable).where(eq(datasetsTable.ownerAddress, user.walletAddress)),
  ]);

  res.json(GetUserProfileResponse.parse({ ...user, modelCount, datasetCount, starCount: 0 }));
});

router.get("/users/:walletAddress/models", async (req, res): Promise<void> => {
  const params = GetUserModelsParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const rows = await db.select().from(modelsTable).where(eq(modelsTable.ownerAddress, params.data.walletAddress)).limit(24);
  const [user] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.walletAddress, params.data.walletAddress));

  const modelIds = rows.map((m) => m.id);
  const tags = modelIds.length > 0
    ? await db.select().from(modelTagsTable).where(inArray(modelTagsTable.modelId, modelIds))
    : [];
  const tagMap: Record<number, string[]> = {};
  for (const t of tags) {
    if (!tagMap[t.modelId]) tagMap[t.modelId] = [];
    tagMap[t.modelId].push(t.tag);
  }

  const items = rows.map((m) => ({
    ...m,
    tags: tagMap[m.id] ?? [],
    ownerUsername: user?.username ?? params.data.walletAddress.slice(0, 8),
  }));

  res.json(GetUserModelsResponse.parse({ items, total: items.length, page: 1, limit: 24 }));
});

router.get("/users/:walletAddress/dashboard", async (req, res): Promise<void> => {
  const params = GetUserDashboardParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const wallet = params.data.walletAddress;

  const [ownedModels, ownedDatasets] = await Promise.all([
    db.select().from(modelsTable).where(eq(modelsTable.ownerAddress, wallet)).orderBy(desc(modelsTable.updatedAt)),
    db.select().from(datasetsTable).where(eq(datasetsTable.ownerAddress, wallet)).orderBy(desc(datasetsTable.updatedAt)),
  ]);

  const modelIds = ownedModels.map((m) => m.id);

  const [tagsRows, prCounts, discussionCounts, versionCounts, dsTagsRows, openPrs, openDiscussions] = await Promise.all([
    modelIds.length > 0
      ? db.select().from(modelTagsTable).where(inArray(modelTagsTable.modelId, modelIds))
      : Promise.resolve([] as { modelId: number; tag: string; id: number }[]),
    modelIds.length > 0
      ? db.select({ modelId: pullRequestsTable.modelId, count: sql<number>`count(*)::int` })
          .from(pullRequestsTable)
          .where(and(inArray(pullRequestsTable.modelId, modelIds), eq(pullRequestsTable.status, "open")))
          .groupBy(pullRequestsTable.modelId)
      : Promise.resolve([] as { modelId: number; count: number }[]),
    modelIds.length > 0
      ? db.select({ modelId: discussionsTable.modelId, count: sql<number>`count(*)::int` })
          .from(discussionsTable)
          .where(and(inArray(discussionsTable.modelId, modelIds), eq(discussionsTable.isClosed, false)))
          .groupBy(discussionsTable.modelId)
      : Promise.resolve([] as { modelId: number; count: number }[]),
    modelIds.length > 0
      ? db.select({ modelId: modelVersionsTable.modelId, count: sql<number>`count(*)::int` })
          .from(modelVersionsTable)
          .where(inArray(modelVersionsTable.modelId, modelIds))
          .groupBy(modelVersionsTable.modelId)
      : Promise.resolve([] as { modelId: number; count: number }[]),
    ownedDatasets.length > 0
      ? db.select().from(datasetTagsTable).where(inArray(datasetTagsTable.datasetId, ownedDatasets.map((d) => d.id)))
      : Promise.resolve([] as { datasetId: number; tag: string; id: number }[]),
    modelIds.length > 0
      ? db.select({
          id: pullRequestsTable.id, modelId: pullRequestsTable.modelId,
          title: pullRequestsTable.title, authorAddress: pullRequestsTable.authorAddress,
          status: pullRequestsTable.status, commentCount: pullRequestsTable.commentCount,
          createdAt: pullRequestsTable.createdAt,
        })
          .from(pullRequestsTable)
          .where(and(inArray(pullRequestsTable.modelId, modelIds), eq(pullRequestsTable.status, "open")))
          .orderBy(desc(pullRequestsTable.createdAt))
          .limit(50)
      : Promise.resolve([] as Array<{ id: number; modelId: number; title: string; authorAddress: string; status: string; commentCount: number; createdAt: Date }>),
    modelIds.length > 0
      ? db.select({
          id: discussionsTable.id, modelId: discussionsTable.modelId,
          title: discussionsTable.title, authorAddress: discussionsTable.authorAddress,
          commentCount: discussionsTable.commentCount,
          createdAt: discussionsTable.createdAt,
        })
          .from(discussionsTable)
          .where(and(inArray(discussionsTable.modelId, modelIds), eq(discussionsTable.isClosed, false)))
          .orderBy(desc(discussionsTable.createdAt))
          .limit(50)
      : Promise.resolve([] as Array<{ id: number; modelId: number; title: string; authorAddress: string; commentCount: number; createdAt: Date }>),
  ]);

  const tagMap: Record<number, string[]> = {};
  for (const t of tagsRows) {
    (tagMap[t.modelId] ??= []).push(t.tag);
  }
  const dsTagMap: Record<number, string[]> = {};
  for (const t of dsTagsRows) {
    (dsTagMap[t.datasetId] ??= []).push(t.tag);
  }
  const prMap = Object.fromEntries(prCounts.map((r) => [r.modelId, r.count]));
  const discMap = Object.fromEntries(discussionCounts.map((r) => [r.modelId, r.count]));
  const versionMap = Object.fromEntries(versionCounts.map((r) => [r.modelId, r.count]));

  const [me] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.walletAddress, wallet));
  const ownerUsername = me?.username ?? wallet.slice(0, 8);

  const modelsEnriched = ownedModels.map((m) => ({
    ...m,
    tags: tagMap[m.id] ?? [],
    ownerUsername,
    openPrCount: prMap[m.id] ?? 0,
    openDiscussionCount: discMap[m.id] ?? 0,
    versionCount: versionMap[m.id] ?? 0,
  }));

  const datasetsEnriched = ownedDatasets.map((d) => ({
    ...d,
    sizeBytes: d.sizeBytes ? Number(d.sizeBytes) : null,
    tags: dsTagMap[d.id] ?? [],
    ownerUsername,
  }));

  const modelNameById: Record<number, string> = Object.fromEntries(ownedModels.map((m) => [m.id, m.name]));

  const authorAddrs = [...new Set([...openPrs.map((p) => p.authorAddress), ...openDiscussions.map((d) => d.authorAddress)])];
  const authors = authorAddrs.length > 0
    ? await db.select({ walletAddress: usersTable.walletAddress, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.walletAddress, authorAddrs))
    : [];
  const authorMap: Record<string, string> = Object.fromEntries(authors.map((a) => [a.walletAddress, a.username]));

  const inbox = [
    ...openPrs.map((p) => ({
      kind: "pr" as const,
      id: p.id, modelId: p.modelId, modelName: modelNameById[p.modelId] ?? "model",
      title: p.title, authorAddress: p.authorAddress,
      authorUsername: authorMap[p.authorAddress] ?? null,
      commentCount: p.commentCount, status: p.status,
      createdAt: p.createdAt.toISOString(),
    })),
    ...openDiscussions.map((d) => ({
      kind: "discussion" as const,
      id: d.id, modelId: d.modelId, modelName: modelNameById[d.modelId] ?? "model",
      title: d.title, authorAddress: d.authorAddress,
      authorUsername: authorMap[d.authorAddress] ?? null,
      commentCount: d.commentCount, status: null,
      createdAt: d.createdAt.toISOString(),
    })),
  ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);

  const totals = {
    modelCount: ownedModels.length,
    datasetCount: ownedDatasets.length,
    totalDownloads: ownedModels.reduce((s, m) => s + m.downloadCount, 0) + ownedDatasets.reduce((s, d) => s + d.downloadCount, 0),
    totalStars: ownedModels.reduce((s, m) => s + m.starCount, 0) + ownedDatasets.reduce((s, d) => s + d.starCount, 0),
    totalForks: ownedModels.reduce((s, m) => s + m.forkCount, 0),
    openPrCount: Object.values(prMap).reduce((a, b) => a + b, 0),
    openDiscussionCount: Object.values(discMap).reduce((a, b) => a + b, 0),
  };

  res.json(GetUserDashboardResponse.parse({
    models: modelsEnriched,
    datasets: datasetsEnriched,
    inbox,
    totals,
  }));
});

export default router;
