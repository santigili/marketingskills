// Opens the editor. If the active tab (or a clicked link) is a PDF, passes its URL
// so the editor can load it. Nothing is ever sent to a server.

const EDITOR = chrome.runtime.getURL("editor.html");

function looksLikePdf(url) {
  if (!url) return false;
  try {
    const u = new URL(url);
    return /\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

function openEditor(pdfUrl) {
  const url = pdfUrl ? `${EDITOR}?src=${encodeURIComponent(pdfUrl)}` : EDITOR;
  chrome.tabs.create({ url });
}

chrome.action.onClicked.addListener((tab) => {
  openEditor(looksLikePdf(tab?.url) ? tab.url : null);
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "open-link",
    title: "Rellenar y firmar con FirmaLocal",
    contexts: ["link"],
    targetUrlPatterns: ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.PDF", "*://*/*.PDF?*"]
  });
  chrome.contextMenus.create({
    id: "open-page",
    title: "Rellenar y firmar este PDF con FirmaLocal",
    contexts: ["page"],
    documentUrlPatterns: ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.PDF", "*://*/*.PDF?*"]
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "open-link") openEditor(info.linkUrl);
  if (info.menuItemId === "open-page") openEditor(info.pageUrl || tab?.url);
});
