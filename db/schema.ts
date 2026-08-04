import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    ownerUserId: text("owner_user_id"),
    refreshTokenEncrypted: text("refresh_token_encrypted").notNull(),
    historyId: text("history_id"),
    lastSyncedAt: integer("last_synced_at"),
    syncStatus: text("sync_status").notNull().default("idle"),
    syncPageToken: text("sync_page_token"),
    activeSyncRunId: text("active_sync_run_id"),
    syncIndexedCount: integer("sync_indexed_count").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("users_email_idx").on(table.email),
    index("users_owner_idx").on(table.ownerUserId),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    idHash: text("id_hash").primaryKey(),
    userId: text("user_id").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("sessions_user_idx").on(table.userId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: text("id").notNull(),
    userId: text("user_id").notNull(),
    threadId: text("thread_id").notNull(),
    senderEmail: text("sender_email").notNull(),
    senderName: text("sender_name").notNull(),
    subject: text("subject").notNull(),
    receivedAt: integer("received_at").notNull(),
    isUnread: integer("is_unread", { mode: "boolean" }).notNull().default(false),
    isStarred: integer("is_starred", { mode: "boolean" }).notNull().default(false),
    isImportant: integer("is_important", { mode: "boolean" }).notNull().default(false),
    labelsJson: text("labels_json").notNull(),
    syncRunId: text("sync_run_id").notNull(),
    trashedAt: integer("trashed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.id], name: "messages_user_id_id_pk" }),
    index("messages_user_sender_idx").on(table.userId, table.senderEmail),
    index("messages_user_received_idx").on(table.userId, table.receivedAt),
  ],
);

export const cleanupJobs = sqliteTable(
  "cleanup_jobs",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    senderEmail: text("sender_email").notNull(),
    messageIdsJson: text("message_ids_json").notNull(),
    status: text("status").notNull(),
    createdAt: integer("created_at").notNull(),
    undoneAt: integer("undone_at"),
  },
  (table) => [index("cleanup_jobs_user_idx").on(table.userId, table.createdAt)],
);
