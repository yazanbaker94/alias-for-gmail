import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareResendMessage,
  ProviderError,
  sendWithResend
} from "../extension/lib/resend.js";

const config = Object.freeze({
  resendApiKey: "re_test_secret_that_must_never_leak",
  fromAddress: "help@audiofetcher.com",
  fromName: "AudioFetcher Support",
  defaultBcc: "archive@example.com"
});

test("prepareResendMessage maps Gmail fields to Resend schema and strips unsafe headers", () => {
  const { message, summary } = prepareResendMessage({
    to: ["Customer@Example.COM", "customer@example.com"],
    cc: ["owner@example.net"],
    bcc: [],
    from: "HELP@AUDIOFETCHER.COM",
    fromName: "Support\r\nBcc: injected@example.com",
    subject: "Hello\r\nX-Injected: bad",
    html: "<p>Hello</p>",
    text: "Hello",
    replyTo: "help@audiofetcher.com",
    headers: {
      References: "<prior@example.com>",
      "X-Trace-ID": "safe-value",
      Authorization: "must-not-survive",
      From: "spoof@example.com",
      "X-Bad": "first\r\nBcc: hidden@example.com"
    },
    attachments: [{
      filename: "proof.txt",
      mimeType: "text/plain",
      contentBase64: "data:text/plain;base64,SGVsbG8="
    }]
  }, config);

  assert.deepEqual(message, {
    from: '"Support Bcc: injected@example.com" <help@audiofetcher.com>',
    to: ["customer@example.com"],
    subject: "Hello X-Injected: bad",
    cc: ["owner@example.net"],
    bcc: ["archive@example.com"],
    html: "<p>Hello</p>",
    text: "Hello",
    reply_to: "help@audiofetcher.com",
    attachments: [{ filename: "proof.txt", content: "SGVsbG8=" }],
    headers: {
      References: "<prior@example.com>",
      "X-Trace-ID": "safe-value"
    }
  });
  assert.deepEqual(
    {
      toCount: summary.toCount,
      ccCount: summary.ccCount,
      bccCount: summary.bccCount,
      attachmentCount: summary.attachmentCount,
      subjectLength: summary.subjectLength
    },
    { toCount: 1, ccCount: 1, bccCount: 1, attachmentCount: 1, subjectLength: 21 }
  );
  assert.ok(summary.messageBytes > 0);
});

test("prepareResendMessage rejects unsafe or incomplete messages", () => {
  const base = {
    to: ["recipient@example.com"],
    from: config.fromAddress,
    subject: "Subject",
    text: "Body"
  };

  const cases = [
    [{ ...base, to: [] }, "MISSING_RECIPIENT", { ...config, defaultBcc: "" }],
    [{ ...base, from: "spoof@example.com" }, "SENDER_MISMATCH", config],
    [{ ...base, html: "", text: "" }, "EMPTY_MESSAGE", config],
    [{ ...base, attachments: [{ filename: "bad.bin", contentBase64: "not base64!" }] }, "INVALID_ATTACHMENT", config],
    [{ ...base, to: ["not-an-email"] }, "INVALID_RECIPIENT", config],
    [base, "INVALID_FROM_ADDRESS", { ...config, fromAddress: "bad" }]
  ];

  for (const [payload, code, caseConfig] of cases) {
    assert.throws(
      () => prepareResendMessage(payload, caseConfig),
      (error) => error instanceof ProviderError && error.code === code,
      code
    );
  }
});

test("sendWithResend posts an idempotent request and reports provider acceptance only", async () => {
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  const message = {
    from: config.fromAddress,
    to: ["recipient@example.com"],
    cc: ["copy@example.net"],
    bcc: ["recipient@example.com", "hidden@example.org"],
    subject: "Test",
    text: "Body"
  };

  const result = await sendWithResend(message, config, {
    fetchImpl,
    idempotencyKey: "gmail-alias-deterministic-test-001"
  });

  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${config.resendApiKey}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["Idempotency-Key"], "gmail-alias-deterministic-test-001");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.deepEqual(JSON.parse(init.body), message);
  assert.equal(init.body.includes(config.resendApiKey), false);
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(result, { accepted: true, mock: false });
  assert.equal("delivered" in result, false);
  assert.equal("queued" in result, false);
  assert.equal("providerMessageId" in result, false);
});

