import {
  db,
  usersTable,
  agentsTable,
} from "@pullbase/db";
import { sql } from "drizzle-orm";

const AUTOBUILDER_SKILL = `# AutoBuilder Skill

## What I do
I turn a single plain-English prompt into a **published, browsable model entry on PullBase** — owned by your connected wallet.

When you run me, I:
1. Read your prompt as a design brief.
2. Call GPT to design a coherent model spec: name, task, framework, license, parameter count, recommended tags, and a starter README.
3. Insert a new row into the \`models\` table with \`ownerAddress\` = your wallet.
4. Insert tag rows into \`model_tags\`.
5. Link the resulting model ID to the agent job so you can jump straight to it.

## PullBase features I use
- **Models table** (\`POST /api/models\`) — creates the on-platform record.
- **Tags system** — auto-suggests 3–5 relevant tags.
- **Wallet-based ownership** — the requester's wallet address becomes the model owner.
- **OpenAI integration** (\`@pullbase/openai-server\`) for the design step.

## When to use me
- You have an idea ("a lightweight reranker for legal documents") and want a starting point on PullBase fast.
- You want a placeholder model entry that you can edit/fork later.
- You're prototyping and need a model card scaffold.

## When NOT to use me
- You want to upload an existing trained weights file — use \`/publish\` instead (it pins your file to IPFS).
- You want to fork an existing model — use \`/models/[id]\` → "Fork".
- You want to mint an on-chain ownership token — use the Mint button on the model page after publishing.

## Example prompts that work well
- "Design a small sentiment classifier for e-commerce product reviews, under 200M params, ONNX-ready."
- "A French legal-document summarizer based on a Mistral 7B fine-tune, Apache 2.0 license."
- "An image embedding model for fashion product similarity search."

## What you get back
- A direct link to the new \`/models/<id>\` page.
- A first-draft README that you can refine (or hand off to RepoAgent to rewrite).
- The job is logged under "Recent jobs" so you can replay or audit.

## Honest limitations
- I **do not** train weights or produce a runnable artifact — I produce the **metadata and spec**.
- I **do not** call any GPU service. The output is text + DB rows.
- The quality of the spec depends entirely on the quality of your prompt.
`;

const REPOAGENT_SKILL = `# RepoAgent Skill

## What I do
I read an existing model's metadata and write a **professional model card README** in markdown, following the structure HuggingFace and standards like Model Cards for Model Reporting recommend.

When you run me, I:
1. Fetch the target model from \`GET /api/models/:id\`.
2. Send its metadata (name, task, framework, license, tags, parameter count) to GPT with a model-card writing prompt.
3. Return a full markdown document covering: Overview, Intended Use, Training Data, Limitations, Bias considerations, How to Use (with code snippet), and License.

## PullBase features I use
- **Model metadata** (\`GET /api/models/:id\`) as input.
- **OpenAI integration** for the writing step.
- The output is **plain markdown** — you paste it into the model's README via the edit form on the model page.

## When to use me
- You published a model via AutoBuilder or \`/publish\` and want a polished README.
- You forked a model and want a fresh card written from the new fork's perspective.
- You want a standardised structure (Overview / Intended Use / Limitations / How to Use) without writing it by hand.

## When NOT to use me
- You want to ask a question about the model → use AskAgent.
- You want to create a new model from scratch → use AutoBuilder.

## What you get back
- A markdown document, copy-pasteable into the model's README field.
- I **do not** auto-write to the model — you stay in control of the edit.

## Honest limitations
- I write from metadata only. I cannot read the actual weights, run benchmarks, or invent training details that aren't already in the metadata.
- If the input metadata is sparse, the README will be generic. The richer the metadata, the better the card.
`;

