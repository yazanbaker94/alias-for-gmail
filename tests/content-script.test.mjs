import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { JSDOM } from "jsdom";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fixtureHtml = await readFile(path.join(import.meta.dirname, "fixtures/gmail-compose.html"), "utf8");
const contentSource = await readFile(path.join(projectRoot, "extension/content.js"), "utf8");
const functionalContentSource = contentSource.replace(
  "if (!event.isTrusted) return;",
  "if (!event.isTrusted && !globalThis.__ALIAS_TEST_TRUSTED_CLICK__) return;"
);

function waitFor(predicate, timeoutMs = 1_000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      let value;
      try { value = predicate(); } catch (error) { reject(error); return; }
      if (value) { resolve(value); return; }
      if (Date.now() - started >= timeoutMs) { reject(new Error("Timed out waiting for content-script state")); return; }
      setTimeout(poll, 5);
    };
    poll();
  });
}

function createHarness({
  sendResponse = { ok: true, result: { accepted: true } },
  configOverrides = {},
  allowSyntheticAliasClick = true
} = {}) {
  const dom = new JSDOM(fixtureHtml, {
    url: "https://mail.google.com/mail/u/0/#inbox?compose=new",
    pretendToBeVisual: true,
    runScripts: "dangerously"
  });
  const messages = [];
  const observers = [];
  const animationFrames = new Set();
  const config = {
    enabled: true,
    mockMode: false,
    fromAddress: "help@audiofetcher.com",
    fromName: "AudioFetcher Support",
    defaultBcc: "copy@example.net",
    ...configOverrides
  };

  dom.window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(message, callback) {
        messages.push(structuredClone(message));
        const response = message?.type === "GET_SAFE_CONFIG"
          ? { ok: true, config: structuredClone(config) }
          : sendResponse;
        queueMicrotask(() => callback(response));
      }
    }
  };
  dom.window.__ALIAS_TEST_TRUSTED_CLICK__ = allowSyntheticAliasClick;

  const NativeMutationObserver = dom.window.MutationObserver;
  dom.window.MutationObserver = class TrackedMutationObserver extends NativeMutationObserver {
    constructor(callback) {
      super(callback);
      observers.push(this);
    }
  };
  const nativeRequestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  const nativeCancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  dom.window.requestAnimationFrame = (callback) => {
    const id = nativeRequestAnimationFrame((timestamp) => {
      animationFrames.delete(id);
      callback(timestamp);
    });
    animationFrames.add(id);
    return id;
  };

  dom.window.eval(functionalContentSource);
  const close = () => {
    observers.forEach((observer) => observer.disconnect());
    animationFrames.forEach((id) => nativeCancelAnimationFrame(id));
    animationFrames.clear();
    dom.window.close();
  };
  return { dom, messages, config, close };
}

test("synthetic page clicks cannot trigger an alias send", async (t) => {
  const harness = createHarness({ allowSyntheticAliasClick: false });
  t.after(harness.close);

  const button = await waitFor(() => harness.dom.window.document.querySelector(".gmail-alias-send__button"));
  button.click();
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(harness.messages.some((message) => message.type === "SEND_VIA_ALIAS"), false);
  assert.equal(button.disabled, false);
});

test("content script injects one explicit alias button and extracts a realistic Gmail draft", async (t) => {
  const harness = createHarness();
  t.after(harness.close);

  const button = await waitFor(() => harness.dom.window.document.querySelector(".gmail-alias-send__button"));
  assert.equal(button.textContent, "Send via help@audiofetcher.com");
  assert.equal(harness.dom.window.document.querySelectorAll(".gmail-alias-send").length, 1);
  assert.deepEqual(harness.messages[0], { type: "GET_SAFE_CONFIG" });
  assert.equal("storage" in harness.dom.window.chrome, false);

  button.click();
  const sendMessage = await waitFor(() => harness.messages.find((message) => message.type === "SEND_VIA_ALIAS"));

  assert.deepEqual(sendMessage.payload, {
    to: ["bob@example.net", "alice@example.com"],
    cc: ["carol@example.org"],
    bcc: ["audit@example.com", "copy@example.net"],
    from: "help@audiofetcher.com",
    fromName: "AudioFetcher Support",
    subject: "A realistic Gmail subject",
    html: "<p>Hello <strong>team</strong>,</p><p>Second line.</p>",
    text: "Hello team,Second line.",
    replyTo: "help@audiofetcher.com",
    headers: {},
    attachments: []
  });

  const status = await waitFor(() => {
    const candidate = harness.dom.window.document.querySelector(".gmail-alias-send__status");
    return candidate?.textContent.includes("Gmail kept this draft") ? candidate : null;
  });
  assert.match(status.textContent, /Sent via alias/);
  assert.equal(button.disabled, true);
  assert.equal(harness.dom.window.document.querySelector('[aria-label^="Send"]'), harness.dom.window.document.querySelector(".aoO"));
});

