import { Router, type IRouter } from "express";
import multer from "multer";
import os from "os";
import path from "path";
import { unlink, readFile } from "fs/promises";
import { eq, ilike, and, desc, sql, inArray } from "drizzle-orm";
import { db, modelsTable, modelTagsTable, modelStarsTable, usersTable, organizationsTable } from "@pullbase/db";
import {
  ListModelsQueryParams,
  ListModelsResponse,
  GetModelParams,
  GetModelResponse,
  StarModelParams,
  StarModelBody,
  StarModelResponse,
  CreateModelBody,
  PinModelMetadataBody,
  PinModelMetadataResponse,
  SaveOnchainParams,
  SaveOnchainBody,
  SaveOnchainResponse,
  UpdateModelParams,
  UpdateModelBody,
  DeleteModelParams,
  DeleteModelBody,
  TransferModelParams,
  TransferModelBody,
  ImportGithubFileBody,
  ImportGithubFileResponse,
} from "@pullbase/api-zod";
import { pinModelMetadata as pinToIPFS, pinFile } from "../services/ipfs";
import { verifyMintTx } from "../services/chain";

const upload = multer({
  storage: multer.diskStorage({
    destination: os.tmpdir(),
    filename: (_req, _file, cb) =>
      cb(null, `pullbase-upload-${Date.now()}-${Math.random().toString(36).slice(2)}`),
  }),
  limits: { fileSize: 200 * 1024 * 1024 },
});

const router: IRouter = Router();

router.get("/models", async (req, res): Promise<void> => {
  const parsed = ListModelsQueryParams.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { search, task, framework, license, language, tag, sort, page, limit } = parsed.data;
  const offset = ((page ?? 1) - 1) * (limit ?? 24);
  const pageSize = limit ?? 24;

  let tagFilterIds: number[] | null = null;
  if (tag) {
    const matchingTags = await db.select({ modelId: modelTagsTable.modelId })
      .from(modelTagsTable)
      .where(eq(modelTagsTable.tag, tag));
    tagFilterIds = matchingTags.map((t) => t.modelId);
    if (tagFilterIds.length === 0) {
      res.json({ items: [], total: 0, page: page ?? 1, limit: pageSize });
      return;
    }
  }

  const conditions = [];
  if (search) conditions.push(ilike(modelsTable.name, `%${search}%`));
  if (task) conditions.push(eq(modelsTable.task, task));
  if (framework) conditions.push(eq(modelsTable.framework, framework));
  if (license) conditions.push(eq(modelsTable.license, license));
  if (language) conditions.push(eq(modelsTable.language, language));

  const baseWhere = conditions.length > 0 ? and(...conditions) : undefined;
  const where = tagFilterIds
    ? baseWhere
      ? and(baseWhere, inArray(modelsTable.id, tagFilterIds))
      : inArray(modelsTable.id, tagFilterIds)
    : baseWhere;

  let orderBy;
  switch (sort) {
    case "stars":    orderBy = desc(modelsTable.starCount); break;
    case "newest":   orderBy = desc(modelsTable.createdAt); break;
    case "updated":  orderBy = desc(modelsTable.updatedAt); break;
    default:         orderBy = desc(modelsTable.downloadCount);
  }

  const [rows, [{ count }]] = await Promise.all([
    db.select().from(modelsTable).where(where).orderBy(orderBy).limit(pageSize).offset(offset),
    db.select({ count: sql<number>`count(*)::int` }).from(modelsTable).where(where),
  ]);

  const modelIds = rows.map((m) => m.id);
  const tags = modelIds.length > 0
    ? await db.select().from(modelTagsTable).where(inArray(modelTagsTable.modelId, modelIds))
    : [];

  const tagMap: Record<number, string[]> = {};
  for (const t of tags) {
    if (!tagMap[t.modelId]) tagMap[t.modelId] = [];
    tagMap[t.modelId].push(t.tag);
  }

  const userAddresses = [...new Set(rows.map((m) => m.ownerAddress))];
  const users = userAddresses.length > 0
    ? await db.select({ walletAddress: usersTable.walletAddress, username: usersTable.username })
        .from(usersTable).where(inArray(usersTable.walletAddress, userAddresses))
    : [];
  const userMap: Record<string, string> = {};
  for (const u of users) userMap[u.walletAddress] = u.username;

  const items = rows.map((m) => ({
    ...m,
    tags: tagMap[m.id] ?? [],
    ownerUsername: userMap[m.ownerAddress] ?? m.ownerAddress.slice(0, 8),
  }));

  res.json(ListModelsResponse.parse({ items, total: count, page: page ?? 1, limit: pageSize }));
});

