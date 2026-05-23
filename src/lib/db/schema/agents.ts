import { pgTable, text, integer, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { usersTable } from "./users";
import { modelsTable } from "./models";

export const agentsTable = pgTable("agents", {
  id:             serial("id").primaryKey(),
  slug:           text("slug").notNull().unique(),
  name:           text("name").notNull(),
  tagline:        text("tagline").notNull(),
  description:    text("description").notNull(),
  walletAddress:  text("wallet_address").notNull().references(() => usersTable.walletAddress),
  capability:     text("capability").notNull(),
  status:         text("status").notNull().default("soon"),
  avatarUrl:      text("avatar_url"),
  skillMd:        text("skill_md").notNull().default(""),
  jobCount:       integer("job_count").notNull().default(0),
  modelCount:     integer("model_count").notNull().default(0),
  createdAt:      timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const agentJobsTable = pgTable("agent_jobs", {
  id:                serial("id").primaryKey(),
  agentSlug:         text("agent_slug").notNull().references(() => agentsTable.slug, { onDelete: "cascade" }),
  requesterAddress:  text("requester_address").notNull(),
  prompt:            text("prompt").notNull(),
  targetModelId:     integer("target_model_id").references(() => modelsTable.id, { onDelete: "set null" }),
  status:            text("status").notNull().default("queued"),
  resultModelId:     integer("result_model_id").references(() => modelsTable.id, { onDelete: "set null" }),
  output:            text("output"),
  errorMessage:      text("error_message"),
  createdAt:         timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt:       timestamp("completed_at", { withTimezone: true }),
});

export const insertAgentSchema = createInsertSchema(agentsTable).omit({ id: true, createdAt: true, jobCount: true, modelCount: true });
export const insertAgentJobSchema = createInsertSchema(agentJobsTable).omit({ id: true, createdAt: true, completedAt: true, status: true, resultModelId: true, output: true, errorMessage: true });
export type Agent = typeof agentsTable.$inferSelect;
export type InsertAgent = z.infer<typeof insertAgentSchema>;
export type AgentJob = typeof agentJobsTable.$inferSelect;
export type InsertAgentJob = z.infer<typeof insertAgentJobSchema>;
