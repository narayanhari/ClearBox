import assert from "node:assert/strict";
import test from "node:test";

import { ApiResponseError, readApiJson } from "../app/lib/client-http.ts";

test("reads JSON API responses", async () => {
  const response = new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
  assert.deepEqual(await readApiJson(response), { ok: true });
});

test("turns Cloudflare HTML failures into a retryable application error", async () => {
  const response = new Response("<!DOCTYPE html><title>Worker exceeded resource limits</title>", {
    status: 500,
    headers: { "content-type": "text/html; charset=UTF-8" },
  });

  await assert.rejects(
    readApiJson(response),
    (error) =>
      error instanceof ApiResponseError &&
      error.status === 500 &&
      error.retryable &&
      !error.message.includes("DOCTYPE"),
  );
});

test("does not retry unexpected non-error HTML responses", async () => {
  const response = new Response("<!DOCTYPE html>", {
    status: 200,
    headers: { "content-type": "text/html" },
  });

  await assert.rejects(
    readApiJson(response),
    (error) => error instanceof ApiResponseError && error.status === 200 && !error.retryable,
  );
});
