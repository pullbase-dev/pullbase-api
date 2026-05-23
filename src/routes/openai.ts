import { Router, type IRouter } from "express";
import { db } from "@pullbase/db";
import {
  conversations,
  messages,
  modelsTable,
} from "@pullbase/db";
import { eq, desc, sql } from "drizzle-orm";
import {
  CreateOpenaiConversationBody,
  SendOpenaiMessageBody,
  GenerateOpenaiImageBody,
  AiRecommendBody,
  AiInferenceBody,
  AiGenerateModelCardBody,
  AiAskAboutModelBody,
} from "@pullbase/api-zod";
import { openai } from "@pullbase/openai-server";
import { generateImageBuffer } from "@pullbase/openai-server/image";
import { rateLimit } from "../lib/rate-limit";

const router: IRouter = Router();

const aiTextLimit = rateLimit({ windowMs: 60_000, max: 20, key: "ai-text" });
const aiImageLimit = rateLimit({ windowMs: 60_000, max: 5, key: "ai-image" });

router.get("/openai/conversations", async (_req, res) => {
  const rows = await db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.createdAt))
    .limit(50);
  res.json(rows);
});

router.post("/openai/conversations", async (req, res) => {
  const parsed = CreateOpenaiConversationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const [row] = await db
    .insert(conversations)
    .values({ title: parsed.data.title })
    .returning();
  res.status(201).json(row);
});

router.get("/openai/conversations/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const msgs = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);
  res.json({ ...conv, messages: msgs });
});

router.delete("/openai/conversations/:id", async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.post("/openai/conversations/:id/messages", aiTextLimit, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = SendOpenaiMessageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const [conv] = await db
    .select()
    .from(conversations)
    .where(eq(conversations.id, id));
  if (!conv) {
    res.status(404).json({ error: "Conversation not found" });
    return;
  }

  await db.insert(messages).values({
    conversationId: id,
    role: "user",
    content: parsed.data.content,
  });

  const history = await db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, id))
    .orderBy(messages.createdAt);

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let full = "";
  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-5-nano",
      max_completion_tokens: 8192,
      messages: [
        {
          role: "system",
          content:
            "You are PullBase AI, an assistant for an open-source decentralized AI model hub (like Hugging Face + IPFS). Help users find and understand AI modelsTable, datasets, and ML concepts. Be concise.",
        },
        ...history.map((m) => ({
          role: m.role as "user" | "assistant" | "system",
          content: m.content,
        })),
      ],
      stream: true,
    });

    for await (const chunk of stream) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) {
        full += content;
        res.write(`data: ${JSON.stringify({ content })}\n\n`);
      }
    }

    await db.insert(messages).values({
      conversationId: id,
      role: "assistant",
      content: full,
    });

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
    res.end();
  } catch (err) {
    const msg = err instanceof Error ? err.message : "AI error";
    res.write(`data: ${JSON.stringify({ error: msg })}\n\n`);
    res.end();
  }
});

router.post("/openai/generate-image", aiImageLimit, async (req, res) => {
  const parsed = GenerateOpenaiImageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  try {
    const size = (parsed.data.size ?? "1024x1024") as
      | "1024x1024"
      | "1536x1024"
      | "1024x1536";
    const buffer = await generateImageBuffer(
      parsed.data.prompt,
      size as "1024x1024",
    );
    res.json({ b64_json: buffer.toString("base64") });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Image generation error";
    res.status(500).json({ error: msg });
  }
});

