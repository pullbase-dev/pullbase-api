import { Router, type IRouter } from "express";
import { eq, desc, sql } from "drizzle-orm";
import {
  db,
  agentsTable,
  agentJobsTable,
  modelsTable,
  modelTagsTable,
} from "@pullbase/db";
import { RunAgentBody } from "@pullbase/api-zod";
import { openai } from "@pullbase/openai-server";
import { rateLimit } from "../lib/rate-limit";

const router: IRouter = Router();
const agentRunLimit = rateLimit({ windowMs: 60_000, max: 10, key: "agent-run" });

router.get("/agents", async (_req, res): Promise<void> => {
  const rows = await db.select().from(agentsTable).orderBy(desc(agentsTable.status), agentsTable.id);
  res.json({ items: rows });
});

router.get("/agents/:slug", async (req, res): Promise<void> => {
  const slug = String(req.params["slug"] ?? "");
  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.slug, slug));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }

  const recentJobs = await db.select().from(agentJobsTable)
    .where(eq(agentJobsTable.agentSlug, slug))
    .orderBy(desc(agentJobsTable.createdAt))
    .limit(10);

  const jobsWithLinks = await enrichJobs(recentJobs);

  res.json({ ...agent, recentJobs: jobsWithLinks });
});

router.get("/agents/:slug/jobs", async (req, res): Promise<void> => {
  const slug = String(req.params["slug"] ?? "");
  const [agent] = await db.select({ id: agentsTable.id }).from(agentsTable).where(eq(agentsTable.slug, slug));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  const rows = await db.select().from(agentJobsTable)
    .where(eq(agentJobsTable.agentSlug, slug))
    .orderBy(desc(agentJobsTable.createdAt))
    .limit(30);
  res.json({ items: await enrichJobs(rows) });
});

router.post("/agents/:slug/run", agentRunLimit, async (req, res): Promise<void> => {
  const slug = String(req.params["slug"] ?? "");
  const parsed = RunAgentBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }

  const [agent] = await db.select().from(agentsTable).where(eq(agentsTable.slug, slug));
  if (!agent) { res.status(404).json({ error: "Agent not found" }); return; }
  if (agent.status === "soon") {
    res.status(422).json({ error: `${agent.name} is not live yet — join the waitlist to get notified.` });
    return;
  }

  const [job] = await db.insert(agentJobsTable).values({
    agentSlug: slug,
    requesterAddress: parsed.data.requesterAddress,
    prompt: parsed.data.prompt,
    targetModelId: parsed.data.targetModelId ?? null,
  }).returning();

  try {
    let result: { output: string; resultModelId: number | null };
    switch (agent.capability) {
      case "autobuild":
        result = await runAutoBuilder(parsed.data.requesterAddress, parsed.data.prompt);
        break;
      case "repocard":
        result = await runRepoAgent(parsed.data.targetModelId);
        break;
      case "ask":
        result = await runAskAgent(parsed.data.targetModelId, parsed.data.prompt);
        break;
      default:
        throw new Error("Capability not yet executable on the server");
    }

    const [updated] = await db.update(agentJobsTable).set({
      status: "done",
      output: result.output,
      resultModelId: result.resultModelId,
      completedAt: new Date(),
    }).where(eq(agentJobsTable.id, job.id)).returning();

    await db.update(agentsTable).set({
      jobCount: sql`${agentsTable.jobCount} + 1`,
      modelCount: result.resultModelId
        ? sql`${agentsTable.modelCount} + 1`
        : agentsTable.modelCount,
    }).where(eq(agentsTable.slug, slug));

    res.json((await enrichJobs([updated]))[0]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const [updated] = await db.update(agentJobsTable).set({
      status: "failed",
      errorMessage: message,
      completedAt: new Date(),
    }).where(eq(agentJobsTable.id, job.id)).returning();
    await db.update(agentsTable).set({ jobCount: sql`${agentsTable.jobCount} + 1` })
      .where(eq(agentsTable.slug, slug));
    res.status(200).json((await enrichJobs([updated]))[0]);
  }
});

async function enrichJobs(jobs: Array<typeof agentJobsTable.$inferSelect>) {
  const resultIds = jobs.map((j) => j.resultModelId).filter((id): id is number => id !== null);
  if (resultIds.length === 0) {
    return jobs.map((j) => ({ ...j, resultModelSlug: null, resultModelName: null }));
  }
  const models = await db.select({ id: modelsTable.id, slug: modelsTable.slug, name: modelsTable.name })
    .from(modelsTable)
    .where(sql`${modelsTable.id} = ANY(ARRAY[${sql.join(resultIds.map((id) => sql`${id}`), sql`, `)}]::int[])`);
  const map = new Map(models.map((m) => [m.id, m]));
  return jobs.map((j) => ({
    ...j,
    resultModelSlug: j.resultModelId ? map.get(j.resultModelId)?.slug ?? null : null,
    resultModelName: j.resultModelId ? map.get(j.resultModelId)?.name ?? null : null,
  }));
}