router.get("/models/:id", async (req, res): Promise<void> => {
  const params = GetModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, params.data.id));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }

  const [tags, [user], org] = await Promise.all([
    db.select().from(modelTagsTable).where(eq(modelTagsTable.modelId, model.id)),
    db.select({ username: usersTable.username }).from(usersTable)
      .where(eq(usersTable.walletAddress, model.ownerAddress)),
    model.orgId
      ? db.select({ name: organizationsTable.name }).from(organizationsTable)
          .where(eq(organizationsTable.id, model.orgId)).then((r) => r[0])
      : Promise.resolve(null),
  ]);

  res.json(GetModelResponse.parse({
    ...model,
    tags: tags.map((t) => t.tag),
    ownerUsername: user?.username ?? model.ownerAddress.slice(0, 8),
    orgName: org?.name ?? null,
  }));
});

router.post("/models/upload", upload.single("file"), async (req, res): Promise<void> => {
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

const MAX_IMPORT_BYTES = 100 * 1024 * 1024;

function parseGithubUrl(url: string): { rawUrl: string; canonicalBlobUrl: string; filename: string } | null {
  try {
    const u = new URL(url);
    if (u.hostname === "raw.githubusercontent.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length < 4) return null;
      const [owner, repo, ref, ...filePath] = parts;
      const filename = filePath[filePath.length - 1];
      return {
        rawUrl: url,
        canonicalBlobUrl: `https://github.com/${owner}/${repo}/blob/${ref}/${filePath.join("/")}`,
        filename,
      };
    }
    if (u.hostname === "github.com" || u.hostname === "www.github.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      const blobIdx = parts.indexOf("blob");
      if (blobIdx < 2 || blobIdx + 2 > parts.length - 1) return null;
      const owner = parts[0], repo = parts[1];
      const ref = parts[blobIdx + 1];
      const filePath = parts.slice(blobIdx + 2);
      const filename = filePath[filePath.length - 1];
      return {
        rawUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${filePath.join("/")}`,
        canonicalBlobUrl: `https://github.com/${owner}/${repo}/blob/${ref}/${filePath.join("/")}`,
        filename,
      };
    }
    return null;
  } catch {
    return null;
  }
}

router.post("/import/github-file", async (req, res): Promise<void> => {
  const body = ImportGithubFileBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const parsed = parseGithubUrl(body.data.url);
  if (!parsed) {
    res.status(400).json({ error: "URL must be a GitHub blob URL (github.com/owner/repo/blob/...) or raw URL (raw.githubusercontent.com/...)" });
    return;
  }

  let ghRes: Response;
  try {
    ghRes = await fetch(parsed.rawUrl, { headers: { "User-Agent": "PullBase-Importer" }, redirect: "follow", signal: AbortSignal.timeout(60_000) });
  } catch (e) {
    res.status(502).json({ error: `Failed to reach GitHub: ${String(e)}` });
    return;
  }
  if (ghRes.status === 404) { res.status(404).json({ error: "File not found on GitHub" }); return; }
  if (!ghRes.ok) { res.status(502).json({ error: `GitHub responded ${ghRes.status}` }); return; }

  const lenHeader = ghRes.headers.get("content-length");
  if (lenHeader && parseInt(lenHeader, 10) > MAX_IMPORT_BYTES) {
    res.status(400).json({ error: `File too large (>${MAX_IMPORT_BYTES / 1024 / 1024} MB)` });
    return;
  }

  const arrayBuf = await ghRes.arrayBuffer();
  if (arrayBuf.byteLength > MAX_IMPORT_BYTES) {
    res.status(400).json({ error: `File too large (>${MAX_IMPORT_BYTES / 1024 / 1024} MB)` });
    return;
  }

  const mimeType = ghRes.headers.get("content-type") ?? "application/octet-stream";
  try {
    const result = await pinFile(Buffer.from(arrayBuf), parsed.filename, mimeType);
    res.json(ImportGithubFileResponse.parse({
      cid: result.cid,
      filename: parsed.filename,
      size: arrayBuf.byteLength,
      sourceUrl: parsed.canonicalBlobUrl,
      isDev: result.isDev,
    }));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

router.post("/models/pin", async (req, res): Promise<void> => {
  const body = PinModelMetadataBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }
  try {
    const result = await pinToIPFS(body.data);
    res.json(PinModelMetadataResponse.parse(result));
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

router.post("/models", async (req, res): Promise<void> => {
  const body = CreateModelBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const { name, slug, description, readme, ownerAddress, orgId, task, framework,
          license, parameterCount, tags, isOnChain, ipfsCid, txHash, tokenId, chainId, sourceUrl } = body.data;

  const resolvedSlug = slug ?? name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");

  const existing = await db.select({ id: modelsTable.id }).from(modelsTable)
    .where(and(eq(modelsTable.slug, resolvedSlug), eq(modelsTable.ownerAddress, ownerAddress)));
  if (existing.length > 0) {
    res.status(409).json({ error: "A model with that slug already exists for this owner" });
    return;
  }

  const [inserted] = await db.insert(modelsTable).values({
    name, slug: resolvedSlug, description: description ?? null,
    readme: readme ?? null, ownerAddress,
    orgId: orgId ?? null, task, framework, license,
    parameterCount: parameterCount ?? null,
    isOnChain: isOnChain ?? false,
    ipfsCid: ipfsCid ?? null, txHash: txHash ?? null,
    tokenId: tokenId ?? null, chainId: chainId ?? null,
    sourceUrl: sourceUrl ?? null,
  }).returning();

  if (tags && tags.length > 0) {
    await db.insert(modelTagsTable).values(tags.map((tag) => ({ modelId: inserted.id, tag })));
  }

  const [user] = await db.select({ username: usersTable.username })
    .from(usersTable).where(eq(usersTable.walletAddress, ownerAddress));

  res.status(201).json(GetModelResponse.parse({
    ...inserted,
    tags: tags ?? [],
    ownerUsername: user?.username ?? ownerAddress.slice(0, 8),
    orgName: null, readme: inserted.readme ?? null, orgId: inserted.orgId ?? null,
  }));
});

router.patch("/models/:id/onchain", async (req, res): Promise<void> => {
  const params = SaveOnchainParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = SaveOnchainBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, params.data.id));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }

  const contractAddress = process.env.CONTRACT_ADDRESS ?? process.env.VITE_CONTRACT_ADDRESS ?? null;
  const verification = await verifyMintTx({
    txHash: body.data.txHash,
    tokenId: body.data.tokenId,
    ipfsCid: body.data.ipfsCid,
    chainId: body.data.chainId,
    contractAddress,
    ownerAddress: model.ownerAddress,
    expectedCid: model.ipfsCid,
  });

  if (!verification.valid) {
    res.status(422).json({ error: `On-chain verification failed: ${verification.reason}` });
    return;
  }

  const [updated] = await db.update(modelsTable)
    .set({ isOnChain: true, txHash: body.data.txHash, tokenId: body.data.tokenId,
           ipfsCid: body.data.ipfsCid, chainId: body.data.chainId })
    .where(eq(modelsTable.id, params.data.id))
    .returning();

  const [tags, [user], org] = await Promise.all([
    db.select().from(modelTagsTable).where(eq(modelTagsTable.modelId, updated.id)),
    db.select({ username: usersTable.username }).from(usersTable)
      .where(eq(usersTable.walletAddress, updated.ownerAddress)),
    updated.orgId
      ? db.select({ name: organizationsTable.name }).from(organizationsTable)
          .where(eq(organizationsTable.id, updated.orgId)).then((r) => r[0])
      : Promise.resolve(null),
  ]);

  res.json(SaveOnchainResponse.parse({
    ...updated,
    tags: tags.map((t) => t.tag),
    ownerUsername: user?.username ?? updated.ownerAddress.slice(0, 8),
    orgName: org?.name ?? null,
  }));
});

async function buildModelDetail(modelId: number) {
  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, modelId));
  if (!model) return null;
  const [tags, [user], org] = await Promise.all([
    db.select().from(modelTagsTable).where(eq(modelTagsTable.modelId, model.id)),
    db.select({ username: usersTable.username }).from(usersTable)
      .where(eq(usersTable.walletAddress, model.ownerAddress)),
    model.orgId
      ? db.select({ name: organizationsTable.name }).from(organizationsTable)
          .where(eq(organizationsTable.id, model.orgId)).then((r) => r[0])
      : Promise.resolve(null),
  ]);
  return {
    ...model,
    tags: tags.map((t) => t.tag),
    ownerUsername: user?.username ?? model.ownerAddress.slice(0, 8),
    orgName: org?.name ?? null,
  };
}

router.patch("/models/:id", async (req, res): Promise<void> => {
  const params = UpdateModelParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = UpdateModelBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, params.data.id));
  if (!model) { res.status(404).json({ error: "Model not found" }); return; }
  if (model.ownerAddress.toLowerCase() !== body.data.walletAddress.toLowerCase()) {
    res.status(403).json({ error: "Only the owner can update this model" });
    return;
  }

  const { walletAddress, tags, name, description, readme, visibility, task, framework, license, language, parameterCount, sourceUrl } = body.data;
  const patch: Record<string, unknown> = {};
  if (name !== undefined && name !== null) patch.name = name;
  if (description !== undefined) patch.description = description;
  if (readme !== undefined) patch.readme = readme;
  if (visibility !== undefined && visibility !== null) patch.visibility = visibility;
  if (task !== undefined && task !== null) patch.task = task;
  if (framework !== undefined && framework !== null) patch.framework = framework;
  if (license !== undefined && license !== null) patch.license = license;
  if (language !== undefined) patch.language = language;
  if (parameterCount !== undefined) patch.parameterCount = parameterCount;
  if (sourceUrl !== undefined) patch.sourceUrl = sourceUrl;

  if (Object.keys(patch).length > 0) {
    await db.update(modelsTable).set(patch).where(eq(modelsTable.id, params.data.id));
  }
  if (tags !== undefined && tags !== null) {
    await db.delete(modelTagsTable).where(eq(modelTagsTable.modelId, params.data.id));
    if (tags.length > 0) {
      await db.insert(modelTagsTable).values(tags.map((tag) => ({ modelId: params.data.id, tag })));
    }
  }

  const detail = await buildModelDetail(params.data.id);
  res.json(GetModelResponse.parse(detail));
});

