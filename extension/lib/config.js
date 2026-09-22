export const CONFIG_KEYS = Object.freeze([
  "enabled",
  "gmailIntegrationOptOut",
  "mockMode",
  "dataUseConsentVersion",
  "provider",
  "cloudflareAccountId",
  "cloudflareApiToken",
  "resendApiKey",
  "fromAddress",
  "fromName",
  "defaultBcc"
]);

export const DATA_USE_CONSENT_VERSION = 2;
export const ALLOW_INTERNAL_MOCK_MODE = false;

export const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  gmailIntegrationOptOut: false,
  mockMode: false,
  dataUseConsentVersion: 0,
  provider: "resend",
  cloudflareAccountId: "",
  cloudflareApiToken: "",
  resendApiKey: "",
  fromAddress: "",
  fromName: "",
  defaultBcc: ""
});

const EMAIL_PATTERN = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const PROVIDERS = new Set(["cloudflare", "resend"]);

export class ConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export function isValidEmail(value) {
  return (
    typeof value === "string" &&
    value.length > 3 &&
    value.length <= 254 &&
    !/[\r\n]/.test(value) &&
    EMAIL_PATTERN.test(value)
  );
}

export function normalizeConfig(value = {}) {
  const rawProvider = cleanString(value.provider, 32).toLowerCase();
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_CONFIG.enabled,
    gmailIntegrationOptOut: value.gmailIntegrationOptOut === true,
    mockMode: ALLOW_INTERNAL_MOCK_MODE && value.mockMode === true,
    dataUseConsentVersion: Number.isInteger(value.dataUseConsentVersion)
      ? Math.max(0, value.dataUseConsentVersion)
      : DEFAULT_CONFIG.dataUseConsentVersion,
    provider: rawProvider || inferMissingProvider(value),
    cloudflareAccountId: cleanString(value.cloudflareAccountId, 100),
    cloudflareApiToken: cleanString(value.cloudflareApiToken, 500),
    resendApiKey: cleanString(value.resendApiKey, 500),
    fromAddress: cleanString(value.fromAddress, 254).toLowerCase(),
    fromName: cleanHeaderValue(value.fromName, 200),
    defaultBcc: cleanString(value.defaultBcc, 254).toLowerCase()
  };
}

export function validateConfig(value, { requireReady = false } = {}) {
  const config = normalizeConfig(value);

  if (!PROVIDERS.has(config.provider)) {
    throw new ConfigError("INVALID_PROVIDER", "Choose Cloudflare or Resend as the sending provider.");
  }

  if (config.fromAddress && !isValidEmail(config.fromAddress)) {
    throw new ConfigError("INVALID_FROM_ADDRESS", "Enter a valid sender email address.");
  }

  if (config.defaultBcc && !isValidEmail(config.defaultBcc)) {
    throw new ConfigError("INVALID_DEFAULT_BCC", "Enter a valid default Bcc address.");
  }

  if (
    config.provider === "cloudflare" &&
    config.cloudflareAccountId &&
    !/^[a-f0-9]{32}$/i.test(config.cloudflareAccountId)
  ) {
    throw new ConfigError(
      "INVALID_ACCOUNT_ID",
      "The Cloudflare account ID must be the 32-character ID shown in Cloudflare."
    );
  }

  if (config.provider === "cloudflare" && config.cloudflareApiToken && config.cloudflareApiToken.length < 20) {
    throw new ConfigError("INVALID_API_TOKEN", "The Cloudflare API token looks incomplete.");
  }

  if (
    config.provider === "resend" &&
    config.resendApiKey &&
    (config.resendApiKey.length < 20 || !config.resendApiKey.startsWith("re_"))
  ) {
    throw new ConfigError("INVALID_RESEND_API_KEY", "The Resend API key looks incomplete.");
  }

  if (requireReady) {
    if (config.dataUseConsentVersion < DATA_USE_CONSENT_VERSION) {
      throw new ConfigError(
        "DATA_USE_CONSENT_REQUIRED",
        "Open extension settings and accept the draft-data disclosure before using Send via alias."
      );
    }

    if (!config.enabled) {
      throw new ConfigError("EXTENSION_DISABLED", "Sending via alias is disabled in extension settings.");
    }

    if (!config.fromAddress) {
      throw new ConfigError("MISSING_FROM_ADDRESS", "Add the alias address in extension settings first.");
    }

    if (!config.mockMode && config.provider === "cloudflare") {
      if (!config.cloudflareAccountId) {
        throw new ConfigError("MISSING_ACCOUNT_ID", "Add your Cloudflare account ID in extension settings.");
      }

      if (!config.cloudflareApiToken) {
        throw new ConfigError("MISSING_API_TOKEN", "Add your Cloudflare Email Sending API token in extension settings.");
      }
    }

    if (!config.mockMode && config.provider === "resend" && !config.resendApiKey) {
      throw new ConfigError("MISSING_RESEND_API_KEY", "Add your Resend sending-only API key in extension settings.");
    }
  }

  return config;
}

export async function getConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEYS);
  return normalizeConfig(stored);
}

export async function saveConfig(value) {
  const stored = await chrome.storage.local.get(CONFIG_KEYS);
  const config = validateConfig({ ...stored, ...(value || {}) });
  await chrome.storage.local.set(config);
  return config;
}

export async function initializeConfig() {
  const stored = await chrome.storage.local.get(CONFIG_KEYS);
  const missing = {};

  for (const key of CONFIG_KEYS) {
    if (typeof stored[key] === "undefined") {
      missing[key] = key === "provider" ? inferMissingProvider(stored) : DEFAULT_CONFIG[key];
    }
  }

  if (!ALLOW_INTERNAL_MOCK_MODE && stored.mockMode !== false) {
    missing.mockMode = false;
  }

  if (Object.keys(missing).length > 0) {
    await chrome.storage.local.set(missing);
  }
}

function inferMissingProvider(value) {
  // Provider was added after the original Cloudflare-only build. Preserve that
  // route when an older profile has Cloudflare credentials but no provider
  // field; otherwise give a truly fresh install the tested Resend path.
  if (cleanString(value?.cloudflareAccountId, 100) || cleanString(value?.cloudflareApiToken, 500)) {
    return "cloudflare";
  }
  if (cleanString(value?.resendApiKey, 500)) {
    return "resend";
  }
  return DEFAULT_CONFIG.provider;
}

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanHeaderValue(value, maxLength) {
  return cleanString(value, maxLength).replace(/[\r\n]+/g, " ");
}
