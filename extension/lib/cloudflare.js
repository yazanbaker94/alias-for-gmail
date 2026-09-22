import { isValidEmail } from "./config.js";

const API_ROOT = "https://api.cloudflare.com/client/v4/accounts";
const MAX_RECIPIENTS = 50;
const MAX_MESSAGE_BYTES = 5 * 1024 * 1024;
const MAX_ATTACHMENT_COUNT = 20;
const MAX_HEADERS_BYTES = 16 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

const ALLOWED_HEADERS = new Set([
  "archived-at",
  "auto-submitted",
  "comments",
  "content-language",
  "expires",
  "importance",
  "in-reply-to",
  "keywords",
  "list-archive",
  "list-help",
  "list-id",
  "list-owner",
  "list-post",
  "list-subscribe",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "organization",
  "precedence",
  "priority",
  "references",
  "reply-by",
  "require-recipient-valid-since",
  "sensitivity",
  "thread-index",
  "thread-topic"
]);

const FORBIDDEN_HEADERS = new Set([
  "authorization",
  "bcc",
  "cc",
  "content-length",
  "content-type",
  "from",
  "reply-to",
  "subject",
  "to"
]);

export class ProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.status = options.status;
    this.providerCode = options.providerCode;
  }
}

export function prepareMessage(payload, config) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProviderError("INVALID_MESSAGE", "Gmail did not provide a valid message.");
  }

  const to = normalizeRecipients(payload.to, "To");
  const cc = normalizeRecipients(payload.cc, "Cc");
  const bcc = normalizeRecipients(payload.bcc, "Bcc");

  if (config.defaultBcc && !containsEmail([...to, ...cc, ...bcc], config.defaultBcc)) {
    bcc.push(config.defaultBcc);
  }

  const recipientCount = to.length + cc.length + bcc.length;
  if (recipientCount === 0) {
    throw new ProviderError("MISSING_RECIPIENT", "Add at least one recipient before sending.");
  }
  if (recipientCount > MAX_RECIPIENTS) {
    throw new ProviderError("TOO_MANY_RECIPIENTS", "Cloudflare allows at most 50 recipients per message.");
  }

  const requestedFrom = cleanString(payload.from, 254).toLowerCase();
  if (requestedFrom && requestedFrom !== config.fromAddress) {
    throw new ProviderError(
      "SENDER_MISMATCH",
      "The Gmail alias does not match the sender address saved in extension settings."
    );
  }

  const subject = cleanHeaderValue(payload.subject, 998);
  const html = cleanBody(payload.html);
  const text = cleanBody(payload.text);
  if (!html && !text) {
    throw new ProviderError("EMPTY_MESSAGE", "Add a message before sending.");
  }

  const replyTo = cleanString(payload.replyTo || config.fromAddress, 254).toLowerCase();
  if (replyTo && !isValidEmail(replyTo)) {
    throw new ProviderError("INVALID_REPLY_TO", "The Reply-To address is invalid.");
  }

  const fromName = cleanHeaderValue(payload.fromName || config.fromName, 200);
  const attachments = normalizeAttachments(payload.attachments);
  const headers = normalizeHeaders(payload.headers);

  const message = {
    to,
    from: fromName ? { address: config.fromAddress, name: fromName } : config.fromAddress,
    subject
  };

  if (cc.length) message.cc = cc;
  if (bcc.length) message.bcc = bcc;
  if (html) message.html = html;
  if (text) message.text = text;
  if (replyTo) message.reply_to = replyTo;
  if (attachments.length) message.attachments = attachments;
  if (Object.keys(headers).length) message.headers = headers;

  const messageBytes = new TextEncoder().encode(JSON.stringify(message)).byteLength;
  if (messageBytes > MAX_MESSAGE_BYTES) {
    throw new ProviderError(
      "MESSAGE_TOO_LARGE",
      "The complete email must be smaller than 5 MiB, including base64 attachments."
    );
  }

  return {
    message,
    summary: {
      toCount: to.length,
      ccCount: cc.length,
      bccCount: bcc.length,
      attachmentCount: attachments.length,
      messageBytes,
      subjectLength: subject.length
    }
  };
}

