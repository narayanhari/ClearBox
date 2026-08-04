const GMAIL_MESSAGE_PATH = "/gmail/v1/users/me/messages";

export const GMAIL_METADATA_BATCH_SIZE = 50;
export const GMAIL_BATCH_RESPONSE_LIMIT_BYTES = 4 * 1024 * 1024;

export interface GmailBatchRequestPart {
  contentId: string;
  messageId: string;
}

export interface GmailBatchRequest {
  body: string;
  contentType: string;
  parts: GmailBatchRequestPart[];
}

export interface GmailBatchResponsePart {
  contentId: string;
  status: number;
  body: string;
}

function responseBoundary(contentType: string): string {
  if (!/^multipart\/mixed\s*;/i.test(contentType)) {
    throw new Error("Gmail batch response was not multipart.");
  }
  const match = contentType.match(/(?:^|;)\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = match?.[1] ?? match?.[2] ?? "";
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) {
    throw new Error("Gmail batch response boundary was invalid.");
  }
  return boundary;
}

function splitBlock(value: string): [string, string] {
  const separator = value.indexOf("\n\n");
  if (separator < 0) throw new Error("Gmail batch response part was malformed.");
  return [value.slice(0, separator), value.slice(separator + 2)];
}

function headers(block: string): Map<string, string> {
  const parsed = new Map<string, string>();
  for (const line of block.split("\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name && !parsed.has(name)) parsed.set(name, value);
  }
  return parsed;
}

function normalizedContentId(value: string): string {
  const withoutBrackets = value.trim().replace(/^<|>$/g, "");
  return withoutBrackets.startsWith("response-")
    ? withoutBrackets.slice("response-".length)
    : withoutBrackets;
}

export function createGmailMetadataBatch(messageIds: string[]): GmailBatchRequest {
  if (!messageIds.length || messageIds.length > GMAIL_METADATA_BATCH_SIZE) {
    throw new Error(`Gmail metadata batches must contain 1-${GMAIL_METADATA_BATCH_SIZE} messages.`);
  }

  const boundary = `clearbox_${crypto.randomUUID().replaceAll("-", "")}`;
  const params = new URLSearchParams({
    format: "metadata",
    fields: "id,threadId,labelIds,historyId,internalDate,payload/headers",
  });
  for (const name of ["From", "Subject", "Date"]) params.append("metadataHeaders", name);

  const parts = messageIds.map((messageId, index) => {
    if (!messageId || messageId.length > 256 || /[\r\n]/.test(messageId)) {
      throw new Error("Gmail returned an invalid message identifier.");
    }
    return { contentId: `clearbox-${index}`, messageId };
  });

  const body = [
    ...parts.flatMap((part) => [
      `--${boundary}`,
      "Content-Type: application/http",
      `Content-ID: <${part.contentId}>`,
      "",
      `GET ${GMAIL_MESSAGE_PATH}/${encodeURIComponent(part.messageId)}?${params.toString()} HTTP/1.1`,
      "Accept: application/json",
      "",
    ]),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return {
    body,
    contentType: `multipart/mixed; boundary=${boundary}`,
    parts,
  };
}

export function parseGmailBatchResponse(
  contentType: string,
  body: string,
  expectedContentIds: string[],
): GmailBatchResponsePart[] {
  const boundary = responseBoundary(contentType);
  const expected = new Set(expectedContentIds);
  if (!expected.size || expected.size !== expectedContentIds.length) {
    throw new Error("Gmail batch request identifiers were invalid.");
  }

  const responses = new Map<string, GmailBatchResponsePart>();
  for (const rawPart of body.split(`--${boundary}`)) {
    const normalized = rawPart.replaceAll("\r\n", "\n").trim();
    if (!normalized || normalized === "--") continue;

    const [partHeaderBlock, nestedResponse] = splitBlock(normalized);
    const partHeaders = headers(partHeaderBlock);
    if (!/^application\/http(?:\s*;|$)/i.test(partHeaders.get("content-type") ?? "")) {
      throw new Error("Gmail batch response part had an invalid content type.");
    }

    const contentId = normalizedContentId(partHeaders.get("content-id") ?? "");
    if (!expected.has(contentId) || responses.has(contentId)) {
      throw new Error("Gmail batch response contained an unexpected identifier.");
    }

    const [statusAndHeaders, responseBody] = splitBlock(nestedResponse);
    const statusLine = statusAndHeaders.split("\n", 1)[0];
    const statusMatch = statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})(?:\s|$)/i);
    if (!statusMatch) throw new Error("Gmail batch response status was invalid.");

    responses.set(contentId, {
      contentId,
      status: Number(statusMatch[1]),
      body: responseBody.trim(),
    });
  }

  if (responses.size !== expected.size) {
    throw new Error("Gmail batch response was incomplete.");
  }
  return expectedContentIds.map((contentId) => responses.get(contentId)!);
}