const ASKAGENT_SKILL = `# AskAgent Skill

## What I do
I answer free-form questions about any model on PullBase, **strictly** from that model's published README and metadata. I do not invent or hallucinate facts that aren't in the source material.

When you run me, I:
1. Fetch the target model from \`GET /api/models/:id\` (name, description, README, tags, framework, license).
2. Construct a system prompt that constrains GPT to answer only from this material.
3. Return a direct answer plus a citation pointer to the relevant section of the README when possible.

## PullBase features I use
- **Model README + metadata** as the only knowledge source.
- **OpenAI integration** for the answering step.
- I'm also embedded as the **"Ask about this model"** widget on every \`/models/[id]\` page — same engine, same constraints.

## When to use me
- "How many parameters does this model have?"
- "What license is this released under?"
- "What's the recommended way to fine-tune it?"
- "Can I use this commercially?"

## When NOT to use me
- For general ML questions not specific to a PullBase model → ask ChatGPT/Claude directly.
- To design a new model → use AutoBuilder.
- To generate a model card → use RepoAgent.

## What you get back
- A short, factual answer.
- If the README does not contain the answer, I say so honestly rather than guess.

## Honest limitations
- I am **only as good as the model's README**. A blank README means I can't answer most questions.
- I do not have access to the actual model weights, benchmarks the author didn't publish, or anything outside what's stored in PullBase.
- I do not browse the web. Everything I cite comes from the model's row in our database.
`;

async function seed() {
  console.log("Seeding database...");

  // ── Agents ─────────────────────────────────────────────
  // The only seeded data is the autonomous AI agents. Each agent owns its
  // own wallet (user record) so it can publish, fork, and hold models.
  // No fake humans, fake orgs, fake models, or fake datasets are seeded —
  // those are created by real users (and by agents like AutoBuilder).
  const agentUsers = [
    { walletAddress: "0xa6e7000000000000000000000000000000000001", username: "autobuilder", displayName: "AutoBuilder", bio: "Autonomous AI agent that designs and ships new models from a single prompt." },
    { walletAddress: "0xa6e7000000000000000000000000000000000003", username: "repoagent",   displayName: "RepoAgent",   bio: "Writes professional model cards so you don't have to." },
    { walletAddress: "0xa6e7000000000000000000000000000000000006", username: "askagent",    displayName: "AskAgent",    bio: "Conversational interface for every model on PullBase." },
  ];
  await db.insert(usersTable).values(agentUsers).onConflictDoNothing();

  await db.insert(agentsTable).values([
    {
      slug: "autobuilder", name: "AutoBuilder",
      tagline: "From a prompt to a published model — autonomously.",
      description: "Give AutoBuilder a goal in plain language. It designs a model spec, writes the model card, picks a license, generates tags, and publishes the repo under your connected wallet.",
      walletAddress: agentUsers[0]!.walletAddress, capability: "autobuild", status: "live",
      skillMd: AUTOBUILDER_SKILL,
    },
    {
      slug: "repoagent", name: "RepoAgent",
      tagline: "Writes the README so you don't have to.",
      description: "Reads a model's metadata, generates a complete model card with overview, intended use, training data, limitations, and runnable code examples.",
      walletAddress: agentUsers[1]!.walletAddress, capability: "repocard", status: "live",
      skillMd: REPOAGENT_SKILL,
    },
    {
      slug: "askagent", name: "AskAgent",
      tagline: "Conversational Q&A for any model on PullBase.",
      description: "Already live on every model page — answers any question about a model's capabilities, training data, and how to use it, strictly from the model card.",
      walletAddress: agentUsers[2]!.walletAddress, capability: "ask", status: "live",
      skillMd: ASKAGENT_SKILL,
    },
  ]).onConflictDoNothing();

  // ── Ensure existing rows pick up the new skill_md content ───────────────
  // Safe: only writes if the existing skill is empty (so manual edits stick).
  await db.execute(sql`
    UPDATE agents SET skill_md = ${AUTOBUILDER_SKILL}
      WHERE slug = 'autobuilder' AND coalesce(skill_md, '') = '';
  `);
  await db.execute(sql`
    UPDATE agents SET skill_md = ${REPOAGENT_SKILL}
      WHERE slug = 'repoagent' AND coalesce(skill_md, '') = '';
  `);
  await db.execute(sql`
    UPDATE agents SET skill_md = ${ASKAGENT_SKILL}
      WHERE slug = 'askagent' AND coalesce(skill_md, '') = '';
  `);

  console.log("Seed complete.");
  process.exit(0);
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});
