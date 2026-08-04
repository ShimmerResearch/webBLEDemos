chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === "VIDEO_TIME") {
        chrome.runtime.sendMessage(message);
    } else if (message.type === "TAKE_SCREENSHOT") {
        const doCapture = (windowId) => {
            chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality: 70 }, (dataUrl) => {
                if (chrome.runtime.lastError || !dataUrl) {
                    console.error("Screenshot failed:", chrome.runtime.lastError?.message);
                    sendResponse({ ok: false, error: chrome.runtime.lastError?.message || "capture failed" });
                } else {
                    sendResponse({ ok: true, dataUrl });
                }
            });
        };

        if (sender.tab && sender.tab.windowId != null) {
            doCapture(sender.tab.windowId);
        } else {
            chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
                if (!tabs || !tabs[0]) {
                    sendResponse({ ok: false, error: "no active tab to capture" });
                    return;
                }
                doCapture(tabs[0].windowId);
            });
        }
        return true; // Keep message channel open for async response
    } else if (message.type === "GET_PAGE_INFO") {
        // The companion runs in an extension-origin iframe and cannot read the host
        // page's URL directly. Used to derive the NeuroLynQ content hash.
        const respond = (tab) => {
            if (!tab) {
                sendResponse({ ok: false, error: "no active tab" });
                return;
            }
            sendResponse({ ok: true, url: tab.url || "", title: tab.title || "" });
        };

        if (sender.tab) {
            respond(sender.tab);
        } else {
            chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => respond(tabs && tabs[0]));
        }
        return true; // Keep message channel open for async response
    }
});

chrome.action.onClicked.addListener(async (tab) => {
    if (tab.id) {
        chrome.tabs.sendMessage(tab.id, { type: "TOGGLE_OVERLAY" }).catch(() => {
            // Content script might not be injected yet or not on a supported page
        });
    }
});