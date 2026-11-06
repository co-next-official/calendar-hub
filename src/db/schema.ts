import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  avatarUrl: text("avatar_url"),
  createdAt: text("created_at").notNull().default(now),
  lastLoginAt: text("last_login_at").notNull().default(now),
});

// The cookie carries a random token; only its SHA-256 is stored.
export const sessions = sqliteTable("sessions", {
  idHash: text("id_hash").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull().default(now),
  expiresAt: text("expires_at").notNull(),
}, (t) => [index("sessions_user_idx").on(t.userId)]);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  notes: text("notes").notNull().default(""),
  category: text("category", { enum: ["work", "personal", "team"] }).notNull().default("personal"),
  allDay: integer("all_day", { mode: "boolean" }).notNull(),
  // All-day: dates, end exclusive. Timed: UTC instants (ISO 8601, ms precision), end exclusive.
  startDate: text("start_date"),
  endDate: text("end_date"),
  startAt: text("start_at"),
  endAt: text("end_at"),
  timezone: text("timezone").notNull().default("Asia/Tokyo"),
  visibility: text("visibility", { enum: ["private", "participants", "group"] }).notNull().default("private"),
  busyOnly: integer("busy_only", { mode: "boolean" }).notNull().default(false),
  source: text("source", { enum: ["web", "api", "import"] }).notNull().default("web"),
  legacyId: text("legacy_id"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (t) => [
  index("events_owner_start_date_idx").on(t.ownerId, t.startDate),
  index("events_owner_start_at_idx").on(t.ownerId, t.startAt),
  uniqueIndex("events_owner_legacy_idx").on(t.ownerId, t.legacyId),
  check("events_title_len", sql`length(trim(${t.title})) between 1 and 120`),
  check("events_notes_len", sql`length(${t.notes}) <= 2000`),
  check("events_time_shape", sql`(
    ${t.allDay} = 1 and ${t.startDate} is not null and ${t.endDate} is not null and ${t.startDate} < ${t.endDate}
      and ${t.startAt} is null and ${t.endAt} is null
  ) or (
    ${t.allDay} = 0 and ${t.startAt} is not null and ${t.endAt} is not null and ${t.startAt} < ${t.endAt}
      and ${t.startDate} is null and ${t.endDate} is null
  )`),
]);

export type User = typeof users.$inferSelect;
export type EventRow = typeof events.$inferSelect;
