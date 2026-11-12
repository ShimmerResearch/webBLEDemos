// Screenshots and page info only ever come from the tab the companion overlay
// lives in (sender.tab), and a screenshot only while that tab is the one
// showing in its window. captureVisibleTab captures whichever tab is visible,
// so without this check a participant who switched to another tab mid-recording
// would have that tab captured, exported and uploaded.
async function isShowing(tabId) {
    try {
        const tab = await chrome.tabs.get(tabId);
        if (!tab.active) return false;
        const win = await chrome.windows.get(tab.windowId);
        return win.state !== "minimized";
    } catch {
        return false; // tab or window closed
    }
}

function captureVisibleTab(windowId) {
    return new Promise((resolve) => {
        chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 70 }, (dataUrl) => {
            if (chrome.runtime.lastError || !dataUrl) {
                resolve({ ok: false, error: chrome.runtime.lastError?.message || "capture failed" });
            } else {
                resolve({ ok: true, dataUrl });
            }
        });
    });
}

async function takeScreenshot(tab) {
    const skipped = { ok: false, skipped: true, error: "the recording tab is not the one showing" };
    if (!(await isShowing(tab.id))) return skipped;
    const shot = await captureVisibleTab(tab.windowId);
    // Checked again afterwards: a tab switch between the check and the capture
    // would otherwise slip another tab's contents through.
    if (shot.ok && !(await isShowing(tab.id))) return skipped;
    if (!shot.ok) console.error("Screenshot failed:", shot.error);
    return shot;
}

// One-time overlay tokens, one per tab (see createOverlay in content.js). Kept in
// session storage, which survives the service worker being stopped and is not
// readable from content scripts.
const overlayKey = (tabId) => `overlayToken:${tabId}`;

async function registerOverlay(tabId, token) {
    await chrome.storage.session.set({ [overlayKey(tabId)]: token });
    return { ok: true };
}

async function claimOverlay(tabId, token) {
    const key = overlayKey(tabId);
    const stored = await chrome.storage.session.get(key);
    if (!token || stored[key] !== token) return { ok: false };
    await chrome.storage.session.remove(key);
    return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "REGISTER_OVERLAY") {
        // From the content script in the tab's top frame only.
        if (sender.tab?.id == null || sender.frameId !== 0 || typeof message.token !== "string") {
            sendResponse({ ok: false });
            return;
        }
        registerOverlay(sender.tab.id, message.token).then(sendResponse);
        return true;
    } else if (message.type === "CLAIM_OVERLAY") {
        if (sender.tab?.id == null || typeof message.token !== "string") {
            sendResponse({ ok: false });
            return;
        }
        claimOverlay(sender.tab.id, message.token).then(sendResponse);
        return true;
    } else if (message.type === "VIDEO_TIME") {
        chrome.runtime.sendMessage(message);
    } else if (message.type === "TAKE_SCREENSHOT") {
        if (sender.tab?.id == null) {
            sendResponse({ ok: false, error: "screenshots are only taken of the companion's own tab" });
            return;
        }
        takeScreenshot(sender.tab).then(sendResponse);
        return true; // Keep message channel open for async response
    } else if (message.type === "GET_PAGE_INFO") {
        // The companion runs in an extension-origin iframe and cannot read the host
        // page's URL directly. Used to derive the NeuroLynQ content hash.
        if (!sender.tab) {
            sendResponse({ ok: false, error: "no companion tab" });
            return;
        }
        sendResponse({ ok: true, url: sender.tab.url || "", title: sender.tab.title || "" });
    }
});

// The content script is injected only into the tab whose toolbar button was
// clicked (activeTab), never into every page. A second click reaches the
// already-injected script; injecting again would redeclare its top-level names.
chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id == null) return;
    try {
        await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_OVERLAY" });
        return;
    } catch {
        // No live content script in this tab yet.
    }
    try {
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["content.js"] });
        await chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_OVERLAY" });
    } catch {
        // A page extensions cannot script (chrome://, the Web Store, a PDF viewer),
        // or a stale script left by an extension reload: reload the page to use it.
    }
});
