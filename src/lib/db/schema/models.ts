import { pgTable, text, integer, serial, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { organizationsTable } from "./organizations";

export const modelsTable = pgTable("models", {
  id:             serial("id").primaryKey(),
  name:           text("name").notNull(),
  slug:           text("slug").notNull(),
  description:    text("description"),
  readme:         text("readme"),
  ownerAddress:   text("owner_address").notNull().references(() => usersTable.walletAddress),
  orgId:          integer("org_id").references(() => organizationsTable.id),
  task:           text("task").notNull(),
  framework:      text("framework").notNull(),
  license:        text("license").notNull(),
  parameterCount: text("parameter_count"),
  language:       text("language"),
  downloadCount:  integer("download_count").notNull().default(0),
  starCount:      integer("star_count").notNull().default(0),
  isOnChain:      boolean("is_on_chain").notNull().default(false),
  ipfsCid:        text("ipfs_cid"),
  txHash:         text("tx_hash"),
  tokenId:        integer("token_id"),
  chainId:        integer("chain_id"),
  forkedFromId:   integer("forked_from_id"),
  forkCount:      integer("fork_count").notNull().default(0),
  visibility:     text("visibility").notNull().default("public"),
  sourceUrl:      text("source_url"),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:      timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const modelTagsTable = pgTable("model_tags", {
  id:      serial("id").primaryKey(),
  modelId: integer("model_id").notNull().references(() => modelsTable.id, { onDelete: "cascade" }),
  tag:     text("tag").notNull(),
});

export const modelStarsTable = pgTable("model_stars", {
  id:            serial("id").primaryKey(),
  modelId:       integer("model_id").notNull().references(() => modelsTable.id, { onDelete: "cascade" }),
  walletAddress: text("wallet_address").notNull(),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertModelSchema = createInsertSchema(modelsTable).omit({ id: true, downloadCount: true, starCount: true, createdAt: true, updatedAt: true });
export type InsertModel = z.infer<typeof insertModelSchema>;
export type Model = typeof modelsTable.$inferSelect;
export type ModelTag = typeof modelTagsTable.$inferSelect;
export type ModelStar = typeof modelStarsTable.$inferSelect;
