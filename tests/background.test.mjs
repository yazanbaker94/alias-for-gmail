import assert from "node:assert/strict";
import test from "node:test";

function createChromeStub(initialStorage = {}) {
  const storage = { ...initialStorage };
  const sessionStorage = {};
  const listeners = {};
  const accessLevelCalls = [];
  const localSetCalls = [];
  const uninstallUrls = [];
  const openedTabs = [];
  let optionsOpenCount = 0;
  const event = (name) => ({ addListener(listener) { listeners[name] = listener; } });

  return {
    storage,
    listeners,
    accessLevelCalls,
    localSetCalls,
    uninstallUrls,
    openedTabs,
    get optionsOpenCount() { return optionsOpenCount; },
    chrome: {
      runtime: {
        id: "test-extension-id",
        getURL(path) { return `chrome-extension://test-extension-id/${path}`; },
        getManifest() { return { version: "test-version" }; },
        setUninstallURL(url) { uninstallUrls.push(url); },
        onInstalled: event("onInstalled"),
        onStartup: event("onStartup"),
        onMessage: event("onMessage"),
        openOptionsPage() { optionsOpenCount += 1; }
      },
      action: { onClicked: event("onClicked") },
      tabs: {
        async create(options) {
          openedTabs.push(structuredClone(options));
          return { id: openedTabs.length, ...options };
        }
      },
      storage: {
        local: {
          async setAccessLevel(value) { accessLevelCalls.push(structuredClone(value)); },
          async get(keys) {
            if (typeof keys === "string") return { [keys]: storage[keys] };
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.filter((key) => key in storage).map((key) => [key, storage[key]]));
            }
            return { ...storage };
          },
          async set(values) {
            localSetCalls.push(structuredClone(values));
            Object.assign(storage, values);
          },
          async remove(key) { delete storage[key]; }
        },
        session: {
          async setAccessLevel(value) { accessLevelCalls.push(structuredClone(value)); },
          async get(key) { return { [key]: sessionStorage[key] }; },
          async set(values) { Object.assign(sessionStorage, values); },
          async remove(key) { delete sessionStorage[key]; }
        }
      }
    }
  };
}

function dispatchMessage(listener, request, sender = {}) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Background message timed out")), 1_000);
    const keepsChannelOpen = listener(request, sender, (response) => {
      clearTimeout(timeout);
      resolve(response);
    });
    assert.equal(keepsChannelOpen, true);
  });
}

const gmailSender = {
  id: "test-extension-id",
  url: "https://mail.google.com/mail/u/0/#inbox",
  tab: { id: 17, url: "https://mail.google.com/mail/u/0/#inbox" },
  frameId: 0
};

test("background routes a Resend selection only to Resend and redacts its key", async (t) => {
  const resendApiKey = "re_test_secret_that_must_never_leak";
  const stub = createChromeStub({
    enabled: true,
    mockMode: false,
    dataUseConsentVersion: 2,
    provider: "resend",
    cloudflareAccountId: "",
    cloudflareApiToken: "",
    resendApiKey,
    fromAddress: "help@example.com",
    fromName: "Example Support",
    defaultBcc: ""
  });
  const calls = [];
  const originalChrome = globalThis.chrome;
  const originalFetch = globalThis.fetch;
  globalThis.chrome = stub.chrome;
  globalThis.fetch = async (...args) => {
    calls.push(args);
    return new Response(JSON.stringify({ id: "resend-message-id" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  };
  t.after(() => {
    globalThis.chrome = originalChrome;
    globalThis.fetch = originalFetch;
  });

  await import(`../extension/background.js?resend-routing=${Date.now()}`);
  const response = await dispatchMessage(stub.listeners.onMessage, {
    type: "SEND_VIA_ALIAS",
    payload: {
      to: ["recipient@example.com"],
      cc: [],
      bcc: [],
      from: "help@example.com",
      fromName: "Example Support",
      subject: "Provider routing test",
      html: "<p>Body</p>",
      text: "Body",
      replyTo: "help@example.com",
      headers: {},
      attachments: []
    }
  }, gmailSender);

  assert.equal(response.ok, true);
  assert.deepEqual(response, { ok: true, result: { accepted: true, mock: false } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://api.resend.com/emails");
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${resendApiKey}`);
  assert.equal(stub.storage.lastSendSummary.provider, "resend");
  assert.ok(Number.isInteger(stub.storage.lastSendSummary.queuedCount));
  assert.ok(stub.storage.lastSendSummary.queuedCount >= 0);
  assert.equal(JSON.stringify(stub.storage.lastSendSummary).includes(resendApiKey), false);
  assert.equal(JSON.stringify(response).includes(resendApiKey), false);
  assert.equal(JSON.stringify(response).includes("recipient@example.com"), false);
  assert.equal(JSON.stringify(response).includes("resend-message-id"), false);
});
