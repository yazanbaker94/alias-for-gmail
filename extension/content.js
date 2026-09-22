(() => {
  "use strict";

  const MESSAGE_TYPE = "SEND_VIA_ALIAS";
  const UI_CLASS = "gmail-alias-send";
  // The provider adapter caps the complete JSON message at 5 MiB. Base64 adds
  // roughly 33%, so this leaves room for the HTML/text body and JSON framing.
  const MAX_ATTACHMENT_BYTES = 3 * 1024 * 1024;
  const COMPOSE_BODY_SELECTORS = [
    '[contenteditable="true"][aria-label="Message Body"]',
    'div[contenteditable="true"][role="textbox"].Am',
    'div[contenteditable="true"][role="textbox"][g_editable="true"]'
  ];
  const COMPOSE_BODY_SELECTOR = COMPOSE_BODY_SELECTORS.join(",");
  const NATIVE_SEND_SELECTORS = [
    '.aoO[role="button"]',
    '[role="button"][data-tooltip^="Send"]',
    '[role="button"][aria-label^="Send"]',
    '[role="button"][title^="Send"]'
  ];
  const NATIVE_SEND_SELECTOR = NATIVE_SEND_SELECTORS.join(",");

  /** @type {WeakMap<Element, ComposeState>} */
  const composeStates = new WeakMap();
  /** @type {Set<Element>} */
  const knownComposeRoots = new Set();
  /** @type {WeakMap<HTMLInputElement, File[]>} */
  const filesByInput = new WeakMap();

  let lastFocusedCompose = null;
  let scanQueued = false;
  let statusSequence = 0;
  let cachedConfig = {
    enabled: false,
    fromAddress: "",
    fromName: "",
    defaultBcc: ""
  };

  /**
   * @typedef {Object} ComposeState
   * @property {Element} root
   * @property {HTMLSpanElement|null} ui
   * @property {HTMLButtonElement|null} button
   * @property {HTMLSpanElement|null} status
   * @property {File[]} files
   * @property {"idle"|"sending"|"success"|"error"} phase
   * @property {string} message
   * @property {boolean} rootListenerAttached
   */

  function isVisible(element) {
    if (!(element instanceof Element) || !element.isConnected) {
      return false;
    }

    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  }

  function findNativeSend(root) {
    return [...root.querySelectorAll(NATIVE_SEND_SELECTOR)].find((element) => {
      if (!isVisible(element) || element.closest(`.${UI_CLASS}`)) {
        return false;
      }

      const label = [
        element.getAttribute("aria-label"),
        element.getAttribute("data-tooltip"),
        element.getAttribute("title")
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      return element.classList.contains("aoO") || !label.includes("schedule");
    }) || null;
  }

  function findComposeRoot(node) {
    if (!(node instanceof Element)) {
      return null;
    }

    const dialog = node.closest('div[role="dialog"]');
    if (dialog && dialog.querySelector(COMPOSE_BODY_SELECTOR)) {
      return dialog;
    }

    const gmailCompose = node.closest(".M9");
    if (gmailCompose && gmailCompose.querySelector(COMPOSE_BODY_SELECTOR)) {
      return gmailCompose;
    }

    // Inline replies do not always use role=dialog. Walk only as far as the
    // smallest ancestor that owns both this editor and a Gmail Send control.
    let current = node;
    while (current && current !== document.body) {
      if (current.querySelector(COMPOSE_BODY_SELECTOR) && findNativeSend(current)) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  function getOrCreateState(root) {
    let state = composeStates.get(root);
    if (!state) {
      state = {
        root,
        ui: null,
        button: null,
        status: null,
        files: [],
        phase: "idle",
        message: "",
        rootListenerAttached: false
      };
      composeStates.set(root, state);
      knownComposeRoots.add(root);
    }
    return state;
  }

  function scheduleScan() {
    if (scanQueued) {
      return;
    }

    scanQueued = true;
    requestAnimationFrame(() => {
      scanQueued = false;
      scanComposeWindows();
    });
  }

  function scanComposeWindows() {
    if (cachedConfig?.enabled === false) {
      document.querySelectorAll(`.${UI_CLASS}`).forEach((ui) => ui.remove());
      return;
    }

    const roots = new Set();

    document.querySelectorAll('div[role="dialog"]').forEach((dialog) => {
      if (dialog.querySelector(COMPOSE_BODY_SELECTOR)) {
        roots.add(dialog);
      }
    });

    document.querySelectorAll(COMPOSE_BODY_SELECTOR).forEach((body) => {
      const root = findComposeRoot(body);
      if (root) {
        roots.add(root);
      }
    });

    roots.forEach(injectComposeUi);

    for (const root of knownComposeRoots) {
      if (!root.isConnected) {
        knownComposeRoots.delete(root);
      }
    }
  }

  function injectComposeUi(root) {
    const nativeSend = findNativeSend(root);
    if (!nativeSend) {
      return;
    }

    const state = getOrCreateState(root);
    if (state.ui?.isConnected) {
      return;
    }

    // Gmail can preserve injected DOM across an extension reload. Remove that
    // inert copy before attaching this content script's live event handlers.
    root.querySelectorAll(`.${UI_CLASS}`).forEach((existingUi) => existingUi.remove());

    const wrapper = document.createElement("span");
    wrapper.className = UI_CLASS;
    wrapper.dataset.state = state.phase;

    const button = document.createElement("button");
    button.type = "button";
    button.className = `${UI_CLASS}__button`;
    renderButtonContent(button, "idle", "");
    button.setAttribute("aria-label", "Send this message through your configured alias");

    const status = document.createElement("span");
    status.className = `${UI_CLASS}__status`;
    status.id = `gmail-alias-send-status-${++statusSequence}`;
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.setAttribute("aria-atomic", "true");
    button.setAttribute("aria-describedby", status.id);

    wrapper.append(button, status);

    // Gmail's blue Send button and its dropdown live inside one delegated
    // click target (`.dC`). Putting our button inside that target can make a
    // single alias click also run Gmail's native send handler. Keep the Alias
    // control beside the complete Gmail send group instead.
    const gmailSendGroup = nativeSend.closest(".dC");
    const insertionAnchor = gmailSendGroup && gmailSendGroup !== root && root.contains(gmailSendGroup)
      ? gmailSendGroup
      : nativeSend;
    insertionAnchor.insertAdjacentElement("afterend", wrapper);

    state.ui = wrapper;
    state.button = button;
    state.status = status;

    button.addEventListener("click", (event) => {
      // This handler belongs only to our explicit button. Gmail's native Send
      // control and keyboard shortcuts are deliberately untouched.
      if (!event.isTrusted) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      void sendViaAlias(state);
    }, true);

    if (!state.rootListenerAttached) {
      root.addEventListener("input", (event) => {
        if (state.phase === "success" && !event.target.closest?.(`.${UI_CLASS}`)) {
          resetAfterEdit(state);
        }
      });
      state.rootListenerAttached = true;
    }

    setUiState(state, state.phase, state.message);
    refreshButtonFromConfig(state);
  }

  function renderButtonContent(button, phase, message = "") {
    const fromAddress = cachedConfig?.fromAddress?.trim();
    const title = document.createElement("span");
    title.className = `${UI_CLASS}__button-title`;

    const detail = document.createElement("span");
    detail.className = `${UI_CLASS}__button-detail`;

    if (phase === "sending") {
      title.textContent = "Sending securely…";
      detail.textContent = message || "This may take a few seconds.";
    } else if (phase === "success") {
      title.textContent = "Sent via ";
      detail.textContent = fromAddress || "your alias";
    } else if (phase === "error") {
      title.textContent = "Failed to send.";
      detail.textContent = message || "Choose this button to try again.";
    } else if (fromAddress) {
      title.textContent = "Send via ";
      detail.textContent = fromAddress;
    } else {
      title.textContent = "Send via alias";
      detail.textContent = "Configure your sender first.";
    }

    button.replaceChildren(title, detail);
  }

  function refreshButtonFromConfig(state) {
    if (!state.button || state.phase !== "idle") {
      return;
    }
    renderButtonContent(state.button, "idle", "");
    const fromAddress = cachedConfig?.fromAddress?.trim();
    state.button.title = fromAddress
      ? `Send externally as ${fromAddress}. Gmail's draft will remain open.`
      : "Configure an alias in the extension before sending.";
  }

  function setUiState(state, phase, message) {
    state.phase = phase;
    state.message = message || "";
    if (!state.ui || !state.button || !state.status) {
      return;
    }

    state.ui.dataset.state = phase;
    state.ui.title = state.message;
    state.status.textContent = state.message;
    state.status.setAttribute("aria-live", phase === "error" ? "assertive" : "polite");

    if (phase === "sending") {
      state.button.disabled = true;
      renderButtonContent(state.button, "sending", state.message);
    } else if (phase === "success") {
      state.button.disabled = true;
      renderButtonContent(state.button, "success", state.message);
    } else if (phase === "error") {
      state.button.disabled = false;
      renderButtonContent(state.button, "error", state.message);
    } else {
      state.button.disabled = false;
      renderButtonContent(state.button, "idle", state.message);
    }
  }

  function resetAfterEdit(state) {
    setUiState(state, "idle", "Message changed. Review it before sending again.");
  }

  async function getConfig() {
    const response = await runtimeSendMessage({ type: "GET_SAFE_CONFIG" });
    if (!response?.ok || !response.config || typeof response.config !== "object") {
      throw new Error("The extension could not load its safe Gmail settings.");
    }

    const config = {
      enabled: response.config.enabled === true,
      fromAddress: typeof response.config.fromAddress === "string" ? response.config.fromAddress : "",
      fromName: typeof response.config.fromName === "string" ? response.config.fromName : "",
      defaultBcc: typeof response.config.defaultBcc === "string" ? response.config.defaultBcc : ""
    };
    cachedConfig = config;
    return config;
  }

  function normalizeAddress(address) {
    return address.trim().replace(/^mailto:/i, "");
  }

  function extractEmailAddresses(value) {
    if (!value || typeof value !== "string") {
      return [];
    }

    const matches = value.match(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]{0,61}[A-Z0-9])?)+/gi) || [];
    return matches.map(normalizeAddress);
  }

  function uniqueAddresses(addresses) {
    const seen = new Set();
    return addresses.filter((address) => {
      const key = address.toLowerCase();
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
  }

  function recipientControls(root, kind) {
    const label = kind === "to" ? "To" : kind === "cc" ? "Cc" : "Bcc";
    const selectors = [
      `input[name="${kind}"]`,
      `textarea[name="${kind}"]`,
      `input[aria-label="${label} recipients"]`,
      `textarea[aria-label="${label} recipients"]`,
      `[contenteditable="true"][aria-label="${label} recipients"]`
    ];
    return [...root.querySelectorAll(selectors.join(","))];
  }

  function recipientScope(control, root, kind) {
    const gmailField = control.closest(".aoD");
    if (gmailField && root.contains(gmailField)) {
      return gmailField;
    }

    let current = control.parentElement;
    while (current && current !== root) {
      const ownsOtherRecipientControl = ["to", "cc", "bcc"]
        .filter((otherKind) => otherKind !== kind)
        .some((otherKind) => current.querySelector(`[name="${otherKind}"]`));
      if (ownsOtherRecipientControl) {
        break;
      }
      if (current.querySelector("[email],[data-hovercard-id]")) {
        return current;
      }
      current = current.parentElement;
    }

    return control.parentElement || root;
  }

  function addressesFromElement(element) {
    const candidates = [
      element.getAttribute("email"),
      element.getAttribute("data-hovercard-id"),
      element.getAttribute("data-email"),
      element.getAttribute("title"),
      element.getAttribute("aria-label")
    ];
    return candidates.flatMap(extractEmailAddresses);
  }

  function extractRecipients(root, kind) {
    const controls = recipientControls(root, kind);
    const addresses = [];

    for (const control of controls) {
      addresses.push(...extractEmailAddresses(control.value || control.textContent || ""));
      const scope = recipientScope(control, root, kind);
      scope.querySelectorAll("[email],[data-hovercard-id],[data-email]").forEach((chip) => {
        addresses.push(...addressesFromElement(chip));
      });
    }

    // Some Gmail layouts render chips as siblings after removing the input.
    // Classify those chips only when their nearest recipient field identifies
    // the requested kind, so To/Cc/Bcc cannot bleed into one another.
    root.querySelectorAll("[email],[data-hovercard-id],[data-email]").forEach((chip) => {
      const field = chip.closest(".aoD");
      if (field && field.querySelector(`[name="${kind}"],[aria-label^="${kind}"]`)) {
        addresses.push(...addressesFromElement(chip));
      }
    });

    return uniqueAddresses(addresses);
  }

  function extractSubject(root) {
    const subject = root.querySelector(
      'input[name="subjectbox"], input[aria-label="Subject"], input[placeholder="Subject"]'
    );
    return subject?.value || "";
  }

  function extractBody(root) {
    const body = [...root.querySelectorAll(COMPOSE_BODY_SELECTOR)].find(isVisible);
    if (!body) {
      throw userError("BODY_NOT_FOUND", "Gmail's message editor could not be read. Close and reopen the compose window, then try again.");
    }

    return {
      html: body.innerHTML,
      text: (body.innerText || body.textContent || "").replace(/\u00a0/g, " ")
    };
  }

  function fileKey(file) {
    return `${file.name}\u0000${file.size}\u0000${file.lastModified}`;
  }

  function replaceFilesForInput(state, input, files) {
    const previous = filesByInput.get(input) || [];
    const previousKeys = new Set(previous.map(fileKey));
    state.files = state.files.filter((file) => !previousKeys.has(fileKey(file)));

    filesByInput.set(input, files);
    const currentKeys = new Set(state.files.map(fileKey));
    for (const file of files) {
      if (!currentKeys.has(fileKey(file))) {
        state.files.push(file);
        currentKeys.add(fileKey(file));
      }
    }
  }

  function addCapturedFiles(state, files) {
    const currentKeys = new Set(state.files.map(fileKey));
    for (const file of files) {
      if (!currentKeys.has(fileKey(file))) {
        state.files.push(file);
        currentKeys.add(fileKey(file));
      }
    }
  }

  function visibleAttachmentInfo(root, files) {
    const attachmentArea = root.querySelector(".aQH");
    let rows = [...(attachmentArea || root).querySelectorAll(".aZo")].filter(isVisible);
    if (!rows.length) {
      rows = [...(attachmentArea || root).querySelectorAll("[data-attachment-id]")]
        .filter((element) => isVisible(element) && !element.parentElement?.closest("[data-attachment-id]"));
    }
    const searchable = [attachmentArea, ...rows]
      .filter(Boolean)
      .map((element) => [
        element.textContent,
        ...[...element.querySelectorAll("[aria-label],[title]")].flatMap((child) => [
          child.getAttribute("aria-label"),
          child.getAttribute("title")
        ])
      ].filter(Boolean).join("\n"))
      .join("\n");

    const confirmed = files.filter((file) => searchable.includes(file.name));
    const areaHasContent = Boolean(
      attachmentArea && isVisible(attachmentArea) && attachmentArea.textContent.trim()
    );
    return {
      hasVisibleArea: Boolean(rows.length || areaHasContent),
      visibleCount: rows.length || (areaHasContent ? 1 : 0),
      confirmed
    };
  }

  function currentInputFiles(root) {
    return [...root.querySelectorAll('input[type="file"]')]
      .flatMap((input) => [...(input.files || [])]);
  }

  function userError(code, message) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function attachmentFilesForSend(state) {
    const byKey = new Map();
    [...state.files, ...currentInputFiles(state.root)].forEach((file) => {
      byKey.set(fileKey(file), file);
    });
    const captured = [...byKey.values()];
    const visible = visibleAttachmentInfo(state.root, captured);

    if (visible.hasVisibleArea && captured.length === 0) {
      throw userError(
        "ATTACHMENT_UNAVAILABLE",
        "This draft has an attachment Gmail did not expose to the extension. Remove it, reattach it, and try again. Drive attachments are not supported yet."
      );
    }

    if (visible.hasVisibleArea && visible.visibleCount > visible.confirmed.length) {
      throw userError(
        "ATTACHMENT_UNAVAILABLE",
        "One or more Gmail attachments could not be read safely. Remove them, reattach them after this extension is loaded, and try again."
      );
    }

    if (captured.length && !visible.hasVisibleArea) {
      const stillSelectedKeys = new Set(currentInputFiles(state.root).map(fileKey));
      const definitelyCurrent = captured.filter((file) => stillSelectedKeys.has(fileKey(file)));
      if (definitelyCurrent.length !== captured.length) {
        throw userError(
          "ATTACHMENT_STATE_UNCLEAR",
          "The extension captured a file but cannot confirm it is still attached. Remove and reattach the file, then try again."
        );
      }
      return definitelyCurrent;
    }

    return visible.hasVisibleArea ? visible.confirmed : captured;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }
    return btoa(binary);
  }

  async function serializeAttachments(files) {
    const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > MAX_ATTACHMENT_BYTES) {
      throw userError(
        "ATTACHMENTS_TOO_LARGE",
        "Attachments exceed this prototype's 3 MiB total limit. Remove or reduce them and try again."
      );
    }

    const attachments = [];
    for (const file of files) {
      attachments.push({
        filename: file.name,
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        contentBase64: arrayBufferToBase64(await file.arrayBuffer())
      });
    }
    return attachments;
  }

  function runtimeSendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        const error = chrome.runtime.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  function validateConfig(config) {
    if (!config.enabled) {
      throw userError("EXTENSION_DISABLED", "Alias sending is disabled. Enable it in the extension settings first.");
    }

    const from = uniqueAddresses(extractEmailAddresses(config.fromAddress || ""));
    if (from.length !== 1 || from[0].toLowerCase() !== config.fromAddress.trim().toLowerCase()) {
      throw userError("INVALID_FROM", "Configure one valid From address in the extension settings first.");
    }

    return from[0];
  }

  function appendDefaultBcc(bcc, defaultBcc, to, cc) {
    const combined = uniqueAddresses([...bcc, ...extractEmailAddresses(defaultBcc || "")]);
    const visibleRecipients = new Set([...to, ...cc].map((address) => address.toLowerCase()));
    return combined.filter((address) => !visibleRecipients.has(address.toLowerCase()));
  }

  async function buildPayload(state, config) {
    const from = validateConfig(config);
    const to = extractRecipients(state.root, "to");
    const cc = extractRecipients(state.root, "cc");
    const bcc = appendDefaultBcc(extractRecipients(state.root, "bcc"), config.defaultBcc, to, cc);

    if (to.length + cc.length + bcc.length === 0) {
      throw userError("NO_RECIPIENTS", "Add at least one valid recipient before sending via the alias.");
    }

    const { html, text } = extractBody(state.root);
    const files = attachmentFilesForSend(state);
    const attachments = await serializeAttachments(files);

    return {
      to,
      cc,
      bcc,
      from,
      fromName: (config.fromName || "").trim(),
      subject: extractSubject(state.root),
      html,
      text,
      replyTo: from,
      headers: {},
      attachments
    };
  }

  async function sendViaAlias(state) {
    if (state.phase === "sending" || state.phase === "success") {
      return;
    }

    setUiState(state, "sending", "Reading this draft…");

    try {
      const config = await getConfig();
      const payload = await buildPayload(state, config);
      setUiState(state, "sending", "Sending externally…");

      const response = await runtimeSendMessage({
        type: MESSAGE_TYPE,
        payload
      });

      if (!response?.ok) {
        const message = response?.error?.message || "The alias service did not confirm delivery. Nothing was changed in Gmail.";
        throw userError(response?.error?.code || "SEND_FAILED", message);
      }

      setUiState(
        state,
        "success",
        "Sent via alias. Gmail kept this draft—close or discard it, and do not click Gmail Send."
      );
    } catch (error) {
      const message = error instanceof Error && error.message
        ? error.message
        : "Alias sending failed. Nothing was changed in Gmail.";
      setUiState(state, "error", message);
    }
  }

  document.addEventListener("focusin", (event) => {
    const root = findComposeRoot(event.target);
    if (root) {
      lastFocusedCompose = root;
    }
  }, true);

  document.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.type !== "file" || !input.files?.length) {
      return;
    }

    const root = findComposeRoot(input) || (lastFocusedCompose?.isConnected ? lastFocusedCompose : null);
    if (!root) {
      return;
    }

    replaceFilesForInput(getOrCreateState(root), input, [...input.files]);
  }, true);

  document.addEventListener("drop", (event) => {
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) {
      return;
    }

    const root = findComposeRoot(event.target) || (lastFocusedCompose?.isConnected ? lastFocusedCompose : null);
    if (root) {
      addCapturedFiles(getOrCreateState(root), files);
    }
  }, true);

  document.addEventListener("click", (event) => {
    const control = event.target.closest?.("[aria-label],[data-tooltip],[title]");
    if (!control) {
      return;
    }

    const label = [
      control.getAttribute("aria-label"),
      control.getAttribute("data-tooltip"),
      control.getAttribute("title")
    ].filter(Boolean).join(" ").toLowerCase();
    if (!label.includes("remove attachment")) {
      return;
    }

    const root = findComposeRoot(control) || (lastFocusedCompose?.isConnected ? lastFocusedCompose : null);
    const state = root && composeStates.get(root);
    if (!state?.files.length) {
      return;
    }

    const row = control.closest(".aZo,[data-attachment-id]");
    const rowText = row?.textContent || control.getAttribute("aria-label") || "";
    const matchingFiles = state.files.filter((file) => rowText.includes(file.name));
    if (matchingFiles.length) {
      const removedKeys = new Set(matchingFiles.map(fileKey));
      state.files = state.files.filter((file) => !removedKeys.has(fileKey(file)));
    } else if (state.files.length === 1) {
      state.files = [];
    }
  }, true);

  const observer = new MutationObserver(scheduleScan);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  getConfig().then(scheduleScan).catch(() => {
    cachedConfig.enabled = false;
    scheduleScan();
  });
})();