router.delete("/models/:id", async (req, res): Promise<void> => {
  const params = DeleteModelParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = DeleteModelBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, params.data.id));
  if (!model) { res.status(404).json({ error: "Model not found" }); return; }
  if (model.ownerAddress.toLowerCase() !== body.data.walletAddress.toLowerCase()) {
    res.status(403).json({ error: "Only the owner can delete this model" });
    return;
  }

  await db.delete(modelsTable).where(eq(modelsTable.id, params.data.id));
  res.json({ success: true });
});

router.post("/models/:id/transfer", async (req, res): Promise<void> => {
  const params = TransferModelParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: params.error.message }); return; }
  const body = TransferModelBody.safeParse(req.body);
  if (!body.success) { res.status(400).json({ error: body.error.message }); return; }

  if (!/^0x[a-fA-F0-9]{40}$/.test(body.data.newOwnerAddress)) {
    res.status(400).json({ error: "newOwnerAddress must be a valid 0x address" });
    return;
  }

  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, params.data.id));
  if (!model) { res.status(404).json({ error: "Model not found" }); return; }
  if (model.ownerAddress.toLowerCase() !== body.data.walletAddress.toLowerCase()) {
    res.status(403).json({ error: "Only the current owner can transfer this model" });
    return;
  }

  await db.insert(usersTable)
    .values({ walletAddress: body.data.newOwnerAddress, username: body.data.newOwnerAddress.slice(0, 8) })
    .onConflictDoNothing();

  await db.update(modelsTable)
    .set({ ownerAddress: body.data.newOwnerAddress })
    .where(eq(modelsTable.id, params.data.id));

  const detail = await buildModelDetail(params.data.id);
  res.json(GetModelResponse.parse(detail));
});