export async function sendWithCloudflare(message, config) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;

  try {
    response = await fetch(
      `${API_ROOT}/${encodeURIComponent(config.cloudflareAccountId)}/email/sending/send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.cloudflareApiToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(message),
        signal: controller.signal,
        cache: "no-store",
        credentials: "omit"
      }
    );
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new ProviderError("REQUEST_TIMEOUT", "Cloudflare did not respond within 30 seconds.");
    }
    throw new ProviderError("NETWORK_ERROR", "Could not connect to Cloudflare Email Sending.");
  } finally {
    clearTimeout(timeoutId);
  }

  let data;
  try {
    data = await response.json();
  } catch {
    throw new ProviderError(
      "INVALID_PROVIDER_RESPONSE",
      "Cloudflare returned an unreadable response.",
      { status: response.status }
    );
  }

  if (!response.ok || data?.success !== true) {
    throw mapCloudflareError(response.status, data);
  }

  const delivered = normalizeProviderAddresses(data?.result?.delivered);
  const queued = normalizeProviderAddresses(data?.result?.queued);
  const permanentBounces = normalizeProviderAddresses(data?.result?.permanent_bounces);

  if (delivered.length === 0 && queued.length === 0 && permanentBounces.length === 0) {
    throw new ProviderError(
      "INVALID_PROVIDER_RESPONSE",
      "Cloudflare did not confirm whether any recipient was accepted."
    );
  }

  if (delivered.length === 0 && queued.length === 0 && permanentBounces.length > 0) {
    throw new ProviderError("RECIPIENT_REJECTED", "Cloudflare rejected every recipient.");
  }

  return {
    delivered,
    queued,
    permanentBounces,
    mock: false
  };
}

function normalizeRecipients(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ProviderError("INVALID_RECIPIENTS", `${label} recipients must be a list.`);
  }

  const result = [];
  for (const item of value) {
    const email = typeof item === "string" ? item.trim().toLowerCase() : "";
    if (!isValidEmail(email)) {
      throw new ProviderError("INVALID_RECIPIENT", `One of the ${label} addresses is invalid.`);
    }
    if (!containsEmail(result, email)) result.push(email);
  }
  return result;
}

function normalizeAttachments(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ProviderError("INVALID_ATTACHMENTS", "Gmail provided an invalid attachment list.");
  }
  if (value.length > MAX_ATTACHMENT_COUNT) {
    throw new ProviderError("TOO_MANY_ATTACHMENTS", "This prototype supports at most 20 attachments.");
  }

  return value.map((attachment, index) => {
    if (!attachment || typeof attachment !== "object") {
      throw new ProviderError("INVALID_ATTACHMENT", `Attachment ${index + 1} is invalid.`);
    }

    const filename = cleanHeaderValue(attachment.filename, 255);
    const type = cleanHeaderValue(attachment.mimeType || attachment.type || "application/octet-stream", 200);
    let content = cleanString(attachment.contentBase64 || attachment.content, MAX_MESSAGE_BYTES * 2);
    const dataUrlMatch = content.match(/^data:[^;,]+;base64,(.*)$/s);
    if (dataUrlMatch) content = dataUrlMatch[1];

    if (!filename || !content) {
      throw new ProviderError(
        "INVALID_ATTACHMENT",
        `Attachment ${index + 1} is missing its filename or contents.`
      );
    }

    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content) || content.length % 4 !== 0) {
      throw new ProviderError("INVALID_ATTACHMENT", `Attachment ${index + 1} is not valid base64 data.`);
    }

    return {
      filename,
      type,
      content,
      disposition: "attachment"
    };
  });
}

function normalizeHeaders(value) {
  if (value == null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new ProviderError("INVALID_HEADERS", "Gmail provided invalid email headers.");
  }

  const entries = Object.entries(value);
  if (entries.length > 20) {
    throw new ProviderError("TOO_MANY_HEADERS", "This prototype supports at most 20 custom headers.");
  }

  const headers = {};
  let headersBytes = 0;
  for (const [rawName, rawValue] of entries) {
    const name = cleanString(rawName, 100);
    const lowerName = name.toLowerCase();
    const isCustomHeader = /^X-[A-Za-z0-9_-]+$/i.test(name);
    if (
      (!/^[A-Za-z0-9-]+$/.test(name) && !isCustomHeader) ||
      FORBIDDEN_HEADERS.has(lowerName) ||
      (!ALLOWED_HEADERS.has(lowerName) && !isCustomHeader)
    ) continue;
    if (typeof rawValue !== "string" || !rawValue || /[\r\n]/.test(rawValue)) continue;

    const headerValue = rawValue.slice(0, 2_048);
    headersBytes += new TextEncoder().encode(`${name}: ${headerValue}\r\n`).byteLength;
    if (headersBytes > MAX_HEADERS_BYTES) {
      throw new ProviderError("HEADERS_TOO_LARGE", "Custom email headers must be smaller than 16 KiB.");
    }
    headers[name] = headerValue;
  }
  return headers;
}

function mapCloudflareError(status, data) {
  const providerCode = Number(data?.errors?.[0]?.code) || undefined;

  // Cloudflare can return a generic numeric code for some rejected OAuth or
  // API credentials. The HTTP status is the reliable signal in that case.
  if (status === 401) {
    return new ProviderError(
      "AUTHENTICATION_FAILED",
      "Cloudflare rejected the API token. Create a fresh token with Email Sending permission.",
      { status, providerCode }
    );
  }

  const mapped = {
    10000: ["PROVIDER_NOT_FOUND", "Cloudflare could not find Email Sending for this account."],
    10001: ["PROVIDER_REJECTED_MESSAGE", "Cloudflare rejected the email format."],
    10002: ["PROVIDER_UNAVAILABLE", "Cloudflare Email Sending had an internal error. Try again."],
    10003: ["PROVIDER_UNAVAILABLE", "Cloudflare Email Sending is temporarily unavailable."],
    10004: ["RATE_LIMITED", "Cloudflare rate-limited this account. Wait and try again."],
    10100: ["PROVIDER_UNAVAILABLE", "Cloudflare authentication is temporarily unavailable."],
    10101: ["AUTHENTICATION_FAILED", "The Cloudflare API token is invalid or expired."],
    10102: ["PERMISSION_DENIED", "The Cloudflare token lacks Email Sending permission."],
    10103: ["AUTHENTICATION_FAILED", "Cloudflare requires an API token for this request."],
    10105: ["EMAIL_SENDING_NOT_AVAILABLE", "Email Sending is not available on this Cloudflare account."],
    10200: ["MESSAGE_TOO_LARGE", "Cloudflare rejected the email because it exceeds 5 MiB."],
    10201: ["PROVIDER_REJECTED_MESSAGE", "Cloudflare rejected the email request."],
    10202: ["PROVIDER_REJECTED_MESSAGE", "Cloudflare rejected the email contents."],
    10203: ["EMAIL_SENDING_DISABLED", "Email Sending is disabled for this Cloudflare account."]
  };

  let [code, message] = mapped[providerCode] || ["PROVIDER_ERROR", "Cloudflare could not send this email."];
  if (!providerCode) {
    if (status === 403) [code, message] = ["PERMISSION_DENIED", "Cloudflare denied this send request."];
    else if (status === 429) [code, message] = ["RATE_LIMITED", "Cloudflare rate-limited this account."];
    else if (status >= 500) [code, message] = ["PROVIDER_UNAVAILABLE", "Cloudflare Email Sending is unavailable."];
  }

  return new ProviderError(code, message, { status, providerCode });
}

function containsEmail(list, email) {
  const target = email.toLowerCase();
  return list.some((item) => item.toLowerCase() === target);
}

function normalizeProviderAddresses(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => typeof item === "string" && isValidEmail(item)).slice(0, MAX_RECIPIENTS);
}

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanHeaderValue(value, maxLength) {
  return cleanString(value, maxLength).replace(/[\r\n]+/g, " ");
}

function cleanBody(value) {
  return typeof value === "string" ? value.slice(0, MAX_MESSAGE_BYTES) : "";
}
