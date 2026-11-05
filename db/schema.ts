import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  title: text("title").notNull(),
  date: text("event_date").notNull(),
  allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
  start: text("start_time"),
  end: text("end_time"),
  category: text("category", { enum: ["work", "personal", "team"] }).notNull().default("personal"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
}, (table) => [index("events_user_date_idx").on(table.userId, table.date), index("events_user_title_idx").on(table.userId, table.title)]);