test("alias click stays outside Gmail's delegated native-send group", async (t) => {
  const harness = createHarness();
  t.after(harness.close);
  const document = harness.dom.window.document;
  const gmailSendGroup = document.querySelector(".dC");
  let nativeSendEvents = 0;
  gmailSendGroup.addEventListener("click", () => { nativeSendEvents += 1; }, true);

  const button = await waitFor(() => document.querySelector(".gmail-alias-send__button"));
  assert.equal(gmailSendGroup.contains(button), false);
  assert.equal(gmailSendGroup.nextElementSibling, document.querySelector(".gmail-alias-send"));

  button.click();
  await waitFor(() => harness.messages.some((message) => message.type === "SEND_VIA_ALIAS"));
  assert.equal(nativeSendEvents, 0);
  assert.equal(document.querySelector("#compose").isConnected, true);
});

test("repeated Gmail mutations do not duplicate the injected UI", async (t) => {
  const harness = createHarness();
  t.after(harness.close);
  await waitFor(() => harness.dom.window.document.querySelector(".gmail-alias-send"));

  const compose = harness.dom.window.document.querySelector("#compose");
  for (let index = 0; index < 8; index += 1) {
    const node = harness.dom.window.document.createElement("span");
    node.textContent = `dynamic-${index}`;
    compose.append(node);
  }

  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(compose.querySelectorAll(".gmail-alias-send").length, 1);
  assert.equal(compose.querySelectorAll(".gmail-alias-send__button").length, 1);
});

test("safe runtime configuration controls injection without content-script storage access", async (t) => {
  const disabledHarness = createHarness({ configOverrides: { enabled: false } });
  t.after(disabledHarness.close);

  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(disabledHarness.dom.window.document.querySelector(".gmail-alias-send"), null);
  assert.deepEqual(disabledHarness.messages, [{ type: "GET_SAFE_CONFIG" }]);
  assert.equal("storage" in disabledHarness.dom.window.chrome, false);

  const enabledHarness = createHarness();
  t.after(enabledHarness.close);
  const button = await waitFor(() => enabledHarness.dom.window.document.querySelector(".gmail-alias-send__button"));

  assert.equal(button.textContent, "Send via help@audiofetcher.com");
  assert.equal(enabledHarness.dom.window.document.querySelectorAll(".gmail-alias-send").length, 1);
});

test("failed background response is shown without destroying or sending Gmail's draft", async (t) => {
  const harness = createHarness({
    sendResponse: { ok: false, error: { code: "PERMISSION_DENIED", message: "Cloudflare denied this send request." } }
  });
  t.after(harness.close);
  const button = await waitFor(() => harness.dom.window.document.querySelector(".gmail-alias-send__button"));
  const originalBody = harness.dom.window.document.querySelector('[aria-label="Message Body"]').innerHTML;

  button.click();
  const status = await waitFor(() => {
    const candidate = harness.dom.window.document.querySelector(".gmail-alias-send__status");
    return candidate?.textContent.includes("denied") ? candidate : null;
  });

  assert.equal(status.textContent, "Cloudflare denied this send request.");
  assert.equal(button.disabled, false);
  assert.equal(harness.dom.window.document.querySelector('[aria-label="Message Body"]').innerHTML, originalBody);
  assert.equal(harness.dom.window.document.querySelector("#compose").isConnected, true);
});
