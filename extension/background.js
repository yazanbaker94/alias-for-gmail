import {
  ConfigError,
  DATA_USE_CONSENT_VERSION,
  getConfig,
  initializeConfig,
  validateConfig
} from "./lib/config.js";
import {
  ProviderError,
  prepareMessage,
  sendWithCloudflare
} from "./lib/cloudflare.js";
import {
  prepareResendMessage,
  sendWithResend
} from "./lib/resend.js";


const LAST_SEND_KEY = "lastSendSummary";

const storageBoundaryReady = establishStorageBoundary().then(
  () => true,
  () => false
);

async function establishStorageBoundary() {
  if (
    typeof chrome.storage?.local?.setAccessLevel !== "function" ||
    typeof chrome.storage?.session?.setAccessLevel !== "function"
  ) {
    throw new Error("Trusted-context storage access is unavailable.");
  }

  await Promise.all([
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" })
  ]);
}

chrome.runtime.onInstalled.addListener((details) => {
  configureUninstallUrl();
  storageBoundaryReady.then((ready) => {
    if (!ready) return;
    initializeConfig().catch(() => {
      // Installation can continue; the options page will surface missing configuration.
    });
  });

  if (details?.reason === "install") {
    chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onStartup?.addListener?.(configureUninstallUrl);
configureUninstallUrl();

function configureUninstallUrl() {
  if (typeof chrome.runtime.setUninstallURL !== "function" || typeof chrome.runtime.getManifest !== "function") return;
  Promise.resolve(chrome.runtime.setUninstallURL("")).catch(() => {});
}

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  handleMessage(request, sender)
    .then(sendResponse)
    .catch((error) => sendResponse(failureResponse(error)));
  return true;
});

async function handleMessage(request, sender) {
  if (!(await storageBoundaryReady)) {
    throw new ProviderError(
      "SECURE_STORAGE_UNAVAILABLE",
      "The extension could not secure its local settings. Reload the extension and try again."
    );
  }

  if (!request || typeof request !== "object") {
    throw new ProviderError("INVALID_REQUEST", "The extension received an invalid request.");
  }

  if (["GET_DIAGNOSTICS", "CLEAR_DIAGNOSTICS"].includes(request.type)) assertOptionsSender(sender);
  if (request.type === "SEND_VIA_ALIAS") {
    assertGmailContentSender(sender);
  }

  switch (request.type) {
    case "GET_SAFE_CONFIG": {
      const config = await getConfig();
      return {
        ok: true,
        config: {
          enabled: config.enabled && config.dataUseConsentVersion >= DATA_USE_CONSENT_VERSION,
          fromAddress: config.fromAddress,
          fromName: config.fromName,
          defaultBcc: config.defaultBcc
        }
      };
    }

    case "SEND_VIA_ALIAS":
      return handleSend(request.payload);

    case "GET_DIAGNOSTICS": {
      const stored = await chrome.storage.local.get(LAST_SEND_KEY);
      return { ok: true, summary: stored[LAST_SEND_KEY] || null };
    }

    case "CLEAR_DIAGNOSTICS":
      await chrome.storage.local.remove(LAST_SEND_KEY);
      return { ok: true };

    default:
      throw new ProviderError("UNKNOWN_REQUEST", "The extension does not recognize this request.");
  }
}

async function handleSend(payload) {
  let config;
  let prepared;

  try {
    config = validateConfig(await getConfig(), { requireReady: true });
    prepared = config.provider === "resend"
      ? prepareResendMessage(payload, config)
      : prepareMessage(payload, config);

    let result;
    if (config.mockMode) {
      result = { delivered: [], queued: [], permanentBounces: [], mock: true };
    } else if (config.provider === "resend") {
      result = await sendWithResend(prepared.message, config);
    } else {
      result = await sendWithCloudflare(prepared.message, config);
    }

    const resultCounts = countProviderResult(result);
    const accepted = (
      result?.accepted === true ||
      result?.mock === true ||
      resultCounts.deliveredCount > 0 ||
      resultCounts.queuedCount > 0
    );
    if (!accepted) {
      throw new ProviderError(
        "INVALID_PROVIDER_RESPONSE",
        "The sending provider did not confirm that it accepted this email."
      );
    }

    await tryStoreSummary({
      ok: true,
      mock: config.mockMode,
      provider: config.provider,
      sender: redactEmail(config.fromAddress),
      ...prepared.summary,
      ...resultCounts
    });

    return {
      ok: true,
      result: {
        accepted: true,
        mock: Boolean(result?.mock)
      }
    };
  } catch (error) {
    const safeError = publicError(error);
    await tryStoreSummary({
      ok: false,
      mock: Boolean(config?.mockMode),
      provider: config?.provider,
      sender: redactEmail(config?.fromAddress || payload?.from || ""),
      ...(prepared?.summary || safePayloadCounts(payload)),
      errorCode: safeError.code
    });
    throw error;
  }
}

async function storeSummary(value) {
  const summary = {
    timestamp: new Date().toISOString(),
    ok: Boolean(value.ok),
    mock: Boolean(value.mock),
    provider: ["cloudflare", "resend"].includes(value.provider) ? value.provider : "cloudflare",
    sender: typeof value.sender === "string" ? value.sender : "",
    toCount: safeCount(value.toCount),
    ccCount: safeCount(value.ccCount),
    bccCount: safeCount(value.bccCount),
    attachmentCount: safeCount(value.attachmentCount),
    subjectLength: safeCount(value.subjectLength),
    messageBytes: safeCount(value.messageBytes),
    deliveredCount: safeCount(value.deliveredCount),
    queuedCount: safeCount(value.queuedCount),
    permanentBounceCount: safeCount(value.permanentBounceCount)
  };

  if (!summary.ok && typeof value.errorCode === "string") {
    summary.errorCode = value.errorCode.slice(0, 100);
  }

  await chrome.storage.local.set({ [LAST_SEND_KEY]: summary });
}

async function tryStoreSummary(value) {
  try {
    await storeSummary(value);
  } catch {
    // Diagnostics must never change whether Gmail reports the email as sent or failed.
  }
}

function failureResponse(error) {
  return { ok: false, error: publicError(error) };
}

function publicError(error) {
  if (
    error instanceof ConfigError ||
    error instanceof ProviderError
  ) {
    return { code: error.code, message: error.message };
  }
  return { code: "INTERNAL_ERROR", message: "The extension could not complete this request." };
}

function assertOptionsSender(sender) {
  const extensionId = chrome.runtime.id;
  const optionsUrl = chrome.runtime.getURL("options.html");
  const senderUrl = sender?.url || sender?.documentUrl || "";
  if (!extensionId || sender?.id !== extensionId || senderUrl !== optionsUrl) {
    throw new ProviderError("FORBIDDEN_REQUEST", "This action is available only from extension settings.");
  }
}

function assertGmailContentSender(sender) {
  const extensionId = chrome.runtime.id;
  const senderUrl = sender?.url || sender?.documentUrl || "";
  let parsed;
  try {
    parsed = new URL(senderUrl);
  } catch {
    throw new ProviderError("FORBIDDEN_REQUEST", "Alias sends are available only from Gmail.");
  }
  if (
    !extensionId ||
    sender?.id !== extensionId ||
    parsed.protocol !== "https:" ||
    parsed.hostname !== "mail.google.com" ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    !Number.isInteger(sender?.tab?.id) ||
    sender.tab.id < 0 ||
    sender?.frameId !== 0
  ) {
    throw new ProviderError("FORBIDDEN_REQUEST", "Alias sends are available only from Gmail.");
  }
}

function safePayloadCounts(payload) {
  return {
    toCount: Array.isArray(payload?.to) ? payload.to.length : 0,
    ccCount: Array.isArray(payload?.cc) ? payload.cc.length : 0,
    bccCount: Array.isArray(payload?.bcc) ? payload.bcc.length : 0,
    attachmentCount: Array.isArray(payload?.attachments) ? payload.attachments.length : 0,
    subjectLength: typeof payload?.subject === "string" ? payload.subject.length : 0,
    messageBytes: 0
  };
}

function countProviderResult(result) {
  return {
    deliveredCount: Array.isArray(result?.delivered)
      ? result.delivered.length
      : safeCount(result?.deliveredCount),
    queuedCount: Array.isArray(result?.queued)
      ? result.queued.length
      : safeCount(result?.queuedCount),
    permanentBounceCount: Array.isArray(result?.permanentBounces)
      ? result.permanentBounces.length
      : safeCount(result?.permanentBounceCount)
  };
}

function redactEmail(value) {
  if (typeof value !== "string" || !value.includes("@")) return "";
  const [local, domain] = value.toLowerCase().split("@");
  if (!local || !domain) return "";
  return `${local.slice(0, 1)}***@${domain}`;
}

function safeCount(value) {
  return Number.isFinite(value) ? Math.max(0, Math.min(Math.floor(value), 10_000_000)) : 0;
}
