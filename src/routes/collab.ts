import { Router, type IRouter } from "express";
import { eq, desc, sql, inArray, and } from "drizzle-orm";
import {
  db,
  modelsTable,
  modelVersionsTable,
  discussionsTable,
  discussionCommentsTable,
  pullRequestsTable,
  prCommentsTable,
  usersTable,
} from "@pullbase/db";

const router: IRouter = Router();

async function attachUsernames<T extends { authorAddress: string }>(rows: T[]): Promise<(T & { authorUsername: string | null })[]> {
  if (rows.length === 0) return [];
  const addrs = [...new Set(rows.map((r) => r.authorAddress))];
  const users = await db
    .select({ walletAddress: usersTable.walletAddress, username: usersTable.username })
    .from(usersTable)
    .where(inArray(usersTable.walletAddress, addrs));
  const map: Record<string, string> = {};
  for (const u of users) map[u.walletAddress] = u.username;
  return rows.map((r) => ({ ...r, authorUsername: map[r.authorAddress] ?? null }));
}

async function ensureUser(address: string): Promise<void> {
  await db
    .insert(usersTable)
    .values({ walletAddress: address, username: address.slice(0, 8).toLowerCase() })
    .onConflictDoNothing();
}

router.get("/models/:id/versions", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const rows = await db.select().from(modelVersionsTable).where(eq(modelVersionsTable.modelId, id)).orderBy(desc(modelVersionsTable.createdAt));
  const items = await attachUsernames(rows);
  res.json({ items });
});

router.post("/models/:id/versions", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const { version, changelog, ipfsCid, txHash, tokenId, chainId, sizeBytes, authorAddress } = req.body ?? {};
  if (!version || !authorAddress) { res.status(400).json({ error: "version and authorAddress required" }); return; }

  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, id));
  if (!model) { res.status(404).json({ error: "Model not found" }); return; }
  if (model.ownerAddress.toLowerCase() !== String(authorAddress).toLowerCase()) {
    res.status(403).json({ error: "Only owner can publish new versions" }); return;
  }

  await ensureUser(authorAddress);
  const [inserted] = await db.insert(modelVersionsTable).values({
    modelId: id, version, changelog: changelog ?? null, ipfsCid: ipfsCid ?? null,
    txHash: txHash ?? null, tokenId: tokenId ?? null, chainId: chainId ?? null,
    sizeBytes: sizeBytes ?? null, authorAddress,
  }).returning();

  await db.update(modelsTable).set({
    ipfsCid: ipfsCid ?? model.ipfsCid,
    txHash: txHash ?? model.txHash,
    tokenId: tokenId ?? model.tokenId,
    chainId: chainId ?? model.chainId,
  }).where(eq(modelsTable.id, id));

  const [withUser] = await attachUsernames([inserted]);
  res.status(201).json(withUser);
});

router.post("/models/:id/fork", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const { ownerAddress, name } = req.body ?? {};
  if (!ownerAddress) { res.status(400).json({ error: "ownerAddress required" }); return; }

  const [source] = await db.select().from(modelsTable).where(eq(modelsTable.id, id));
  if (!source) { res.status(404).json({ error: "Model not found" }); return; }

  await ensureUser(ownerAddress);

  const forkName = name ?? source.name;
  const baseSlug = (forkName as string).toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "");
  let slug = baseSlug;
  let n = 1;
  while (true) {
    const [exists] = await db.select({ id: modelsTable.id }).from(modelsTable)
      .where(and(eq(modelsTable.slug, slug), eq(modelsTable.ownerAddress, ownerAddress)));
    if (!exists) break;
    n += 1;
    slug = `${baseSlug}-${n}`;
  }

  const [forked] = await db.insert(modelsTable).values({
    name: forkName,
    slug,
    description: source.description,
    readme: source.readme,
    ownerAddress,
    orgId: null,
    task: source.task,
    framework: source.framework,
    license: source.license,
    parameterCount: source.parameterCount,
    language: source.language,
    isOnChain: false,
    forkedFromId: source.id,
  }).returning();

  await db.update(modelsTable).set({ forkCount: sql`${modelsTable.forkCount} + 1` }).where(eq(modelsTable.id, source.id));

  const [user] = await db.select({ username: usersTable.username }).from(usersTable).where(eq(usersTable.walletAddress, ownerAddress));
  res.status(201).json({
    ...forked,
    tags: [],
    ownerUsername: user?.username ?? ownerAddress.slice(0, 8),
    orgName: null,
  });
});

