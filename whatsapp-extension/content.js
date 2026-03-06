// Content script - runs on web.whatsapp.com
// Watches for new messages, sends them to server, and types/sends replies

(function () {
  'use strict';

  const POLL_INTERVAL = 3000; // check for outgoing messages every 3s
  const MSG_CHECK_INTERVAL = 2000; // check for new incoming messages every 2s
  const processedMessages = new Set();
  let enabled = true;
  let lastProcessedTimestamp = Date.now();

  console.log('[Clinicea WA Bot] Content script loaded');

  // Wait for WhatsApp Web to fully load
  function waitForLoad(callback) {
    const check = setInterval(() => {
      const mainPanel = document.querySelector('#main') || document.querySelector('[data-tab="1"]');
      if (mainPanel) {
        clearInterval(check);
        console.log('[Clinicea WA Bot] WhatsApp Web loaded');
        callback();
      }
    }, 1000);
  }

  // Get the currently open chat name
  function getCurrentChatName() {
    // Try header with contact name
    const header = document.querySelector('#main header span[title]');
    if (header) return header.getAttribute('title') || header.textContent.trim();
    return null;
  }

  // Get the currently open chat phone number from contact info or chat
  function getCurrentChatPhone() {
    // Phone number sometimes appears in the header subtitle or profile
    const subtitle = document.querySelector('#main header span[title]');
    if (subtitle) {
      const title = subtitle.getAttribute('title') || '';
      // Check if it looks like a phone number
      if (/^\+?\d[\d\s\-]{7,}/.test(title)) return title.replace(/[\s\-]/g, '');
    }
    return null;
  }

  // Get new unread messages from the current chat
  function getNewMessages() {
    const messages = [];
    // Get all incoming message rows
    const msgRows = document.querySelectorAll('[data-id]');

    msgRows.forEach(row => {
      const dataId = row.getAttribute('data-id');
      if (!dataId || processedMessages.has(dataId)) return;

      // Only process incoming messages (not sent by us)
      // Incoming messages have data-id starting with "false_"
      if (!dataId.startsWith('false_')) return;

      // Get message text
      const textSpan = row.querySelector('.selectable-text span');
      if (!textSpan) return;

      const text = textSpan.textContent.trim();
      if (!text) return;

      // Extract phone from data-id: false_PHONE@c.us_MSGID
      let phone = null;
      const idParts = dataId.split('_');
      if (idParts.length >= 2) {
        const raw = idParts[1].replace('@c.us', '').replace('@s.whatsapp.net', '');
        if (/^\d+$/.test(raw)) phone = '+' + raw;
      }

      messages.push({
        id: dataId,
        text: text,
        phone: phone,
        chatName: getCurrentChatName(),
        timestamp: Date.now()
      });
    });

    return messages;
  }

  // Scan all chats in sidebar for unread messages
  function getUnreadChats() {
    const unreadChats = [];
    const chatItems = document.querySelectorAll('[data-testid="cell-frame-container"]');

    chatItems.forEach(item => {
      // Check for unread badge
      const badge = item.querySelector('[data-testid="icon-unread-count"]') ||
                    item.querySelector('span[aria-label*="unread"]') ||
                    item.parentElement?.querySelector('.aumms1qt'); // unread dot

      if (badge) {
        const nameEl = item.querySelector('span[title]');
        if (nameEl) {
          unreadChats.push({
            name: nameEl.getAttribute('title') || nameEl.textContent.trim(),
            element: item
          });
        }
      }
    });
    return unreadChats;
  }

  // Type text into the chat input and send
  async function typeAndSend(text) {
    // Find the message input box
    const inputBox = document.querySelector('[data-tab="10"]') ||
                     document.querySelector('footer [contenteditable="true"]') ||
                     document.querySelector('[data-testid="conversation-compose-box-input"]');

    if (!inputBox) {
      console.error('[Clinicea WA Bot] Cannot find message input box');
      return false;
    }

    // Focus the input
    inputBox.focus();
    inputBox.click();
    await sleep(300);

    // Clear any existing text
    inputBox.innerHTML = '';

    // Type the message using execCommand for natural input simulation
    document.execCommand('insertText', false, text);
    await sleep(500);

    // Dispatch input event to trigger WhatsApp's internal handlers
    inputBox.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(300);

    // Find and click the send button
    const sendBtn = document.querySelector('[data-testid="send"]') ||
                    document.querySelector('footer button[aria-label="Send"]') ||
                    document.querySelector('span[data-icon="send"]')?.parentElement;

    if (sendBtn) {
      sendBtn.click();
      console.log('[Clinicea WA Bot] Message sent');
      await sleep(500);
      return true;
    }

    // Fallback: press Enter
    inputBox.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true
    }));
    console.log('[Clinicea WA Bot] Message sent via Enter key');
    await sleep(500);
    return true;
  }

  // Open a specific chat by searching for a phone number or name
  async function openChat(phoneOrName) {
    // Click search or new chat
    const searchBox = document.querySelector('[data-testid="chat-list-search"]') ||
                      document.querySelector('div[contenteditable="true"][data-tab="3"]');

    if (!searchBox) {
      console.error('[Clinicea WA Bot] Cannot find search box');
      return false;
    }

    searchBox.focus();
    searchBox.click();
    await sleep(300);

    // Clear and type the search
    searchBox.innerHTML = '';
    document.execCommand('insertText', false, phoneOrName);
    searchBox.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(1500); // wait for search results

    // Click the first result
    const results = document.querySelectorAll('[data-testid="cell-frame-container"]');
    if (results.length > 0) {
      results[0].click();
      await sleep(1000);

      // Clear search
      const clearBtn = document.querySelector('[data-testid="x-alt"]') ||
                       document.querySelector('[data-testid="search-clear-btn"]');
      if (clearBtn) clearBtn.click();

      return true;
    }

    console.error('[Clinicea WA Bot] No chat found for:', phoneOrName);
    return false;
  }

  // Send a message to a specific phone number
  async function sendMessageTo(phone, message) {
    const opened = await openChat(phone);
    if (!opened) return false;
    await sleep(500);
    return await typeAndSend(message);
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // Main loop: check for new incoming messages
  function startIncomingMonitor() {
    setInterval(() => {
      if (!enabled) return;

      const messages = getNewMessages();
      messages.forEach(msg => {
        // Mark as processed immediately to avoid duplicates
        processedMessages.add(msg.id);

        console.log('[Clinicea WA Bot] New message from', msg.chatName || msg.phone, ':', msg.text);

        // Send to server for GPT processing
        chrome.runtime.sendMessage({
          type: 'INCOMING_MESSAGE',
          data: {
            messageId: msg.id,
            text: msg.text,
            phone: msg.phone,
            chatName: msg.chatName,
            timestamp: msg.timestamp
          }
        }, async (response) => {
          if (response && response.reply && response.reply.trim()) {
            console.log('[Clinicea WA Bot] GPT reply:', response.reply);
            // Type and send the reply in the current chat
            await sleep(1000); // natural delay
            await typeAndSend(response.reply);
          }
        });
      });

      // Trim processed set to prevent memory leak
      if (processedMessages.size > 5000) {
        const arr = Array.from(processedMessages);
        arr.splice(0, 2500);
        processedMessages.clear();
        arr.forEach(id => processedMessages.add(id));
      }
    }, MSG_CHECK_INTERVAL);
  }

  // Poll server for outgoing messages (appointment confirmations, reminders)
  function startOutgoingPoller() {
    setInterval(() => {
      if (!enabled) return;

      chrome.runtime.sendMessage({ type: 'CHECK_OUTGOING' }, async (response) => {
        if (response && response.messages && response.messages.length > 0) {
          for (const msg of response.messages) {
            console.log('[Clinicea WA Bot] Sending scheduled message to', msg.phone, ':', msg.text);

            const success = await sendMessageTo(msg.phone, msg.text);

            // Report back to server
            chrome.runtime.sendMessage({
              type: 'MESSAGE_SENT',
              data: {
                id: msg.id,
                phone: msg.phone,
                success: success
              }
            });

            await sleep(2000); // delay between messages
          }
        }
      });
    }, POLL_INTERVAL);
  }

  // Mark all currently visible messages as "already seen" on startup
  function markExistingMessages() {
    const msgRows = document.querySelectorAll('[data-id]');
    msgRows.forEach(row => {
      const dataId = row.getAttribute('data-id');
      if (dataId) processedMessages.add(dataId);
    });
    console.log('[Clinicea WA Bot] Marked', processedMessages.size, 'existing messages as read');
  }

  // Listen for enable/disable from popup
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'SET_ENABLED') {
      enabled = msg.enabled;
      console.log('[Clinicea WA Bot]', enabled ? 'Enabled' : 'Disabled');
      sendResponse({ ok: true });
    }
    if (msg.type === 'GET_STATUS') {
      sendResponse({ enabled, processedCount: processedMessages.size });
    }
    if (msg.type === 'SEND_MESSAGE') {
      // Manual send from dashboard
      sendMessageTo(msg.phone, msg.text).then(success => {
        sendResponse({ success });
      });
      return true;
    }
  });

  // Boot
  waitForLoad(() => {
    markExistingMessages();
    startIncomingMonitor();
    startOutgoingPoller();
    console.log('[Clinicea WA Bot] All systems running');
  });

})();
