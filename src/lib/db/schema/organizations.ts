import { pgTable, text, integer, serial, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const organizationsTable = pgTable("organizations", {
  id:          serial("id").primaryKey(),
  name:        text("name").notNull(),
  slug:        text("slug").notNull().unique(),
  description: text("description"),
  avatarUrl:   text("avatar_url"),
  createdAt:   timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt:   timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const orgMembersTable = pgTable("org_members", {
  id:            serial("id").primaryKey(),
  orgId:         integer("org_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  walletAddress: text("wallet_address").notNull(),
  role:          text("role").notNull().default("member"),
  createdAt:     timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOrgSchema = createInsertSchema(organizationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertOrg = z.infer<typeof insertOrgSchema>;
export type Organization = typeof organizationsTable.$inferSelect;
export type OrgMember = typeof orgMembersTable.$inferSelect;