router.post("/ai/recommend", aiTextLimit, async (req, res) => {
  const parsed = AiRecommendBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const allModels = await db
    .select({
      id: modelsTable.id,
      name: modelsTable.name,
      task: modelsTable.task,
      framework: modelsTable.framework,
      description: modelsTable.description,
      downloadCount: modelsTable.downloadCount,
    })
    .from(modelsTable)
    .orderBy(desc(modelsTable.downloadCount))
    .limit(30);

  if (allModels.length === 0) {
    res.json({ items: [], summary: "No modelsTable in catalog yet." });
    return;
  }

  const catalog = allModels
    .map(
      (m) =>
        `[${m.id}] ${m.name} | task=${m.task ?? "?"} | fw=${m.framework ?? "?"} | ${(m.description ?? "").slice(0, 120)}`,
    )
    .join("\n");

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-nano",
      max_completion_tokens: 4096,
      messages: [
        {
          role: "system",
          content:
            'You are a model recommendation engine. Given a user query and a catalog of AI modelsTable, return STRICT JSON: {"items":[{"id":number,"score":0..1,"reason":"short why"}],"summary":"1-2 sentences"}. Pick up to 5 best matches. Only use ids from the catalog. No markdown, JSON only.',
        },
        {
          role: "user",
          content: `Query: ${parsed.data.query}\n\nCatalog:\n${catalog}`,
        },
      ],
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsedJson = JSON.parse(raw) as {
      items?: Array<{ id: number; score: number; reason: string }>;
      summary?: string;
    };

    const items = (parsedJson.items ?? [])
      .map((r) => {
        const m = allModels.find((x) => x.id === r.id);
        if (!m) return null;
        return {
          id: m.id,
          name: m.name,
          task: m.task,
          framework: m.framework,
          description: m.description,
          score: r.score,
          reason: r.reason,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    res.json({
      items,
      summary: parsedJson.summary ?? "Top matches based on your query.",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Recommendation error";
    res.status(500).json({ error: msg });
  }
});

router.post("/ai/generate-model-card", aiTextLimit, async (req, res) => {
  const parsed = AiGenerateModelCardBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const { name, task, framework, parameterCount } = parsed.data;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-nano",
      max_completion_tokens: 8000,
      messages: [
        {
          role: "system",
          content:
            'You are an expert ML engineer writing model cards for a HuggingFace-style hub. Given model metadata, generate professional, factual content. Return STRICT JSON only with this shape: {"description":"1-2 sentence summary","readme":"markdown with ## Overview, ## Intended Use, ## Limitations, ## Training Data, ## How to Use sections (include a code snippet)","tags":["6-10","lowercase","tags"],"useCases":["3-5 short use cases"]}. Output JSON object only.',
        },
        {
          role: "user",
          content: `Generate a model card for:\nName: ${name}\nTask: ${task}\nFramework: ${framework}${parameterCount ? `\nParameters: ${parameterCount}` : ""}`,
        },
      ],
      response_format: { type: "json_object" },
    });
    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) {
      res.status(502).json({ error: "AI returned empty response — try again" });
      return;
    }
    let out: { description?: string; readme?: string; tags?: string[]; useCases?: string[] };
    try {
      out = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (!match) {
        res.status(502).json({ error: "AI returned non-JSON response" });
        return;
      }
      out = JSON.parse(match[0]);
    }
    res.json({
      description: out.description ?? "",
      readme: out.readme ?? "",
      tags: Array.isArray(out.tags) ? out.tags.slice(0, 10) : [],
      useCases: Array.isArray(out.useCases) ? out.useCases.slice(0, 5) : [],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Generation error";
    res.status(500).json({ error: msg });
  }
});

router.post("/ai/models/:id/ask", aiTextLimit, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = AiAskAboutModelBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }
  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, id));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }
  const context = `Model card for "${model.name}":
- Task: ${model.task ?? "unknown"}
- Framework: ${model.framework ?? "unknown"}
- License: ${model.license ?? "unknown"}
- Parameters: ${model.parameterCount ?? "unknown"}
- Downloads: ${model.downloadCount ?? 0}
- Description: ${model.description ?? "(none)"}
${model.readme ? `\nREADME:\n${model.readme.slice(0, 2000)}` : ""}`;
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-nano",
      max_completion_tokens: 1024,
      messages: [
        {
          role: "system",
          content:
            "You are a helpful assistant answering questions about a specific AI model. Use ONLY the provided model card context. If the answer isn't in the context, say you don't have that info from the model card. Be concise and direct (2-4 sentences).",
        },
        { role: "user", content: `${context}\n\nQuestion: ${parsed.data.question}` },
      ],
    });
    const answer = completion.choices[0]?.message?.content ?? "(no answer)";
    res.json({ answer });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Ask error";
    res.status(500).json({ error: msg });
  }
});

router.post("/ai/models/:id/inference", aiTextLimit, async (req, res) => {
  const id = Number(req.params["id"]);
  if (!Number.isFinite(id)) {
    res.status(400).json({ error: "Invalid id" });
    return;
  }
  const parsed = AiInferenceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid input" });
    return;
  }

  const [model] = await db.select().from(modelsTable).where(eq(modelsTable.id, id));
  if (!model) {
    res.status(404).json({ error: "Model not found" });
    return;
  }

  const task = model.task ?? "general";
  const systemPrompt = `You are simulating the AI model "${model.name}" (task: ${task}, framework: ${model.framework ?? "unknown"}).
Respond AS IF you are that model's output. ${
    task === "NLP" || task.toLowerCase().includes("nlp")
      ? "Generate realistic text output."
      : task === "Vision" || task.toLowerCase().includes("vision")
        ? "Describe what the model would detect/classify, as labels with confidence scores."
        : task === "Audio" || task.toLowerCase().includes("audio")
          ? "Output a transcript or audio analysis."
          : "Produce a plausible output for this task."
  }
Be concise (under 200 words). Do NOT explain that you're a simulation — just produce the output.`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5-nano",
      max_completion_tokens: 1024,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: parsed.data.prompt },
      ],
    });

    const output = completion.choices[0]?.message?.content ?? "(no output)";

    await db
      .update(modelsTable)
      .set({ downloadCount: sql`${modelsTable.downloadCount} + 1` })
      .where(eq(modelsTable.id, id));

    res.json({ output, modelName: model.name, task });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Inference error";
    res.status(500).json({ error: msg });
  }
});

export default router;
