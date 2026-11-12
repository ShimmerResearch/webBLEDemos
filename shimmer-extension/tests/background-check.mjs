// background.js against a mocked chrome API: screenshots come only from the
// companion's own tab while it is the one showing, and the toolbar button
// injects the content script only when the tab does not already have it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const source = readFileSync(new URL("../background.js", import.meta.url), "utf8");

function load({ tabs = {}, windows = {}, afterCapture } = {}) {
  const calls = { capture: [], inject: [], sendMessage: [] };
  let onMessage, onClicked;
  let sendMessageFailures = 0;
  const chrome = {
    runtime: {
      lastError: null,
      onMessage: { addListener: (fn) => { onMessage = fn; } },
      sendMessage() {},
    },
    action: { onClicked: { addListener: (fn) => { onClicked = fn; } } },
    tabs: {
      get: async (id) => { if (!tabs[id]) throw new Error("No tab"); return { ...tabs[id] }; },
      captureVisibleTab: (windowId, _options, callback) => {
        calls.capture.push(windowId);
        afterCapture?.();
        callback(`data:image/jpeg;base64,window${windowId}`);
      },
      sendMessage: async (tabId, message) => {
        calls.sendMessage.push([tabId, message.type]);
        if (sendMessageFailures > 0) { sendMessageFailures -= 1; throw new Error("Receiving end does not exist."); }
      },
    },
    windows: { get: async (id) => ({ ...windows[id] }) },
    scripting: { executeScript: async (options) => { calls.inject.push(options); } },
  };
  vm.runInNewContext(source, { chrome, console: { error() {}, info() {} } });
  const send = (message, sender) => new Promise((resolve) => {
    const keepOpen = onMessage(message, sender, resolve);
    if (keepOpen !== true) setTimeout(() => resolve("no async response"), 0);
  });
  return { calls, send, click: (tab) => onClicked(tab), failNextSendMessages: (n) => { sendMessageFailures = n; } };
}

const shot = { type: "TAKE_SCREENSHOT" };
const showing = { tabs: { 7: { id: 7, active: true, windowId: 1 } }, windows: { 1: { state: "normal" } } };

// The recording tab is showing: captured.
{
  const { calls, send } = load(showing);
  const response = await send(shot, { tab: { id: 7, windowId: 1 } });
  assert.equal(response.ok, true);
  assert.match(response.dataUrl, /^data:image\/jpeg/);
  assert.deepEqual(calls.capture, [1]);
}

// The participant switched to another tab: skipped, nothing captured.
{
  const { calls, send } = load({ ...showing, tabs: { 7: { id: 7, active: false, windowId: 1 } } });
  const response = await send(shot, { tab: { id: 7, windowId: 1 } });
  assert.equal(response.ok, false);
  assert.equal(response.skipped, true);
  assert.deepEqual(calls.capture, []);
}

// The window is minimized: skipped.
{
  const { calls, send } = load({ ...showing, windows: { 1: { state: "minimized" } } });
  const response = await send(shot, { tab: { id: 7, windowId: 1 } });
  assert.equal(response.skipped, true);
  assert.deepEqual(calls.capture, []);
}

// A tab switch between the check and the capture: the image is discarded.
{
  const state = { tabs: { 7: { id: 7, active: true, windowId: 1 } }, windows: { 1: { state: "normal" } } };
  const { send } = load({ ...state, afterCapture: () => { state.tabs[7].active = false; } });
  const response = await send(shot, { tab: { id: 7, windowId: 1 } });
  assert.equal(response.skipped, true);
  assert.equal(response.dataUrl, undefined);
}

// No sender tab (not the companion overlay): refused, and no fallback to the active tab.
{
  const { calls, send } = load(showing);
  const response = await send(shot, {});
  assert.equal(response.ok, false);
  assert.deepEqual(calls.capture, []);
  const info = await send({ type: "GET_PAGE_INFO" }, {});
  assert.equal(info.ok, false);
  const ownInfo = await send({ type: "GET_PAGE_INFO" }, { tab: { url: "https://example.test/a", title: "A" } });
  assert.deepEqual({ ...ownInfo }, { ok: true, url: "https://example.test/a", title: "A" });
}

// Toolbar click on a tab without the content script: inject, then toggle.
{
  const { calls, click, failNextSendMessages } = load(showing);
  failNextSendMessages(1);
  await click({ id: 7 });
  assert.equal(calls.inject.length, 1);
  assert.deepEqual([...calls.inject[0].files], ["content.js"]);
  assert.equal(calls.inject[0].target.tabId, 7);
  assert.deepEqual(calls.sendMessage.map(([, type]) => type), ["TOGGLE_OVERLAY", "TOGGLE_OVERLAY"]);
}

// Toolbar click on a tab that already has it: toggle only, no second injection.
{
  const { calls, click } = load(showing);
  await click({ id: 7 });
  assert.equal(calls.inject.length, 0);
  assert.equal(calls.sendMessage.length, 1);
}

console.log("Background checks passed (screenshots only of the showing companion tab, on-demand injection).");
