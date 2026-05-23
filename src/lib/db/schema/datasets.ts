import { pgTable, text, integer, serial, boolean, bigint, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { organizationsTable } from "./organizations";

export const datasetsTable = pgTable("datasets", {
  id:            serial("id").primaryKey(),
  name:          text("name").notNull(),
  slug:          text("slug").notNull(),
  description:   text("description"),
  readme:        text("readme"),
  ownerAddress:  text("owner_address").notNull().references(() => usersTable.walletAddress),
  orgId:         integer("org_id").references(() => organizationsTable.id),
  task:          text("task").notNull(),
  format:        text("format").notNull(),
  license:       text("license").notNull(),
  language:      text("language"),
  sizeBytes:     bigint("size_bytes", { mode: "number" }),
  rowCount:      integer("row_count"),
  downloadCount: integer("download_count").notNull().default(0),
  starCount:     integer("star_count").notNull().default(0),
  isOnChain:     boolean("is_on_chain").notNull().default(false),
  ipfsCid:       text("ipfs_cid"),
  txHash:        text("tx_hash"),
  tokenId:       integer("token_id"),
  chainId:       integer("chain_id"),
  visibility:    text("visibility").notNull().default("public"),
  sourceUrl:     text("source_url"),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const datasetTagsTable = pgTable("dataset_tags", {
  id:        serial("id").primaryKey(),
  datasetId: integer("dataset_id").notNull().references(() => datasetsTable.id, { onDelete: "cascade" }),
  tag:       text("tag").notNull(),
});

export const datasetStarsTable = pgTable("dataset_stars", {
  id:            serial("id").primaryKey(),
  datasetId:     integer("dataset_id").notNull().references(() => datasetsTable.id, { onDelete: "cascade" }),
  walletAddress: text("wallet_address").notNull(),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertDatasetSchema = createInsertSchema(datasetsTable).omit({ id: true, downloadCount: true, starCount: true, createdAt: true, updatedAt: true });
export type InsertDataset = z.infer<typeof insertDatasetSchema>;
export type Dataset = typeof datasetsTable.$inferSelect;
export type DatasetTag = typeof datasetTagsTable.$inferSelect;
export type DatasetStar = typeof datasetStarsTable.$inferSelect;