test("sendWithResend creates a fresh valid idempotency key for each send", async () => {
  const keys = [];
  const uuids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002"
  ];
  const message = { from: config.fromAddress, to: ["recipient@example.com"], subject: "Test", text: "Body" };
  const fetchImpl = async (_url, init) => {
    keys.push(init.headers["Idempotency-Key"]);
    return new Response("", { status: 200 });
  };

  for (const uuid of uuids) {
    const result = await sendWithResend(message, config, {
      fetchImpl,
      randomUUID: () => uuid
    });
    assert.deepEqual(result, { accepted: true, mock: false });
  }

  assert.deepEqual(keys, uuids.map((uuid) => `gmail-alias-${uuid}`));
  assert.notEqual(keys[0], keys[1]);
  assert.ok(keys.every((key) => key.length <= 256 && /^[A-Za-z0-9._~-]+$/.test(key)));
});

test("sendWithResend maps documented errors without exposing provider details or API keys", async () => {
  const message = { from: config.fromAddress, to: ["recipient@example.com"], subject: "Test", text: "Body" };
  const cases = [
    [403, { name: "invalid_api_key", message: `bad ${config.resendApiKey}` }, "AUTHENTICATION_FAILED"],
    [403, { name: "validation_error", message: `unverified ${config.resendApiKey}` }, "SENDER_NOT_VERIFIED"],
    [429, { name: "daily_quota_exceeded", message: `quota ${config.resendApiKey}` }, "QUOTA_EXCEEDED"],
    [429, { name: "rate_limit_exceeded", message: `slow ${config.resendApiKey}` }, "RATE_LIMITED"],
    [500, { name: "internal_server_error", message: `failure ${config.resendApiKey}` }, "PROVIDER_UNAVAILABLE"]
  ];

  for (const [status, body, code] of cases) {
    const fetchImpl = async () => new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" }
    });
    await assert.rejects(
      sendWithResend(message, config, { fetchImpl }),
      (error) => (
        error instanceof ProviderError &&
        error.code === code &&
        error.status === status &&
        error.providerCode === body.name &&
        !error.message.includes(config.resendApiKey) &&
        !error.message.includes(body.message)
      ),
      code
    );
  }

  const fetchImpl = async () => { throw new Error(`network request leaked ${config.resendApiKey}`); };
  await assert.rejects(
    sendWithResend(message, config, { fetchImpl }),
    (error) => (
      error instanceof ProviderError &&
      error.code === "NETWORK_ERROR" &&
      !error.message.includes(config.resendApiKey)
    )
  );
});

test("sendWithResend handles unreadable failures, bodyless success, missing keys, invalid idempotency, and timeouts", async () => {
  const message = { from: config.fromAddress, to: ["recipient@example.com"], subject: "Test", text: "Body" };

  await assert.rejects(
    sendWithResend(message, config, {
      fetchImpl: async () => new Response("gateway failure", { status: 502 })
    }),
    (error) => error instanceof ProviderError && error.code === "PROVIDER_UNAVAILABLE" && error.status === 502
  );

  assert.deepEqual(
    await sendWithResend(message, config, {
      fetchImpl: async () => new Response(null, { status: 204 }),
      idempotencyKey: "bodyless-success"
    }),
    { accepted: true, mock: false }
  );

  await assert.rejects(
    sendWithResend(message, { ...config, resendApiKey: "" }, { fetchImpl: async () => { throw new Error("must not run"); } }),
    (error) => error instanceof ProviderError && error.code === "MISSING_API_KEY"
  );

  await assert.rejects(
    sendWithResend(message, config, {
      fetchImpl: async () => { throw new Error("must not run"); },
      idempotencyKey: "bad\r\nAuthorization: secret"
    }),
    (error) => error instanceof ProviderError && error.code === "INVALID_IDEMPOTENCY_KEY"
  );

  await assert.rejects(
    sendWithResend(message, config, {
      fetchImpl: async () => { throw new Error("must not run"); },
      randomUUID: () => { throw new Error(`uuid failed with ${config.resendApiKey}`); }
    }),
    (error) => (
      error instanceof ProviderError &&
      error.code === "IDEMPOTENCY_UNAVAILABLE" &&
      !error.message.includes(config.resendApiKey)
    )
  );

  const neverResponds = (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
    }, { once: true });
  });
  await assert.rejects(
    sendWithResend(message, config, { fetchImpl: neverResponds, timeoutMs: 5 }),
    (error) => error instanceof ProviderError && error.code === "REQUEST_TIMEOUT"
  );
});
