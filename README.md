<h1>PullBase API</h1>
<p>
  <a href="https://pullbase.net"><img src="https://img.shields.io/badge/Live-pullbase.net-6366f1?style=flat-square" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green?style=flat-square" /></a>
  <img src="https://img.shields.io/badge/Express-5-000000?style=flat-square&logo=express" />
  <img src="https://img.shields.io/badge/PostgreSQL-Drizzle-4169E1?style=flat-square&logo=postgresql" />
  <img src="https://img.shields.io/badge/IPFS-Pinata-65C2CB?style=flat-square" />
</p>

REST API server powering [PullBase](https://pullbase.net) — the decentralized AI model hub.

## Stack

- **Framework**: Express 5 (TypeScript)
- **Database**: PostgreSQL + Drizzle ORM
- **IPFS**: Pinata pinning service
- **AI**: OpenAI (model card generation, AI agents)
- **Build**: esbuild (single-file bundle, ESM)

## Getting Started

```bash
git clone https://github.com/pullbase-dev/pullbase-api.git
cd pullbase-api
npm install
cp .env.example .env
# fill in DATABASE_URL, PINATA_JWT, OPENAI_API_KEY
npm run build
npm start
# or for development (auto-restart):
npm run build && node --watch dist/index.mjs
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `PORT` | Yes | HTTP listen port |
| `DATABASE_URL` | Yes | PostgreSQL connection string |
| `PINATA_JWT` | Yes | Pinata JWT for IPFS pinning |
| `OPENAI_API_KEY` | Yes | OpenAI API key (agents + model cards) |
| `OPENAI_BASE_URL` | Optional | Custom OpenAI base URL (e.g. Azure, local) |

## API Overview

Base URL: `/api` · All responses JSON · No auth for read endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/models` | List models (search, task, framework, sort, page) |
| GET | `/api/models/:id` | Model detail + README + IPFS CID |
| POST | `/api/models` | Create a model record |
| POST | `/api/models/pin` | Pin model metadata to IPFS via Pinata |
| PATCH | `/api/models/:id/onchain` | Save on-chain data after minting |
| GET | `/api/datasets` | List datasets |
| GET | `/api/agents` | List AI agents |
| POST | `/api/agents/:slug/run` | Run an AI agent job |
| GET | `/api/search?q=` | Global search |
| GET | `/api/stats/platform` | Platform statistics |
| GET | `/api/health` | Health check |

Full OpenAPI spec is in `src/lib/api-zod/` (generated from `openapi.yaml`).

## Database

Drizzle ORM with PostgreSQL. Schema is in `src/lib/db/schema/`.

```bash
# Push schema to database (dev)
npx tsx -e "import { drizzle } from 'drizzle-orm/node-postgres'; /* push */"
# or use drizzle-kit push
```

## Seed Data

```bash
npm run seed
```

Populates agents (AutoBuilder, RepoAgent, AskAgent), sample models, and tags.

## Building

```bash
npm run build   # → dist/index.mjs (single esbuild bundle)
npm start       # runs dist/index.mjs
```

## License

MIT © [PullBase](https://pullbase.net)
