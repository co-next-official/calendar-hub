import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  googleSub: text("google_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull().default(""),
  avatarUrl: text("avatar_url"),
  reminderDefaultMinutes: integer("reminder_default_minutes"), // nullable; null = no default reminder
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
  // Set when visibility = 'group'. No FK so the events table needs no rebuild; a deleted group simply matches nobody.
  groupId: text("group_id"),
  source: text("source", { enum: ["web", "api", "import", "google"] }).notNull().default("web"),
  // For events mirrored from Google Calendar: the connection and Google's event (instance) id.
  connectionId: text("connection_id"),
  externalId: text("external_id"),
  legacyId: text("legacy_id"),
  version: integer("version").notNull().default(1),
  createdAt: text("created_at").notNull().default(now),
  updatedAt: text("updated_at").notNull().default(now),
}, (t) => [
  index("events_owner_start_date_idx").on(t.ownerId, t.startDate),
  index("events_owner_start_at_idx").on(t.ownerId, t.startAt),
  uniqueIndex("events_owner_legacy_idx").on(t.ownerId, t.legacyId),
  uniqueIndex("events_connection_external_idx").on(t.connectionId, t.externalId),
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

// API keys for AI / scripts. Only the SHA-256 of the key is stored.
export const apiTokens = sqliteTable("api_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  scopes: text("scopes", { enum: ["read", "read,write"] }).notNull().default("read"),
  createdAt: text("created_at").notNull().default(now),
  lastUsedAt: text("last_used_at"),
  expiresAt: text("expires_at"),
  revokedAt: text("revoked_at"),
}, (t) => [index("api_tokens_user_idx").on(t.userId)]);

// Every request made with an API key, so the owner can see what an AI did.
export const apiAudit = sqliteTable("api_audit", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenId: text("token_id").notNull(),
  method: text("method").notNull(),
  path: text("path").notNull(),
  status: integer("status").notNull(),
  createdAt: text("created_at").notNull().default(now),
}, (t) => [index("api_audit_user_idx").on(t.userId, t.createdAt)]);

export const groups = sqliteTable("groups", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull().default(now),
}, (t) => [check("groups_name_len", sql`length(trim(${t.name})) between 1 and 60`)]);

// Members are invited by email and must accept before they count (their busy time becomes visible to the group).
export const groupMembers = sqliteTable("group_members", {
  id: text("id").primaryKey(),
  groupId: text("group_id").notNull().references(() => groups.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  role: text("role", { enum: ["owner", "member"] }).notNull().default("member"),
  status: text("status", { enum: ["invited", "active"] }).notNull().default("invited"),
  invitedBy: text("invited_by"),
  createdAt: text("created_at").notNull().default(now),
}, (t) => [
  uniqueIndex("group_members_group_email_idx").on(t.groupId, t.email),
  index("group_members_email_idx").on(t.email),
  index("group_members_user_idx").on(t.userId),
]);

// People an event is shared with (visibility = 'participants'), and guests who answered through a link.
export const eventParticipants = sqliteTable("event_participants", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  email: text("email"),
  guestName: text("guest_name"),
  // Random key kept in the guest's browser so they can change their answer.
  guestKeyHash: text("guest_key_hash"),
  inviteId: text("invite_id"),
  response: text("response", { enum: ["pending", "yes", "no", "maybe"] }).notNull().default("pending"),
  createdAt: text("created_at").notNull().default(now),
  respondedAt: text("responded_at"),
}, (t) => [
  uniqueIndex("event_participants_event_email_idx").on(t.eventId, t.email),
  uniqueIndex("event_participants_guest_idx").on(t.eventId, t.guestKeyHash),
  index("event_participants_email_idx").on(t.email),
  check("event_participants_who", sql`(${t.email} is not null) or (${t.guestName} is not null and ${t.guestKeyHash} is not null)`),
]);

// Expiring guest links. Only the hash of the link token is stored.
export const eventInvites = sqliteTable("event_invites", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull().default(now),
  expiresAt: text("expires_at").notNull(),
  revokedAt: text("revoked_at"),
}, (t) => [index("event_invites_event_idx").on(t.eventId)]);

// Read-only Google Calendar connection. OAuth tokens are AES-GCM encrypted with GOOGLE_TOKEN_KEY.
export const googleConnections = sqliteTable("google_connections", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  calendarId: text("calendar_id").notNull().default("primary"),
  googleEmail: text("google_email"),
  refreshTokenEnc: text("refresh_token_enc").notNull(),
  accessTokenEnc: text("access_token_enc"),
  accessExpiresAt: text("access_expires_at"),
  syncToken: text("sync_token"),
  lastSyncedAt: text("last_synced_at"),
  lastError: text("last_error"),
  createdAt: text("created_at").notNull().default(now),
}, (t) => [uniqueIndex("google_connections_user_calendar_idx").on(t.userId, t.calendarId)]);

// Secret iCalendar subscription URL (calendar apps cannot send auth headers). One active feed per user.
export const calendarFeeds = sqliteTable("calendar_feeds", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: text("created_at").notNull().default(now),
  lastFetchedAt: text("last_fetched_at"),
  revokedAt: text("revoked_at"),
}, (t) => [index("calendar_feeds_user_idx").on(t.userId)]);

// Per-event reminder override. No row = use the user's default; a row with
// minutesBefore = null explicitly disables the reminder for that event.
export const eventReminders = sqliteTable("event_reminders", {
  id: text("id").primaryKey(),
  eventId: text("event_id").notNull().references(() => events.id, { onDelete: "cascade" }),
  minutesBefore: integer("minutes_before"),
  // ISO timestamp when the reminder push was sent (dedup).
  sentAt: text("sent_at"),
  createdAt: text("created_at").notNull().default(now),
}, (t) => [uniqueIndex("event_reminders_event_idx").on(t.eventId)]);

// Web Push subscriptions. One browser/endpoint per row.
export const pushSubscriptions = sqliteTable("push_subscriptions", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: text("created_at").notNull().default(now),
  lastSuccessAt: text("last_success_at"),
  failureCount: integer("failure_count").notNull().default(0),
}, (t) => [index("push_subscriptions_user_idx").on(t.userId)]);

export type EventReminder = typeof eventReminders.$inferSelect;
export type PushSubscription = typeof pushSubscriptions.$inferSelect;
export type User = typeof users.$inferSelect;
export type GoogleConnection = typeof googleConnections.$inferSelect;
export type Group = typeof groups.$inferSelect;
export type GroupMember = typeof groupMembers.$inferSelect;
export type ApiToken = typeof apiTokens.$inferSelect;
export type EventRow = typeof events.$inferSelect;