async function runAutoBuilder(agentWallet: string, prompt: string) {
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano",
    max_completion_tokens: 16000,
    messages: [
      {
        role: "system",
        content:
          'You are AutoBuilder, an autonomous AI agent that designs and publishes AI models on PullBase. Given a user prompt describing what they want, design a NEW model and return STRICT JSON only with this shape: {"name":"kebab-case-model-name (max 40 chars, lowercase, hyphens)","description":"1-sentence summary","task":"one of: NLP, Vision, Audio, Multimodal, Tabular, RL","framework":"one of: PyTorch, TensorFlow, JAX, ONNX","license":"one of: MIT, Apache-2.0, CC-BY-4.0, GPL-3.0","parameterCount":"e.g. 7B, 340M, 1.5B","language":"e.g. en, id, multilingual","tags":["6-10 lowercase","kebab-case","tags"],"readme":"Concise markdown README (300-500 words) with ## Overview, ## Intended Use, ## Training Data, ## Limitations, ## How to Use (with a code snippet)","reasoning":"2-3 sentences explaining the design choice"}. Be concise. Output JSON object only.',
      },
      { role: "user", content: prompt },
    ],
    response_format: { type: "json_object" },
  });
  const raw = completion.choices[0]?.message?.content?.trim();
  const finishReason = completion.choices[0]?.finish_reason;
  if (!raw) {
    throw new Error(`AutoBuilder produced no output (finish_reason=${finishReason}). Try a shorter or more specific prompt.`);
  }
  const parsed = JSON.parse(raw) as {
    name: string; description: string; task: string; framework: string;
    license: string; parameterCount?: string; language?: string;
    tags?: string[]; readme: string; reasoning: string;
  };

  const baseSlug = parsed.name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "agent-model";
  let slug = baseSlug;
  let attempt = 0;
  while (true) {
    const dup = await db.select({ id: modelsTable.id }).from(modelsTable)
      .where(eq(modelsTable.slug, slug)).limit(1);
    if (dup.length === 0) break;
    attempt++;
    slug = `${baseSlug}-${attempt}`;
    if (attempt > 99) throw new Error("Could not allocate unique slug");
  }

  const [inserted] = await db.insert(modelsTable).values({
    name: parsed.name,
    slug,
    description: parsed.description,
    readme: parsed.readme,
    ownerAddress: agentWallet,
    task: parsed.task,
    framework: parsed.framework,
    license: parsed.license,
    parameterCount: parsed.parameterCount ?? null,
    language: parsed.language ?? null,
    isOnChain: false,
  }).returning();

  if (parsed.tags && parsed.tags.length > 0) {
    const cleanTags = parsed.tags.slice(0, 10).map((t) => t.toLowerCase().slice(0, 40));
    await db.insert(modelTagsTable).values(cleanTags.map((tag) => ({ modelId: inserted.id, tag })));
  }

  const output = `**Designed:** \`${parsed.name}\`\n\n${parsed.reasoning}\n\n→ Published as \`${slug}\` (${parsed.task} · ${parsed.framework} · ${parsed.license})`;
  return { output, resultModelId: inserted.id };
}

async function runRepoAgent(targetModelId: number | null | undefined) {
  if (!targetModelId) throw new Error("RepoAgent requires targetModelId");
  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, targetModelId));
  if (!model) throw new Error("Target model not found");

  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano",
    max_completion_tokens: 4000,
    messages: [
      {
        role: "system",
        content:
          "You are RepoAgent — you write professional, factual model cards for AI models. Output GitHub-flavored markdown only. Structure: ## Overview, ## Intended Use, ## Training Data, ## Limitations, ## How to Use (with a runnable code snippet for the listed framework).",
      },
      {
        role: "user",
        content: `Write a model card for:\nName: ${model.name}\nTask: ${model.task}\nFramework: ${model.framework}\nLicense: ${model.license}\nParameters: ${model.parameterCount ?? "unknown"}\nExisting description: ${model.description ?? "(none)"}`,
      },
    ],
  });
  const readme = completion.choices[0]?.message?.content?.trim();
  if (!readme) throw new Error("RepoAgent produced no output");
  return { output: readme, resultModelId: null };
}

async function runAskAgent(targetModelId: number | null | undefined, question: string) {
  if (!targetModelId) throw new Error("AskAgent requires targetModelId");
  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, targetModelId));
  if (!model) throw new Error("Target model not found");
  const context = `Model "${model.name}" — Task: ${model.task}, Framework: ${model.framework}, License: ${model.license}, Parameters: ${model.parameterCount ?? "?"}.\nDescription: ${model.description ?? "(none)"}\n${model.readme ? `\nREADME:\n${model.readme.slice(0, 2000)}` : ""}`;
  const completion = await openai.chat.completions.create({
    model: "gpt-5-nano",
    max_completion_tokens: 1024,
    messages: [
      { role: "system", content: "You answer questions about an AI model using only the provided model card. Be concise (2-4 sentences). If the answer isn't in the card, say so." },
      { role: "user", content: `${context}\n\nQuestion: ${question}` },
    ],
  });
  const answer = completion.choices[0]?.message?.content?.trim() ?? "(no answer)";
  return { output: answer, resultModelId: null };
}

export default router;
