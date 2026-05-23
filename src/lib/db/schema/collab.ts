import { pgTable, text, integer, serial, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { modelsTable } from "./models";
import { usersTable } from "./users";

export const modelVersionsTable = pgTable("model_versions", {
  id:         serial("id").primaryKey(),
  modelId:    integer("model_id").notNull().references(() => modelsTable.id, { onDelete: "cascade" }),
  version:    text("version").notNull(),
  changelog:  text("changelog"),
  ipfsCid:    text("ipfs_cid"),
  txHash:     text("tx_hash"),
  tokenId:    integer("token_id"),
  chainId:    integer("chain_id"),
  sizeBytes:  integer("size_bytes"),
  authorAddress: text("author_address").notNull().references(() => usersTable.walletAddress),
  createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const discussionsTable = pgTable("discussions", {
  id:            serial("id").primaryKey(),
  modelId:       integer("model_id").notNull().references(() => modelsTable.id, { onDelete: "cascade" }),
  authorAddress: text("author_address").notNull().references(() => usersTable.walletAddress),
  title:         text("title").notNull(),
  body:          text("body").notNull(),
  isClosed:      boolean("is_closed").notNull().default(false),
  commentCount:  integer("comment_count").notNull().default(0),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:     timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const discussionCommentsTable = pgTable("discussion_comments", {
  id:            serial("id").primaryKey(),
  discussionId:  integer("discussion_id").notNull().references(() => discussionsTable.id, { onDelete: "cascade" }),
  authorAddress: text("author_address").notNull().references(() => usersTable.walletAddress),
  body:          text("body").notNull(),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pullRequestsTable = pgTable("pull_requests", {
  id:                 serial("id").primaryKey(),
  modelId:            integer("model_id").notNull().references(() => modelsTable.id, { onDelete: "cascade" }),
  authorAddress:      text("author_address").notNull().references(() => usersTable.walletAddress),
  title:              text("title").notNull(),
  body:               text("body"),
  status:             text("status").notNull().default("open"),
  proposedReadme:     text("proposed_readme"),
  proposedDescription: text("proposed_description"),
  commentCount:       integer("comment_count").notNull().default(0),
  mergedAt:           timestamp("merged_at", { withTimezone: true }),
  mergedBy:           text("merged_by"),
  createdAt:          timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:          timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const prCommentsTable = pgTable("pr_comments", {
  id:            serial("id").primaryKey(),
  prId:          integer("pr_id").notNull().references(() => pullRequestsTable.id, { onDelete: "cascade" }),
  authorAddress: text("author_address").notNull().references(() => usersTable.walletAddress),
  body:          text("body").notNull(),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertModelVersionSchema = createInsertSchema(modelVersionsTable).omit({ id: true, createdAt: true });
export const insertDiscussionSchema = createInsertSchema(discussionsTable).omit({ id: true, createdAt: true, updatedAt: true, commentCount: true, isClosed: true });
export const insertDiscussionCommentSchema = createInsertSchema(discussionCommentsTable).omit({ id: true, createdAt: true });
export const insertPullRequestSchema = createInsertSchema(pullRequestsTable).omit({ id: true, createdAt: true, updatedAt: true, commentCount: true, status: true, mergedAt: true, mergedBy: true });
export const insertPrCommentSchema = createInsertSchema(prCommentsTable).omit({ id: true, createdAt: true });

export type ModelVersion = typeof modelVersionsTable.$inferSelect;
export type Discussion = typeof discussionsTable.$inferSelect;
export type DiscussionComment = typeof discussionCommentsTable.$inferSelect;
export type PullRequest = typeof pullRequestsTable.$inferSelect;
export type PrComment = typeof prCommentsTable.$inferSelect;
export type InsertModelVersion = z.infer<typeof insertModelVersionSchema>;
export type InsertDiscussion = z.infer<typeof insertDiscussionSchema>;
export type InsertDiscussionComment = z.infer<typeof insertDiscussionCommentSchema>;
export type InsertPullRequest = z.infer<typeof insertPullRequestSchema>;
export type InsertPrComment = z.infer<typeof insertPrCommentSchema>;
