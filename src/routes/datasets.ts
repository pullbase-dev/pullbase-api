import { Router, type IRouter } from "express";
import multer from "multer";
import os from "os";
import { unlink, readFile } from "fs/promises";
import { eq, ilike, and, desc, sql, inArray } from "drizzle-orm";
import {
  db, datasetsTable, datasetTagsTable, datasetStarsTable,
  usersTable, organizationsTable,
} from "@pullbase/db";
import {
  ListDatasetsQueryParams, ListDatasetsResponse,
  GetDatasetParams, GetDatasetResponse,
  CreateDatasetBody,
  PinDatasetMetadataBody, PinDatasetMetadataResponse,
  SaveDatasetOnchainParams, SaveDatasetOnchainBody, SaveDatasetOnchainResponse,
  StarDatasetParams, StarDatasetBody, StarDatasetResponse,
  UpdateDatasetParams, UpdateDatasetBody,
  DeleteDatasetParams, DeleteDatasetBody,
  TransferDatasetParams, TransferDatasetBody,
} from "@pullbase/api-zod";
import { pinFile, pinDatasetMetadata } from "../services/ipfs";
import { verifyMintTx } from "../services/chain";

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) =>
      cb(null, `pullbase-ds-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const router: IRouter = Router();

router.get("/datasets", async (req, res): Promise<void> => {
  const parsed = ListDatasetsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, ownerAddress: ownerFilter, task, format, license, language, tag, sort, page, limit } = parsed.data;
  const offset = ((page ?? 1) - 1) * (limit ?? 24);
  const pageSize = limit ?? 24;

  const conditions = [];
  if (search) conditions.push(ilike(datasetsTable.name, `%${search}%`));
  if (ownerFilter) conditions.push(eq(datasetsTable.ownerAddress, ownerFilter));
  if (task) conditions.push(eq(datasetsTable.task, task));
  if (format) conditions.push(eq(datasetsTable.format, format));
  if (license) conditions.push(eq(datasetsTable.license, license));
  if (language) conditions.push(eq(datasetsTable.language, language));

  const where = conditions.length > 0 ? and(...conditions) : undefined;

  let orderBy;
  switch (sort) {
    case "stars":   orderBy = desc(datasetsTable.starCount); break;
    case "newest":  orderBy = desc(datasetsTable.createdAt); break;
    case "updated": orderBy = desc(datasetsTable.updatedAt); break;
    default:        orderBy = desc(datasetsTable.downloadCount);
  }

  let tagFilterIds: number[] | null = null;
  if (tag) {
    const matchingTags = await db.select({ datasetId: datasetTagsTable.datasetId })
      .from(datasetTagsTable)
      .where(eq(datasetTagsTable.tag, tag));
    tagFilterIds = matchingTags.map((t) => t.datasetId);
    if (tagFilterIds.length === 0) {
      res.json(ListDatasetsResponse.parse({ items: [], total: 0, page: page ?? 1, limit: pageSize }));
      return;
    }
  }

  const finalWhere = tagFilterIds
    ? where
      ? and(where, inArray(datasetsTable.id, tagFilterIds))
      : inArray(datasetsTable.id, tagFilterIds)
    : where;

  const [rows, [{ count }]] = await Promise.all([
    db.select().from(datasetsTable).where(finalWhere).orderBy(orderBy).limit(pageSize).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(datasetsTable).where(finalWhere),
  ]);

  const dsIds = rows.map((d) => d.id);
  const tags = dsIds.length > 0
    ? await db.select().from(datasetTagsTable).where(inArray(datasetTagsTable.datasetId, dsIds))
    : [];

  const tagMap: Record<number, string[]> = {};
  for (const t of tags) {
    if (!tagMap[t.datasetId]) tagMap[t.datasetId] = [];
    tagMap[t.datasetId].push(t.tag);
  }

  const userAddresses = [...new Set(rows.map((d) => d.ownerAddress))];
  const users = userAddresses.length > 0
    ? await db.select({ walletAddress: usersTable.walletAddress, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.walletAddress, userAddresses))
    : [];
  const userMap: Record<string, string> = {};
  for (const u of users) userMap[u.walletAddress] = u.username;

  const items = rows.map((d) => ({
    ...d,
    sizeBytes: d.sizeBytes ? Number(d.sizeBytes) : null,
    tags: tagMap[d.id] ?? [],
    ownerUsername: userMap[d.ownerAddress] ?? d.ownerAddress.slice(0, 8),
  }));

  res.json(ListDatasetsResponse.parse({ items, total: count, page: page ?? 1, limit: pageSize }));
});

router.post("/datasets/upload", upload.single("file"), async (req, res): Promise<void> => {
  const file = req.file;
  if (!file) {
    res.status(400).json({ error: "No file provided" });
    return;
  }
  const tempPath = (file as Express.Multer.File & { path?: string }).path;
  try {
    const buffer = await readFile(tempPath!);
    const result = await pinFile(buffer, file.originalname, file.mimetype);
    res.json({ cid: result.cid, isDev: result.isDev, filename: file.originalname, size: file.size });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  } finally {
    if (tempPath) unlink(tempPath).catch(() => undefined);
  }
});

router.post("/datasets/pin", async (req, res): Promise<void> => {
  const body = PinDatasetMetadataBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const result = await pinDatasetMetadata(body.data);
    res.json(PinDatasetMetadataResponse.parse(result));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/datasets", async (req, res): Promise<void> => {
  const body = CreateDatasetBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  const { name, slug, tags, ...rest } = body.data;
  const resolvedSlug = slug ?? name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  await db.select({ walletAddress: usersTable.walletAddress })
    .from(usersTable).where(eq(usersTable.walletAddress, rest.ownerAddress)).then(async (rows) => {
      if (rows.length === 0) {
        const username = rest.ownerAddress.slice(0, 8);
        await db.insert(usersTable).values({ walletAddress: rest.ownerAddress, username }).onConflictDoNothing();
      }
    });

  const [dataset] = await db.insert(datasetsTable)
    .values({ ...rest, name, slug: resolvedSlug })
    .returning();

  if (tags && tags.length > 0) {
    await db.insert(datasetTagsTable).values(tags.map((t) => ({ datasetId: dataset.id, tag: t })));
  }

  const [user] = await db.select({ username: usersTable.username })
    .from(usersTable).where(eq(usersTable.walletAddress, dataset.ownerAddress));

  res.status(201).json({
    ...dataset,
    sizeBytes: dataset.sizeBytes ? Number(dataset.sizeBytes) : null,
    tags: tags ?? [],
    ownerUsername: user?.username ?? dataset.ownerAddress.slice(0, 8),
    orgName: null,
    readme: dataset.readme ?? null,
    orgId: dataset.orgId ?? null,
  });
});

router.get("/datasets/:id", async (req, res): Promise<void> => {
  const params = GetDatasetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [dataset] = await db.select().from(datasetsTable).where(eq(datasetsTable.id, params.data.id));
  if (!dataset) {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }

  const [tags, [user], org] = await Promise.all([
    db.select().from(datasetTagsTable).where(eq(datasetTagsTable.datasetId, dataset.id)),
    db.select({ username: usersTable.username }).from(usersTable)
      .where(eq(usersTable.walletAddress, dataset.ownerAddress)),
    dataset.orgId
      ? db.select({ name: organizationsTable.name }).from(organizationsTable)
          .where(eq(organizationsTable.id, dataset.orgId)).then((r) => r[0])
      : Promise.resolve(null),
  ]);

  res.json(GetDatasetResponse.parse({
    ...dataset,
    sizeBytes: dataset.sizeBytes ? Number(dataset.sizeBytes) : null,
    tags: tags.map((t) => t.tag),
    ownerUsername: user?.username ?? dataset.ownerAddress.slice(0, 8),
    orgName: org?.name ?? null,
  }));
});

router.patch("/datasets/:id/onchain", async (req, res): Promise<void> => {
  const params = SaveDatasetOnchainParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SaveDatasetOnchainBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [dataset] = await db.select().from(datasetsTable).where(eq(datasetsTable.id, params.data.id));
  if (!dataset) {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }

  const contractAddress = process.env.CONTRACT_ADDRESS ?? process.env.VITE_CONTRACT_ADDRESS ?? null;
  const verification = await verifyMintTx({
    txHash: body.data.txHash,
    tokenId: body.data.tokenId,
    ipfsCid: body.data.ipfsCid,
    chainId: body.data.chainId,
    contractAddress,
    ownerAddress: dataset.ownerAddress,
    expectedCid: dataset.ipfsCid,
  });

  if (!verification.valid) {
    res.status(422).json({ error: `On-chain verification failed: ${verification.reason}` });
    return;
  }

  const [updated] = await db.update(datasetsTable)
    .set({ isOnChain: true, txHash: body.data.txHash, tokenId: body.data.tokenId,
           ipfsCid: body.data.ipfsCid, chainId: body.data.chainId })
    .where(eq(datasetsTable.id, params.data.id))
    .returning();

  const [tags, [user], org] = await Promise.all([
    db.select().from(datasetTagsTable).where(eq(datasetTagsTable.datasetId, updated.id)),
    db.select({ username: usersTable.username }).from(usersTable)
      .where(eq(usersTable.walletAddress, updated.ownerAddress)),
    updated.orgId
      ? db.select({ name: organizationsTable.name }).from(organizationsTable)
          .where(eq(organizationsTable.id, updated.orgId)).then((r) => r[0])
      : Promise.resolve(null),
  ]);

  res.json(SaveDatasetOnchainResponse.parse({
    ...updated,
    sizeBytes: updated.sizeBytes ? Number(updated.sizeBytes) : null,
    tags: tags.map((t) => t.tag),
    ownerUsername: user?.username ?? updated.ownerAddress.slice(0, 8),
    orgName: org?.name ?? null,
  }));
});

async function buildDatasetDetail(id: number) {
  const [dataset] = await db.select().from(datasetsTable).where(eq(datasetsTable.id, id));
  if (!dataset) return null;
  const [tags, [user], org] = await Promise.all([
    db.select().from(datasetTagsTable).where(eq(datasetTagsTable.datasetId, dataset.id)),
    db.select({ username: usersTable.username }).from(usersTable)
      .where(eq(usersTable.walletAddress, dataset.ownerAddress)),
    dataset.orgId
      ? db.select({ name: organizationsTable.name }).from(organizationsTable)
          .where(eq(organizationsTable.id, dataset.orgId)).then((r) => r[0])
      : Promise.resolve(null),
  ]);
  return {
    ...dataset,
    sizeBytes: dataset.sizeBytes ? Number(dataset.sizeBytes) : null,
    tags: tags.map((t) => t.tag),
    ownerUsername: user?.username ?? dataset.ownerAddress.slice(0, 8),
    orgName: org?.name ?? null,
  };
}

router.patch("/datasets/:id", async (req, res): Promise<void> => {
  const params = UpdateDatasetParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateDatasetBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [dataset] = await db.select().from(datasetsTable).where(eq(datasetsTable.id, params.data.id));
  if (!dataset) { res.status(404).json({ error: "Dataset not found" }); return; }
  if (dataset.ownerAddress.toLowerCase() !== body.data.walletAddress.toLowerCase()) {
    res.status(403).json({ error: "Only the owner can update this dataset" });
    return;
  }

  const { walletAddress, tags, name, description, readme, visibility, task, format, license, language, sourceUrl } = body.data;
  const patch: Record<string, unknown> = {};
  if (name !== undefined && name !== null) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (readme !== undefined) patch.readme = readme;
  if (visibility !== undefined && visibility !== null) patch.visibility = visibility;
  if (task !== undefined && task !== null) patch.task = task;
  if (format !== undefined && format !== null) patch.format = format;
  if (license !== undefined && license !== null) patch.license = license;
  if (language !== undefined) patch.language = language;
  if (sourceUrl !== undefined) patch.sourceUrl = sourceUrl;

  if (Object.keys(patch).length > 0) {
    await db.update(datasetsTable).set(patch).where(eq(datasetsTable.id, params.data.id));
  }
  if (tags !== undefined && tags !== null) {
    await db.delete(datasetTagsTable).where(eq(datasetTagsTable.datasetId, params.data.id));
    if (tags.length > 0) {
      await db.insert(datasetTagsTable).values(tags.map((tag) => ({ datasetId: params.data.id, tag })));
    }
  }

  const detail = await buildDatasetDetail(params.data.id);
  res.json(GetDatasetResponse.parse(detail));
});

router.delete("/datasets/:id", async (req, res): Promise<void> => {
  const params = DeleteDatasetParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = DeleteDatasetBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [dataset] = await db.select().from(datasetsTable).where(eq(datasetsTable.id, params.data.id));
  if (!dataset) { res.status(404).json({ error: "Dataset not found" }); return; }
  if (dataset.ownerAddress.toLowerCase() !== body.data.walletAddress.toLowerCase()) {
    res.status(403).json({ error: "Only the owner can delete this dataset" });
    return;
  }
  await db.delete(datasetsTable).where(eq(datasetsTable.id, params.data.id));
  res.json({ success: true });
});

router.post("/datasets/:id/transfer", async (req, res): Promise<void> => {
  const params = TransferDatasetParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = TransferDatasetBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  if (!/^0x[a-fA-F0-9]{40}$/.test(body.data.newOwnerAddress)) {
    res.status(400).json({ error: "newOwnerAddress must be a valid 0x address" });
    return;
  }

  const [dataset] = await db.select().from(datasetsTable).where(eq(datasetsTable.id, params.data.id));
  if (!dataset) { res.status(404).json({ error: "Dataset not found" }); return; }
  if (dataset.ownerAddress.toLowerCase() !== body.data.walletAddress.toLowerCase()) {
    res.status(403).json({ error: "Only the current owner can transfer this dataset" });
    return;
  }

  await db.insert(usersTable)
    .values({ walletAddress: body.data.newOwnerAddress, username: body.data.newOwnerAddress.slice(0, 8) })
    .onConflictDoNothing();

  await db.update(datasetsTable)
    .set({ ownerAddress: body.data.newOwnerAddress })
    .where(eq(datasetsTable.id, params.data.id));

  const detail = await buildDatasetDetail(params.data.id);
  res.json(GetDatasetResponse.parse(detail));
});

router.post("/datasets/:id/download", async (req, res): Promise<void> => {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) {
    res.status(400).json({ error: "Invalid dataset id" });
    return;
  }

  const [dataset] = await db.select({ id: datasetsTable.id })
    .from(datasetsTable).where(eq(datasetsTable.id, id));
  if (!dataset) {
    res.status(404).json({ error: "Dataset not found" });
    return;
  }

  const [updated] = await db.update(datasetsTable)
    .set({ downloadCount: sql`${datasetsTable.downloadCount} + 1` })
    .where(eq(datasetsTable.id, id))
    .returning({ downloadCount: datasetsTable.downloadCount });

  res.json({ downloadCount: updated.downloadCount });
});

router.post("/datasets/:id/star", async (req, res): Promise<void> => {
  const params = StarDatasetParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = StarDatasetBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [existing] = await db.select().from(datasetStarsTable)
    .where(and(eq(datasetStarsTable.datasetId, params.data.id), eq(datasetStarsTable.walletAddress, body.data.walletAddress)));

  let starred: boolean;
  if (existing) {
    await db.delete(datasetStarsTable).where(eq(datasetStarsTable.id, existing.id));
    await db.update(datasetsTable).set({ starCount: sql`GREATEST(${datasetsTable.starCount} - 1, 0)` })
      .where(eq(datasetsTable.id, params.data.id));
    starred = false;
  } else {
    await db.insert(datasetStarsTable).values({ datasetId: params.data.id, walletAddress: body.data.walletAddress });
    await db.update(datasetsTable).set({ starCount: sql`${datasetsTable.starCount} + 1` })
      .where(eq(datasetsTable.id, params.data.id));
    starred = true;
  }

  const [{ count }] = await db.select({ count: sql<number>`star_count` })
    .from(datasetsTable).where(eq(datasetsTable.id, params.data.id));

  res.json(StarDatasetResponse.parse({ starred, starCount: count }));
});

export default router;