router.get("/models/:id/forks", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const rows = await db.select().from(modelsTable).where(eq(modelsTable.forkedFromId, id)).orderBy(desc(modelsTable.createdAt));
  const addrs = [...new Set(rows.map((r) => r.ownerAddress))];
  const users = addrs.length > 0
    ? await db.select({ walletAddress: usersTable.walletAddress, username: usersTable.username }).from(usersTable).where(inArray(usersTable.walletAddress, addrs))
    : [];
  const map: Record<string, string> = {};
  for (const u of users) map[u.walletAddress] = u.username;
  const items = rows.map((r) => ({ ...r, tags: [], ownerUsername: map[r.ownerAddress] ?? r.ownerAddress.slice(0, 8) }));
  res.json({ items, total: items.length, page: 1, limit: items.length });
});

router.get("/models/:id/discussions", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const rows = await db.select().from(discussionsTable).where(eq(discussionsTable.modelId, id)).orderBy(desc(discussionsTable.updatedAt));
  const items = await attachUsernames(rows);
  res.json({ items });
});

router.post("/models/:id/discussions", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const { authorAddress, title, body } = req.body ?? {};
  if (!authorAddress || !title || !body) { res.status(400).json({ error: "authorAddress, title, body required" }); return; }

  const [model] = await db.select({ id: modelsTable.id }).from(modelsTable).where(eq(modelsTable.id, id));
  if (!model) { res.status(404).json({ error: "Model not found" }); return; }

  await ensureUser(authorAddress);
  const [inserted] = await db.insert(discussionsTable).values({ modelId: id, authorAddress, title, body }).returning();
  const [withUser] = await attachUsernames([inserted]);
  res.status(201).json(withUser);
});

router.get("/discussions/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const [discussion] = await db.select().from(discussionsTable).where(eq(discussionsTable.id, id));
  if (!discussion) { res.status(404).json({ error: "Discussion not found" }); return; }
  const comments = await db.select().from(discussionCommentsTable).where(eq(discussionCommentsTable.discussionId, id)).orderBy(discussionCommentsTable.createdAt);
  const [withUser] = await attachUsernames([discussion]);
  const commentsWithUsers = await attachUsernames(comments);
  res.json({ ...withUser, comments: commentsWithUsers });
});

router.post("/discussions/:id/comments", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const { authorAddress, body } = req.body ?? {};
  if (!authorAddress || !body) { res.status(400).json({ error: "authorAddress, body required" }); return; }
  const [discussion] = await db.select({ id: discussionsTable.id }).from(discussionsTable).where(eq(discussionsTable.id, id));
  if (!discussion) { res.status(404).json({ error: "Discussion not found" }); return; }

  await ensureUser(authorAddress);
  const [inserted] = await db.insert(discussionCommentsTable).values({ discussionId: id, authorAddress, body }).returning();
  await db.update(discussionsTable).set({ commentCount: sql`${discussionsTable.commentCount} + 1` }).where(eq(discussionsTable.id, id));
  const [withUser] = await attachUsernames([inserted]);
  res.status(201).json(withUser);
});

router.get("/models/:id/prs", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const rows = await db.select().from(pullRequestsTable).where(eq(pullRequestsTable.modelId, id)).orderBy(desc(pullRequestsTable.updatedAt));
  const items = await attachUsernames(rows);
  res.json({ items });
});

router.post("/models/:id/prs", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const { authorAddress, title, body, proposedReadme, proposedDescription } = req.body ?? {};
  if (!authorAddress || !title) { res.status(400).json({ error: "authorAddress, title required" }); return; }
  if (!proposedReadme && !proposedDescription) { res.status(400).json({ error: "Provide at least one proposed change (readme or description)" }); return; }

  const [model] = await db.select({ id: modelsTable.id }).from(modelsTable).where(eq(modelsTable.id, id));
  if (!model) { res.status(404).json({ error: "Model not found" }); return; }

  await ensureUser(authorAddress);
  const [inserted] = await db.insert(pullRequestsTable).values({
    modelId: id, authorAddress, title, body: body ?? null,
    proposedReadme: proposedReadme ?? null,
    proposedDescription: proposedDescription ?? null,
  }).returning();
  const [withUser] = await attachUsernames([inserted]);
  res.status(201).json(withUser);
});

