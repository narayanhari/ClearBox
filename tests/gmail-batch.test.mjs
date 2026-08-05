import assert from "node:assert/strict";
import test from "node:test";

import {
  createGmailMetadataBatch,
  GMAIL_METADATA_BATCH_SIZE,
  isUnavailableGmailMessageStatus,
  parseGmailBatchResponse,
} from "../app/lib/gmail-batch.ts";

function multipartResponse(boundary, parts) {
  return [
    ...parts.flatMap(({ contentId, status = 200, body }) => [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <response-${contentId}>`,
      "",
      `HTTP/1.1 ${status} ${status === 200 ? "OK" : "Error"}`,
      "Content-Type: application/json",
      "",
      body,
    ]),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}

test("creates metadata-only Gmail batches without exposing authorization", () => {
  const batch = createGmailMetadataBatch(["abc123", "message/with space"]);

  assert.equal(batch.parts.length, 2);
  assert.match(batch.contentType, /^multipart\/mixed; boundary=clearbox_[a-f0-9]+$/);
  assert.match(batch.body, /format=metadata/);
  assert.match(batch.body, /metadataHeaders=From/);
  assert.match(batch.body, /fields=id%2CthreadId%2ClabelIds%2ChistoryId%2CinternalDate%2Cpayload%2Fheaders/);
  assert.match(batch.body, /message%2Fwith%20space/);
  assert.doesNotMatch(batch.body, /authorization|bearer/i);
});

test("rejects oversized request batches and header injection identifiers", () => {
  assert.equal(GMAIL_METADATA_BATCH_SIZE, 20);
  assert.throws(
    () => createGmailMetadataBatch(Array.from({ length: GMAIL_METADATA_BATCH_SIZE + 1 }, (_, index) => `${index}`)),
    /must contain/,
  );
  assert.throws(() => createGmailMetadataBatch(["safe\r\nInjected: yes"]), /invalid message identifier/);
});

test("recognizes messages that can disappear safely during a Gmail scan", () => {
  assert.equal(isUnavailableGmailMessageStatus(404), true);
  assert.equal(isUnavailableGmailMessageStatus(410), true);
  assert.equal(isUnavailableGmailMessageStatus(400), false);
  assert.equal(isUnavailableGmailMessageStatus(429), false);
});

test("parses out-of-order multipart responses using strict content identifiers", () => {
  const boundary = "batch_response_123";
  const response = multipartResponse(boundary, [
    { contentId: "clearbox-1", body: JSON.stringify({ id: "second", threadId: "thread-2" }) },
    { contentId: "clearbox-0", body: JSON.stringify({ id: "first", threadId: "thread-1" }) },
  ]);

  const parts = parseGmailBatchResponse(
    `multipart/mixed; boundary="${boundary}"`,
    response,
    ["clearbox-0", "clearbox-1"],
  );
  assert.deepEqual(parts.map((part) => JSON.parse(part.body).id), ["first", "second"]);
});

test("preserves retryable statuses without accepting missing or duplicate parts", () => {
  const boundary = "batch_response_456";
  const retryable = multipartResponse(boundary, [
    { contentId: "clearbox-0", status: 429, body: JSON.stringify({ error: { code: 429 } }) },
  ]);
  assert.equal(
    parseGmailBatchResponse(`multipart/mixed; boundary=${boundary}`, retryable, ["clearbox-0"])[0].status,
    429,
  );

  assert.throws(
    () => parseGmailBatchResponse(`multipart/mixed; boundary=${boundary}`, retryable, ["clearbox-0", "clearbox-1"]),
    /incomplete/,
  );
  assert.throws(
    () => parseGmailBatchResponse("text/plain", retryable, ["clearbox-0"]),
    /not multipart/,
  );
});
