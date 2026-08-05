import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_BETA_MEMBERS,
  MAX_LINKED_GMAIL_ACCOUNTS,
  normalizeBetaEmail,
} from "../app/lib/beta-policy.ts";

test("normalizes beta invitation addresses without accepting header or control characters", () => {
  assert.equal(normalizeBetaEmail("  Invited.User@Gmail.com  "), "invited.user@gmail.com");
  assert.equal(normalizeBetaEmail("person@example.com\r\nInjected: yes"), null);
  assert.equal(normalizeBetaEmail("not-an-email"), null);
  assert.equal(normalizeBetaEmail("x".repeat(255) + "@example.com"), null);
  assert.equal(normalizeBetaEmail({ email: "person@example.com" }), null);
});

test("keeps the invite-only beta and linked mailbox expansion deliberately bounded", () => {
  assert.equal(MAX_BETA_MEMBERS, 25);
  assert.equal(MAX_LINKED_GMAIL_ACCOUNTS, 5);
});