router.post("/models/:id/star", async (req, res): Promise<void> => {
  const params = StarModelParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }
  const body = StarModelBody.safeParse(req.body);
  if (!body.success) {
    res.status(400).json({ error: body.error.message });
    return;
  }

  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, params.data.id));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }

  const [existing] = await db.select().from(modelStarsTable)
    .where(and(eq(modelStarsTable.modelId, params.data.id), eq(modelStarsTable.walletAddress, body.data.walletAddress)));

  let starred: boolean;
  if (existing) {
    await db.delete(modelStarsTable)
      .where(and(eq(modelStarsTable.modelId, params.data.id), eq(modelStarsTable.walletAddress, body.data.walletAddress)));
    await db.update(modelsTable).set({ starCount: sql`GREATEST(${modelsTable.starCount} - 1, 0)` }).where(eq(modelsTable.id, params.data.id));
    starred = false;
  } else {
    await db.insert(modelStarsTable).values({ modelId: params.data.id, walletAddress: body.data.walletAddress });
    await db.update(modelsTable).set({ starCount: sql`${modelsTable.starCount} + 1` }).where(eq(modelsTable.id, params.data.id));
    starred = true;
  }

  const [updated] = await db.select({ starCount: modelsTable.starCount }).from(modelsTable).where(eq(modelsTable.id, params.data.id));
  res.json(StarModelResponse.parse({ starred, starCount: updated.starCount }));
});

export default router;
