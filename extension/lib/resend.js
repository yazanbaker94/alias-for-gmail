import { isValidEmail } from "./config.js";
import { ProviderError } from "./cloudflare.js";

const API_URL = "https://api.resend.com/emails";
const MAX_RECIPIENTS = 50;
const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
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

// Re-exporting the shared error class lets the background service worker keep
// one stable public-error boundary for every direct provider.
export { ProviderError };

/**
 * Validate Gmail's compose payload and map it to Resend's POST /emails schema.
 */
export function prepareResendMessage(payload, config) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new ProviderError("INVALID_MESSAGE", "Gmail did not provide a valid message.");
  }

  const fromAddress = cleanString(config?.fromAddress, 254).toLowerCase();
  if (!isValidEmail(fromAddress)) {
    throw new ProviderError("INVALID_FROM_ADDRESS", "Enter a valid sender email address.");
  }

  const to = normalizeRecipients(payload.to, "To");
  const cc = normalizeRecipients(payload.cc, "Cc");
  const bcc = normalizeRecipients(payload.bcc, "Bcc");
  const defaultBcc = cleanString(config?.defaultBcc, 254).toLowerCase();

  if (defaultBcc) {
    if (!isValidEmail(defaultBcc)) {
      throw new ProviderError("INVALID_DEFAULT_BCC", "The default Bcc address is invalid.");
    }
    if (!containsEmail([...to, ...cc, ...bcc], defaultBcc)) bcc.push(defaultBcc);
  }

  const recipientCount = to.length + cc.length + bcc.length;
  if (recipientCount === 0) {
    throw new ProviderError("MISSING_RECIPIENT", "Add at least one recipient before sending.");
  }
  if (recipientCount > MAX_RECIPIENTS) {
    throw new ProviderError("TOO_MANY_RECIPIENTS", "Resend allows at most 50 recipients per message.");
  }

  const requestedFrom = cleanString(payload.from, 254).toLowerCase();
  if (requestedFrom && requestedFrom !== fromAddress) {
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

  const replyTo = cleanString(payload.replyTo || fromAddress, 254).toLowerCase();
  if (replyTo && !isValidEmail(replyTo)) {
    throw new ProviderError("INVALID_REPLY_TO", "The Reply-To address is invalid.");
  }

  const fromName = cleanHeaderValue(payload.fromName || config?.fromName, 200);
  const attachments = normalizeAttachments(payload.attachments);
  const headers = normalizeHeaders(payload.headers);

  const message = {
    from: formatSender(fromAddress, fromName),
    to,
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
      "The complete email must be smaller than 40 MiB, including base64 attachments."
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

/**
 * Send a prepared Resend message. The optional third argument exists only to
 * make timeout behavior deterministic in tests; production callers omit it.
 */
export async function sendWithResend(message, config, options = {}) {
  const apiKey = cleanString(config?.resendApiKey || config?.resendApiToken, 2_000);
  if (!apiKey) {
    throw new ProviderError("MISSING_API_KEY", "Add your Resend sending API key in extension settings.");
  }

  const idempotencyKey = resolveIdempotencyKey(options);

  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(1, Math.min(options.timeoutMs, REQUEST_TIMEOUT_MS))
    : REQUEST_TIMEOUT_MS;
  const fetchImpl = typeof options.fetchImpl === "function" ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new ProviderError("NETWORK_ERROR", "Could not connect to Resend.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  let response;

  try {
    response = await fetchImpl(API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey
      },
      body: JSON.stringify(message),
      signal: controller.signal,
      cache: "no-store",
      credentials: "omit"
    });
  } catch (error) {
    if (error?.name === "AbortError" || controller.signal.aborted) {
      throw new ProviderError("REQUEST_TIMEOUT", "Resend did not respond within 30 seconds.");
    }
    // Never echo fetch exceptions: browser and proxy errors can contain the
    // Authorization header or request URL.
    throw new ProviderError("NETWORK_ERROR", "Could not connect to Resend.");
  } finally {
    clearTimeout(timeoutId);
  }

  // POST /emails returning 2xx means Resend accepted the request. It does not
  // mean any recipient was queued by their mailbox or that delivery occurred.
  if (response.ok) {
    return { accepted: true, mock: false };
  }

  let data = null;
  try {
    data = await response.json();
  } catch {
    // HTTP status still provides a useful, sanitized failure category when a
    // gateway or proxy returns HTML instead of Resend's JSON error schema.
  }
  throw mapResendError(response.status, data);
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

    // Resend's REST schema accepts filename plus base64 content. MIME type and
    // disposition are intentionally omitted because they are not REST fields.
    return { filename, content };
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

function mapResendError(status, data) {
  const providerCode = cleanString(data?.name || data?.code, 100) || undefined;
  const mapped = {
    missing_api_key: ["AUTHENTICATION_FAILED", "Resend did not receive an API key."],
    invalid_api_key: ["AUTHENTICATION_FAILED", "Resend rejected the API key."],
    restricted_api_key: ["PERMISSION_DENIED", "The Resend API key does not have permission to send."],
    invalid_attachment: ["INVALID_ATTACHMENT", "Resend rejected one of the attachments."],
    invalid_from_address: ["INVALID_FROM_ADDRESS", "Resend rejected the sender address."],
    missing_required_field: ["PROVIDER_REJECTED_MESSAGE", "Resend rejected the email because a required field is missing."],
    invalid_parameter: ["PROVIDER_REJECTED_MESSAGE", "Resend rejected an email field."],
    invalid_idempotency_key: ["PROVIDER_REJECTED_MESSAGE", "Resend rejected the email request."],
    invalid_idempotent_request: ["PROVIDER_REJECTED_MESSAGE", "Resend rejected the duplicate email request."],
    concurrent_idempotent_requests: ["RATE_LIMITED", "An identical Resend request is already being processed."],
    daily_quota_exceeded: ["QUOTA_EXCEEDED", "This Resend account has reached its daily email quota."],
    monthly_quota_exceeded: ["QUOTA_EXCEEDED", "This Resend account has reached its monthly email quota."],
    rate_limit_exceeded: ["RATE_LIMITED", "Resend rate-limited this account. Wait and try again."],
    security_error: ["PERMISSION_DENIED", "Resend blocked this send request for security reasons."],
    application_error: ["PROVIDER_UNAVAILABLE", "Resend is temporarily unavailable."],
    internal_server_error: ["PROVIDER_UNAVAILABLE", "Resend is temporarily unavailable."]
  };

  let code;
  let message;
  if (providerCode === "validation_error" && status === 403) {
    [code, message] = [
      "SENDER_NOT_VERIFIED",
      "Resend rejected the sender. Verify the sending domain and the API key's domain scope."
    ];
  } else if (providerCode === "validation_error") {
    [code, message] = ["PROVIDER_REJECTED_MESSAGE", "Resend rejected one or more email fields."];
  } else {
    [code, message] = mapped[providerCode] || ["PROVIDER_ERROR", "Resend could not send this email."];
  }

  if (!providerCode) {
    if (status === 401) [code, message] = ["AUTHENTICATION_FAILED", "Resend did not accept the API credentials."];
    else if (status === 403) [code, message] = ["PERMISSION_DENIED", "Resend denied this send request."];
    else if (status === 429) [code, message] = ["RATE_LIMITED", "Resend rate-limited this account."];
    else if (status >= 500) [code, message] = ["PROVIDER_UNAVAILABLE", "Resend is temporarily unavailable."];
  }

  return new ProviderError(code, message, { status, providerCode });
}

function formatSender(address, name) {
  if (!name) return address;
  const safeName = name
    .replace(/[<>]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\s+/g, " ")
    .trim();
  return safeName ? `"${safeName}" <${address}>` : address;
}

function resolveIdempotencyKey(options) {
  if (Object.prototype.hasOwnProperty.call(options, "idempotencyKey")) {
    return validateIdempotencyKey(options.idempotencyKey);
  }

  const randomUUID = typeof options.randomUUID === "function"
    ? options.randomUUID
    : globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  if (typeof randomUUID !== "function") {
    throw new ProviderError(
      "IDEMPOTENCY_UNAVAILABLE",
      "The extension could not create a safe Resend request identifier."
    );
  }

  let uuid;
  try {
    uuid = randomUUID();
  } catch {
    throw new ProviderError(
      "IDEMPOTENCY_UNAVAILABLE",
      "The extension could not create a safe Resend request identifier."
    );
  }
  return validateIdempotencyKey(`gmail-alias-${uuid}`);
}

function validateIdempotencyKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[A-Za-z0-9._~-]+$/.test(value)
  ) {
    throw new ProviderError(
      "INVALID_IDEMPOTENCY_KEY",
      "The extension could not create a valid Resend request identifier."
    );
  }
  return value;
}

function containsEmail(list, email) {
  const target = email.toLowerCase();
  return list.some((item) => item.toLowerCase() === target);
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
