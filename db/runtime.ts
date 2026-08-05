import { env } from "cloudflare:workers";

export interface AppEnvironment {
  DB: D1Database;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  APP_ENCRYPTION_KEY?: string;
  BETA_ADMIN_EMAIL?: string;
  // Backwards-compatible fallback for existing personal deployments.
  ALLOWED_GMAIL_ADDRESS?: string;
}

let schemaReady: Promise<void> | undefined;

export function getEnvironment(): AppEnvironment {
  return env as unknown as AppEnvironment;
}

export async function getDatabase(): Promise<D1Database> {
  const database = getEnvironment().DB;
  if (!database) {
    throw new Error("The D1 database binding is not available.");
  }

  schemaReady ??= initializeSchema(database).catch((error) => {
    schemaReady = undefined;
    throw error;
  });
  await schemaReady;
  return database;
}

async function initializeSchema(database: D1Database): Promise<void> {
  await database.batch([
    `CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY NOT NULL,
      email TEXT NOT NULL UNIQUE,
      owner_user_id TEXT,
      refresh_token_encrypted TEXT NOT NULL,
      history_id TEXT,
      last_synced_at INTEGER,
      sync_status TEXT NOT NULL DEFAULT 'idle',
      sync_page_token TEXT,
      active_sync_run_id TEXT,
      sync_indexed_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS sessions (
      id_hash TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS messages (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      is_unread INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_important INTEGER NOT NULL DEFAULT 0,
      labels_json TEXT NOT NULL,
      sync_run_id TEXT NOT NULL,
      trashed_at INTEGER,
      PRIMARY KEY (user_id, id)
    )`,
    `CREATE TABLE IF NOT EXISTS cleanup_jobs (
      id TEXT PRIMARY KEY NOT NULL,
      user_id TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      message_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      undone_at INTEGER
    )`,
    `CREATE TABLE IF NOT EXISTS beta_members (
      email TEXT PRIMARY KEY NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      status TEXT NOT NULL DEFAULT 'invited',
      invited_by TEXT,
      invited_at INTEGER NOT NULL,
      accepted_at INTEGER,
      updated_at INTEGER NOT NULL
    )`,
  ].map((statement) => database.prepare(statement)));

  await ensureLinkedAccountColumns(database);
  await ensureAccountScopedMessageKeys(database);
  await ensureBetaAdmin(database);

  await database.batch([
    database.prepare("CREATE INDEX IF NOT EXISTS users_owner_idx ON users (owner_user_id)"),
    database.prepare("CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id)"),
    database.prepare("CREATE INDEX IF NOT EXISTS messages_user_sender_idx ON messages (user_id, sender_email)"),
    database.prepare("CREATE INDEX IF NOT EXISTS messages_user_received_idx ON messages (user_id, received_at)"),
    database.prepare("CREATE INDEX IF NOT EXISTS cleanup_jobs_user_idx ON cleanup_jobs (user_id, created_at)"),
    database.prepare("CREATE INDEX IF NOT EXISTS beta_members_status_idx ON beta_members (status, invited_at)"),
  ]);
}

