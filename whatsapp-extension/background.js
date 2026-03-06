// Background service worker - relays messages between content script and server
let serverUrl = 'http://localhost:3000';

chrome.storage.local.get(['serverUrl'], (result) => {
  if (result.serverUrl) serverUrl = result.serverUrl;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'SET_SERVER_URL') {
    serverUrl = msg.url;
    chrome.storage.local.set({ serverUrl: msg.url });
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'INCOMING_MESSAGE') {
    // Forward to server for GPT processing
    fetch(`${serverUrl}/api/whatsapp/incoming`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.data)
    })
      .then(r => r.json())
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ error: err.message }));
    return true; // keep channel open for async response
  }

  if (msg.type === 'CHECK_OUTGOING') {
    // Poll server for any pending outgoing messages
    fetch(`${serverUrl}/api/whatsapp/outgoing`)
      .then(r => r.json())
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ error: err.message, messages: [] }));
    return true;
  }

  if (msg.type === 'MESSAGE_SENT') {
    // Confirm message was sent
    fetch(`${serverUrl}/api/whatsapp/sent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(msg.data)
    })
      .then(r => r.json())
      .then(data => sendResponse(data))
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});