router.get("/prs/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const [pr] = await db.select().from(pullRequestsTable).where(eq(pullRequestsTable.id, id));
  if (!pr) { res.status(404).json({ error: "PR not found" }); return; }
  const comments = await db.select().from(prCommentsTable).where(eq(prCommentsTable.prId, id)).orderBy(prCommentsTable.createdAt);
  const [withUser] = await attachUsernames([pr]);
  const commentsWithUsers = await attachUsernames(comments);
  res.json({ ...withUser, comments: commentsWithUsers });
});

router.post("/prs/:id/comments", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const { authorAddress, body } = req.body ?? {};
  if (!authorAddress || !body) { res.status(400).json({ error: "authorAddress, body required" }); return; }
  const [pr] = await db.select({ id: pullRequestsTable.id }).from(pullRequestsTable).where(eq(pullRequestsTable.id, id));
  if (!pr) { res.status(404).json({ error: "PR not found" }); return; }

  await ensureUser(authorAddress);
  const [inserted] = await db.insert(prCommentsTable).values({ prId: id, authorAddress, body }).returning();
  await db.update(pullRequestsTable).set({ commentCount: sql`${pullRequestsTable.commentCount} + 1` }).where(eq(pullRequestsTable.id, id));
  const [withUser] = await attachUsernames([inserted]);
  res.status(201).json(withUser);
});

router.post("/prs/:id/merge", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const { actorAddress } = req.body ?? {};
  if (!actorAddress) { res.status(400).json({ error: "actorAddress required" }); return; }

  const [pr] = await db.select().from(pullRequestsTable).where(eq(pullRequestsTable.id, id));
  if (!pr) { res.status(404).json({ error: "PR not found" }); return; }
  if (pr.status !== "open") { res.status(409).json({ error: `PR already ${pr.status}` }); return; }

  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, pr.modelId));
  if (!model) { res.status(404).json({ error: "Model not found" }); return; }
  if (model.ownerAddress.toLowerCase() !== String(actorAddress).toLowerCase()) {
    res.status(403).json({ error: "Only model owner can merge PRs" }); return;
  }

  const updatedRows = await db.update(pullRequestsTable).set({
    status: "merged", mergedAt: new Date(), mergedBy: actorAddress,
  }).where(and(eq(pullRequestsTable.id, id), eq(pullRequestsTable.status, "open"))).returning();
  if (updatedRows.length === 0) { res.status(409).json({ error: "PR already merged or closed" }); return; }

  await db.update(modelsTable).set({
    readme: pr.proposedReadme ?? model.readme,
    description: pr.proposedDescription ?? model.description,
  }).where(eq(modelsTable.id, model.id));

  const [withUser] = await attachUsernames([updatedRows[0]]);
  res.json(withUser);
});

router.post("/prs/:id/close", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "bad id" }); return; }
  const { actorAddress } = req.body ?? {};
  if (!actorAddress) { res.status(400).json({ error: "actorAddress required" }); return; }

  const [pr] = await db.select().from(pullRequestsTable).where(eq(pullRequestsTable.id, id));
  if (!pr) { res.status(404).json({ error: "PR not found" }); return; }
  if (pr.status !== "open") { res.status(409).json({ error: `PR already ${pr.status}` }); return; }

  const [model] = await db.select({ ownerAddress: modelsTable.ownerAddress }).from(modelsTable).where(eq(modelsTable.id, pr.modelId));
  const isOwner = model && model.ownerAddress.toLowerCase() === String(actorAddress).toLowerCase();
  const isAuthor = pr.authorAddress.toLowerCase() === String(actorAddress).toLowerCase();
  if (!isOwner && !isAuthor) {
    res.status(403).json({ error: "Only model owner or PR author can close" }); return;
  }

  const updatedRows = await db.update(pullRequestsTable).set({ status: "closed" })
    .where(and(eq(pullRequestsTable.id, id), eq(pullRequestsTable.status, "open"))).returning();
  if (updatedRows.length === 0) { res.status(409).json({ error: "PR already merged or closed" }); return; }
  const [withUser] = await attachUsernames([updatedRows[0]]);
  res.json(withUser);
});

export default router;
