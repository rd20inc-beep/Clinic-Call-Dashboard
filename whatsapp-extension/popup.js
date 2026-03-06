let currentEnabled = false;
let waTabFound = false;

function updateUI(enabled, processedCount) {
  currentEnabled = enabled;
  document.getElementById('statusDot').className = 'dot ' + (enabled ? 'on' : 'off');
  document.getElementById('statusText').textContent = enabled ? 'Bot Active' : 'Bot Paused';
  const btn = document.getElementById('toggleBtn');
  btn.textContent = enabled ? 'Pause Bot' : 'Enable Bot';
  btn.className = 'toggle-btn ' + (enabled ? 'disable' : 'enable');
  if (processedCount !== undefined) {
    document.getElementById('stats').textContent = 'Messages seen: ' + processedCount;
  }
}

function showWaiting(msg) {
  document.getElementById('statusDot').className = 'dot waiting';
  document.getElementById('statusText').textContent = msg;
  document.getElementById('toggleBtn').textContent = msg;
  document.getElementById('toggleBtn').className = 'toggle-btn waiting';
}

function toggleBot() {
  chrome.tabs.query({}, (tabs) => {
    const waTab = tabs.find(t => t.url && t.url.includes('web.whatsapp.com'));
    if (!waTab) {
      document.getElementById('helpText').innerHTML = 'Open web.whatsapp.com in a tab first, then come back here.';
      return;
    }
    chrome.tabs.sendMessage(waTab.id, { type: 'SET_ENABLED', enabled: !currentEnabled }, (resp) => {
      if (chrome.runtime.lastError) {
        document.getElementById('helpText').innerHTML = 'Reload the WhatsApp Web tab (Ctrl+R) so the extension can inject into it.';
        return;
      }
      if (resp) { waTabFound = true; updateUI(!currentEnabled); }
    });
  });
}

function saveUrl() {
  const url = document.getElementById('serverUrl').value.trim();
  if (!url) return;

  chrome.storage.local.set({ serverUrl: url }, () => {
    chrome.runtime.sendMessage({ type: 'SET_SERVER_URL', url: url }, () => {
      if (chrome.runtime.lastError) { /* ignore */ }
    });

    const msg = document.getElementById('saveMsg');
    msg.style.display = 'block';
    msg.textContent = 'Saved: ' + url;
    setTimeout(() => { msg.style.display = 'none'; }, 3000);
  });
}

// Init on DOM load
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('toggleBtn').addEventListener('click', toggleBot);
  document.getElementById('saveBtn').addEventListener('click', saveUrl);

  // Load saved URL
  chrome.storage.local.get(['serverUrl'], (result) => {
    document.getElementById('serverUrl').value = result.serverUrl || 'https://clinicea.scalamatic.com';
  });

  // Find WhatsApp tab and get status
  chrome.tabs.query({}, (tabs) => {
    const waTab = tabs.find(t => t.url && t.url.includes('web.whatsapp.com'));
    if (waTab) {
      waTabFound = true;
      chrome.tabs.sendMessage(waTab.id, { type: 'GET_STATUS' }, (resp) => {
        if (chrome.runtime.lastError) {
          showWaiting('Extension not loaded');
          document.getElementById('helpText').innerHTML = 'Reload the WhatsApp Web tab (Ctrl+R) so the extension can inject into it.';
          return;
        }
        if (resp) {
          updateUI(resp.enabled, resp.processedCount);
        } else {
          showWaiting('Connecting...');
        }
      });
    } else {
      showWaiting('WhatsApp Web not open');
      document.getElementById('helpText').innerHTML = 'Open web.whatsapp.com in a tab, then come back here.';
    }
  });
});
