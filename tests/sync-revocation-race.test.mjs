import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const activeLinkedAccountPredicate = `EXISTS (
  SELECT 1
  FROM users linked_account
  JOIN users owner
    ON owner.id = linked_account.owner_user_id AND owner.owner_user_id = owner.id
  JOIN beta_members membership
    ON membership.email = owner.email AND membership.status = 'active'
  WHERE linked_account.id = ?
)`;

test("stale sync writes cannot restore Gmail metadata after workspace deletion", async () => {
  const gmailSource = await readFile(new URL("../app/lib/gmail.ts", import.meta.url), "utf8");
  assert.match(gmailSource, /WHERE \$\{ACTIVE_LINKED_ACCOUNT_PREDICATE\}/);
  assert.match(gmailSource, /chunkWrite\.meta\.changes !== 1 \|\| accountWrite\.meta\.changes !== 1/);

  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL, owner_user_id TEXT
    );
    CREATE TABLE beta_members (
      email TEXT PRIMARY KEY, status TEXT NOT NULL
    );
    CREATE TABLE sync_chunks (
      user_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, message_ids_json TEXT NOT NULL,
      cursor INTEGER NOT NULL, next_page_token TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE messages (
      id TEXT NOT NULL, user_id TEXT NOT NULL, subject TEXT NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    INSERT INTO users VALUES ('owner-1', 'owner@example.com', 'owner-1');
    INSERT INTO users VALUES ('account-1', 'linked@example.com', 'owner-1');
    INSERT INTO beta_members VALUES ('owner@example.com', 'active');
  `);

  const chunkInsert = database.prepare(`
    INSERT INTO sync_chunks (
      user_id, run_id, message_ids_json, cursor, next_page_token, created_at, updated_at
    ) SELECT ?, ?, ?, 0, ?, ?, ? WHERE ${activeLinkedAccountPredicate}
  `);
  assert.equal(
    chunkInsert.run("account-1", "run-1", '["message-1"]', "next", 1, 1, "account-1").changes,
    1,
  );

  database.exec(`
    DELETE FROM sync_chunks WHERE user_id IN (SELECT id FROM users WHERE owner_user_id = 'owner-1');
    DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE owner_user_id = 'owner-1');
    DELETE FROM users WHERE owner_user_id = 'owner-1';
  `);

  assert.equal(
    chunkInsert.run("account-1", "run-1", '["message-1"]', "next", 2, 2, "account-1").changes,
    0,
  );
  const messageWrite = database.prepare(`
    INSERT INTO messages (id, user_id, subject)
    SELECT json_extract(item.value, '$.id'), ?, json_extract(item.value, '$.subject')
    FROM json_each(?) AS item
    WHERE ${activeLinkedAccountPredicate}
  `);
  assert.equal(
    messageWrite.run("account-1", '[{"id":"message-1","subject":"private"}]', "account-1").changes,
    0,
  );
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sync_chunks").get().count, 0);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM messages").get().count, 0);
});