async function ensureBetaAdmin(database: D1Database): Promise<void> {
  const environment = getEnvironment();
  const rawEmail = environment.BETA_ADMIN_EMAIL ?? environment.ALLOWED_GMAIL_ADDRESS;
  const email = rawEmail?.trim().toLowerCase();
  const now = Date.now();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    // Missing or malformed administrator configuration must disable existing
    // administrator sessions without destructively erasing recoverable data.
    await database
      .prepare("UPDATE beta_members SET status = 'revoked', updated_at = ? WHERE role = 'admin'")
      .bind(now)
      .run();
    return;
  }

  const previousAdmins = await database
    .prepare(
      `SELECT b.email, u.id AS owner_id
       FROM beta_members b
       LEFT JOIN users u ON u.email = b.email AND u.owner_user_id = u.id
       WHERE b.email != ? AND (
         b.role = 'admin' OR
         (b.role = 'member' AND b.status = 'revoked' AND b.invited_by IS NULL)
       )`,
    )
    .bind(email)
    .all<{ email: string; owner_id: string | null }>();

  const statements: D1PreparedStatement[] = [
    database
      .prepare(
        `UPDATE beta_members
         SET role = 'member', status = 'revoked', updated_at = ?
         WHERE role = 'admin' AND email != ?`,
      )
      .bind(now, email),
    database
      .prepare(
        `INSERT INTO beta_members (
          email, role, status, invited_by, invited_at, accepted_at, updated_at
        ) VALUES (?, 'admin', 'active', NULL, ?, ?, ?)
        ON CONFLICT(email) DO UPDATE SET
          role = 'admin', status = 'active', accepted_at = COALESCE(accepted_at, excluded.accepted_at),
          updated_at = excluded.updated_at`,
      )
      .bind(email, now, now, now),
  ];
  for (const previous of previousAdmins.results) {
    if (!previous.owner_id) continue;
    statements.push(
      database.prepare("DELETE FROM cleanup_jobs WHERE user_id = ?").bind(previous.owner_id),
      database
        .prepare("DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE owner_user_id = ?)")
        .bind(previous.owner_id),
      database.prepare("DELETE FROM sessions WHERE user_id = ?").bind(previous.owner_id),
      database.prepare("DELETE FROM users WHERE owner_user_id = ?").bind(previous.owner_id),
    );
  }
  await database.batch(statements);
}

async function ensureLinkedAccountColumns(database: D1Database): Promise<void> {
  const columns = await database.prepare("PRAGMA table_info(users)").all<{ name: string }>();
  const names = new Set(columns.results.map((column) => column.name));
  const additions = [
    ["owner_user_id", "ALTER TABLE users ADD COLUMN owner_user_id TEXT"],
    ["sync_page_token", "ALTER TABLE users ADD COLUMN sync_page_token TEXT"],
    ["active_sync_run_id", "ALTER TABLE users ADD COLUMN active_sync_run_id TEXT"],
    [
      "sync_indexed_count",
      "ALTER TABLE users ADD COLUMN sync_indexed_count INTEGER NOT NULL DEFAULT 0",
    ],
  ] as const;

  for (const [name, statement] of additions) {
    if (!names.has(name)) await database.prepare(statement).run();
  }

  await database.prepare("UPDATE users SET owner_user_id = id WHERE owner_user_id IS NULL").run();
}

async function ensureAccountScopedMessageKeys(database: D1Database): Promise<void> {
  const columns = await database
    .prepare("PRAGMA table_info(messages)")
    .all<{ name: string; pk: number }>();
  const primaryKey = columns.results
    .filter((column) => column.pk > 0)
    .sort((left, right) => left.pk - right.pk)
    .map((column) => column.name);

  if (primaryKey.length === 2 && primaryKey[0] === "user_id" && primaryKey[1] === "id") return;

  await database.batch([
    database.prepare(`CREATE TABLE messages_account_scoped (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      sender_email TEXT NOT NULL,
      sender_name TEXT NOT NULL,
      subject TEXT NOT NULL,
      received_at INTEGER NOT NULL,
      is_unread INTEGER NOT NULL DEFAULT 0,
      is_starred INTEGER NOT NULL DEFAULT 0,
      is_important INTEGER NOT NULL DEFAULT 0,
      labels_json TEXT NOT NULL,
      sync_run_id TEXT NOT NULL,
      trashed_at INTEGER,
      PRIMARY KEY (user_id, id)
    )`),
    database.prepare(`INSERT INTO messages_account_scoped (
      id, user_id, thread_id, sender_email, sender_name, subject, received_at,
      is_unread, is_starred, is_important, labels_json, sync_run_id, trashed_at
    ) SELECT
      id, user_id, thread_id, sender_email, sender_name, subject, received_at,
      is_unread, is_starred, is_important, labels_json, sync_run_id, trashed_at
    FROM messages`),
    database.prepare("DROP TABLE messages"),
    database.prepare("ALTER TABLE messages_account_scoped RENAME TO messages"),
  ]);
}
