import assert from "node:assert/strict";
import test from "node:test";

import {
  prepareMessage,
  ProviderError,
  sendWithCloudflare
} from "../extension/lib/cloudflare.js";

const config = Object.freeze({
  cloudflareAccountId: "0123456789abcdef0123456789abcdef",
  cloudflareApiToken: "cf-test-token-that-is-long-enough",
  fromAddress: "help@audiofetcher.com",
  fromName: "AudioFetcher Support",
  defaultBcc: "archive@example.com"
});

test("prepareMessage maps Gmail fields to Cloudflare schema and strips unsafe headers", () => {
  const { message, summary } = prepareMessage({
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
    to: ["customer@example.com"],
    from: { address: "help@audiofetcher.com", name: "Support Bcc: injected@example.com" },
    subject: "Hello X-Injected: bad",
    cc: ["owner@example.net"],
    bcc: ["archive@example.com"],
    html: "<p>Hello</p>",
    text: "Hello",
    reply_to: "help@audiofetcher.com",
    attachments: [{
      filename: "proof.txt",
      type: "text/plain",
      content: "SGVsbG8=",
      disposition: "attachment"
    }],
    headers: {
      References: "<prior@example.com>",
      "X-Trace-ID": "safe-value"
    }
  });
  assert.equal(summary.toCount, 1);
  assert.equal(summary.ccCount, 1);
  assert.equal(summary.bccCount, 1);
  assert.equal(summary.attachmentCount, 1);
  assert.equal(summary.subjectLength, "Hello X-Injected: bad".length);
  assert.ok(summary.messageBytes > 0);
});

test("prepareMessage rejects missing recipients, sender mismatch, invalid attachments, and empty bodies", () => {
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
    [{ ...base, to: ["not-an-email"] }, "INVALID_RECIPIENT", config]
  ];

  for (const [payload, code, caseConfig] of cases) {
    assert.throws(
      () => prepareMessage(payload, caseConfig),
      (error) => error instanceof ProviderError && error.code === code,
      code
    );
  }
});

test("sendWithCloudflare sends the exact authenticated POST and normalizes success", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({
      success: true,
      result: {
        delivered: ["recipient@example.com", "invalid"],
        queued: ["later@example.net"],
        permanent_bounces: []
      }
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const message = { to: ["recipient@example.com"], from: config.fromAddress, subject: "Test", text: "Body" };
  const result = await sendWithCloudflare(message, config);

  assert.equal(calls.length, 1);
  const [url, init] = calls[0];
  assert.equal(url, "https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/email/sending/send");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.Authorization, `Bearer ${config.cloudflareApiToken}`);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.credentials, "omit");
  assert.equal(init.cache, "no-store");
  assert.deepEqual(JSON.parse(init.body), message);
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    delivered: ["recipient@example.com"],
    queued: ["later@example.net"],
    permanentBounces: [],
    mock: false
  });
});

test("sendWithCloudflare maps provider, HTTP, malformed-response, and network failures", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const message = { to: ["recipient@example.com"], from: config.fromAddress, subject: "Test", text: "Body" };

  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    errors: [{ code: 10102, message: "provider detail must stay private" }]
  }), { status: 403, headers: { "Content-Type": "application/json" } });
  await assert.rejects(
    sendWithCloudflare(message, config),
    (error) => error instanceof ProviderError && error.code === "PERMISSION_DENIED" && error.status === 403 && error.providerCode === 10102
  );

  // Observed in a live Wrangler OAuth probe: Cloudflare may pair HTTP 401
  // with generic code 10000 instead of the documented auth-specific code.
  globalThis.fetch = async () => new Response(JSON.stringify({
    success: false,
    errors: [{ code: 10000, message: "Authentication error" }]
  }), { status: 401, headers: { "Content-Type": "application/json" } });
  await assert.rejects(
    sendWithCloudflare(message, config),
    (error) => error instanceof ProviderError && error.code === "AUTHENTICATION_FAILED" && error.status === 401 && error.providerCode === 10000
  );

  globalThis.fetch = async () => new Response(JSON.stringify({ success: false, errors: [] }), {
    status: 429,
    headers: { "Content-Type": "application/json" }
  });
  await assert.rejects(
    sendWithCloudflare(message, config),
    (error) => error instanceof ProviderError && error.code === "RATE_LIMITED"
  );

  globalThis.fetch = async () => new Response("not-json", { status: 502 });
  await assert.rejects(
    sendWithCloudflare(message, config),
    (error) => error instanceof ProviderError && error.code === "INVALID_PROVIDER_RESPONSE" && error.status === 502
  );

  globalThis.fetch = async () => { throw new Error(`network failed with ${config.cloudflareApiToken}`); };
  await assert.rejects(
    sendWithCloudflare(message, config),
    (error) => error instanceof ProviderError && error.code === "NETWORK_ERROR" && !error.message.includes(config.cloudflareApiToken)
  );
});

test("sendWithCloudflare does not claim success without any recipient delivery status", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const message = { to: ["recipient@example.com"], from: config.fromAddress, subject: "Test", text: "Body" };

  for (const result of [null, {}, { delivered: [], queued: [], permanent_bounces: [] }]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ success: true, result }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

    await assert.rejects(
      sendWithCloudflare(message, config),
      (error) => error instanceof ProviderError && error.code === "INVALID_PROVIDER_RESPONSE"
    );
  }
});
