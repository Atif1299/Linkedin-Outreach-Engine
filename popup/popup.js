// Popup Script - Tabbed Interface

document.addEventListener('DOMContentLoaded', async () => {
  // ============================================
  // TAB SWITCHING
  // ============================================
  
  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetTab = tab.dataset.tab;
      
      // Update active tab button
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      
      // Update active content
      tabContents.forEach(content => {
        content.classList.remove('active');
        if (content.id === targetTab) {
          content.classList.add('active');
        }
      });
    });
  });
  
  // ============================================
  // LOAD SETTINGS
  // ============================================
  
  const settings = await chrome.storage.local.get([
    'spreadsheetId',
    'openaiApiKey',
    'dailyLimit',
    'sendTime',
    'autoSendEnabled',
    'selectedCampaign',
    'stats'
  ]);
  
  // Populate settings fields
  const spreadsheetIdEl = document.getElementById('spreadsheetId');
  const openaiApiKeyEl = document.getElementById('openaiApiKey');
  const dailyLimitEl = document.getElementById('dailyLimit');
  const sendTimeEl = document.getElementById('sendTime');
  const autoSendEnabledEl = document.getElementById('autoSendEnabled');
  
  if (spreadsheetIdEl && settings.spreadsheetId) {
    spreadsheetIdEl.value = settings.spreadsheetId;
  }
  if (openaiApiKeyEl && settings.openaiApiKey) {
    openaiApiKeyEl.value = settings.openaiApiKey;
  }
  if (dailyLimitEl) {
    const stored = settings.dailyLimit;
    const dailyLimit = Math.min(stored == null ? 25 : stored, 25);
    dailyLimitEl.value = dailyLimit;
    if (stored == null) {
      chrome.storage.local.set({ dailyLimit: 25 });
    }
  }
  if (sendTimeEl && settings.sendTime) {
    sendTimeEl.value = settings.sendTime;
  }
  if (autoSendEnabledEl && settings.autoSendEnabled) {
    autoSendEnabledEl.checked = true;
    updateAutoSendUI(true);
  }

  // Persist limit/time as soon as user changes them
  if (dailyLimitEl) {
    dailyLimitEl.addEventListener('change', async () => {
      const dailyLimit = Math.min(Math.max(parseInt(dailyLimitEl.value, 10) || 25, 1), 25);
      dailyLimitEl.value = dailyLimit;
      await chrome.storage.local.set({ dailyLimit });
    });
  }
  if (sendTimeEl) {
    sendTimeEl.addEventListener('change', async () => {
      await chrome.storage.local.set({ sendTime: sendTimeEl.value || '10:00' });
    });
  }
  
  // If no settings configured, show settings tab
  if (!settings.spreadsheetId || !settings.openaiApiKey) {
    document.querySelector('[data-tab="settings"]').click();
  }
  
  // Display stats - fetch real data from background
  const extractedCountEl = document.getElementById('extractedCount');
  const sentCountEl = document.getElementById('sentCount');
  const pendingCountEl = document.getElementById('pendingCount');
  
  // Show loading
  if (extractedCountEl) extractedCountEl.textContent = '...';
  if (sentCountEl) sentCountEl.textContent = '...';
  if (pendingCountEl) pendingCountEl.textContent = '...';
  
  // Fetch real stats from Google Sheet via background
  try {
    const statsResponse = await chrome.runtime.sendMessage({ action: 'getSheetStats' });
    if (statsResponse && !statsResponse.error) {
      if (extractedCountEl) extractedCountEl.textContent = statsResponse.total || 0;
      if (sentCountEl) sentCountEl.textContent = statsResponse.sentToday || 0;
      if (pendingCountEl) pendingCountEl.textContent = statsResponse.pending || 0;
    }
  } catch (e) {
    console.log('Could not fetch stats:', e);
  }
  
  // Load campaigns
  loadCampaigns();
  
  // ============================================
  // SETTINGS HANDLERS
  // ============================================
  
  document.getElementById('saveSettings').addEventListener('click', async () => {
    const spreadsheetId = document.getElementById('spreadsheetId').value.trim();
    const openaiApiKey = document.getElementById('openaiApiKey').value.trim();
    
    await chrome.storage.local.set({
      spreadsheetId,
      openaiApiKey
    });
    
    // Show success
    const statusEl = document.getElementById('settingsStatus');
    statusEl.style.display = 'block';
    setTimeout(() => {
      statusEl.style.display = 'none';
    }, 2000);
    
    // Reload campaigns
    loadCampaigns();
  });
  
  // ============================================
  // AUTO-SEND HANDLERS
  // ============================================
  
  document.getElementById('autoSendEnabled').addEventListener('change', async (e) => {
    const enabled = e.target.checked;
    await chrome.storage.local.set({ autoSendEnabled: enabled });
  });
  
  document.getElementById('startAutoSend').addEventListener('click', async () => {
    const dailyLimit = Math.min(parseInt(document.getElementById('dailyLimit').value) || 25, 25);
    const sendTime = document.getElementById('sendTime').value || '10:00';
    const campaign = document.getElementById('campaignSelect').value;
    
    if (!campaign) {
      alert('Please select a campaign first!');
      return;
    }
    
    await chrome.storage.local.set({
      dailyLimit,
      sendTime,
      selectedCampaign: campaign,
      autoSendEnabled: true
    });
    
    const response = await chrome.runtime.sendMessage({
      action: 'startAutoSend',
      config: { dailyLimit, sendTime, campaign }
    });
    
    if (response.success) {
      updateAutoSendUI(true);
      document.getElementById('statusText').textContent = `⏰ Scheduled for ${sendTime} (max ${dailyLimit}/day)`;
    } else {
      alert('Failed to start: ' + (response.error || 'Unknown error'));
    }
  });
  
  document.getElementById('stopAutoSend').addEventListener('click', async () => {
    await chrome.storage.local.set({ autoSendEnabled: false });
    const response = await chrome.runtime.sendMessage({ action: 'stopAutoSend' });
    if (response.success) {
      updateAutoSendUI(false);
    }
  });
  
  // ============================================
  // QUICK ACTION HANDLERS
  // ============================================
  
  document.getElementById('openSheet').addEventListener('click', async () => {
    const settings = await chrome.storage.local.get(['spreadsheetId']);
    if (settings.spreadsheetId) {
      const url = `https://docs.google.com/spreadsheets/d/${settings.spreadsheetId}`;
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      const target = windows.find(w => w.focused) || windows[0];
      if (target?.id != null) {
        chrome.tabs.create({ url, active: true, windowId: target.id });
      } else {
        chrome.windows.create({ url, focused: true });
      }
    } else {
      alert('Please set your Google Sheet ID in Settings');
      document.querySelector('[data-tab="settings"]').click();
    }
  });
  
  document.getElementById('sendNow').addEventListener('click', async () => {
    const btn = document.getElementById('sendNow');
    btn.disabled = true;
    btn.textContent = '⏳ Sending...';
    
    try {
      const response = await chrome.runtime.sendMessage({ action: 'sendOneNow' });
      
      if (response.success) {
        btn.textContent = '✓ Sent!';
        const count = parseInt(document.getElementById('sentCount').textContent) + 1;
        document.getElementById('sentCount').textContent = count;
      } else {
        btn.textContent = '❌ ' + (response.error || 'Failed');
      }
    } catch (error) {
      btn.textContent = '❌ Error';
    }
    
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = '🚀 Send 1 Now';
    }, 3000);
  });
  
  // ============================================
  // CHECK AUTO-SEND STATUS
  // ============================================
  
  const autoSettings = await chrome.storage.local.get(['autoSendEnabled', 'sendTime', 'selectedCampaign', 'dailyLimit']);
  if (autoSettings.autoSendEnabled && autoSettings.selectedCampaign) {
    updateAutoSendUI(true);
    const limit = Math.min(autoSettings.dailyLimit || 25, 25);
    document.getElementById('statusText').textContent = `⏰ Scheduled for ${autoSettings.sendTime || '10:00'} (max ${limit}/day)`;
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function updateAutoSendUI(running) {
  const startBtn = document.getElementById('startAutoSend');
  const stopBtn = document.getElementById('stopAutoSend');
  const statusBox = document.getElementById('autoSendStatus');
  
  if (running) {
    startBtn.style.display = 'none';
    stopBtn.style.display = 'block';
    statusBox.style.display = 'block';
    statusBox.className = 'status-box running';
  } else {
    startBtn.style.display = 'block';
    stopBtn.style.display = 'none';
    statusBox.style.display = 'none';
    statusBox.className = 'status-box';
    document.getElementById('statusText').textContent = 'Not running';
  }
}

async function loadCampaigns() {
  const select = document.getElementById('campaignSelect');
  if (!select) return;
  
  select.innerHTML = '<option value="">Loading...</option>';
  
  try {
    const response = await chrome.runtime.sendMessage({ action: 'getCampaigns' });
    
    select.innerHTML = '<option value="">Select a campaign...</option>';
    
    if (response.campaigns && response.campaigns.length > 0) {
      response.campaigns.forEach(campaign => {
        const option = document.createElement('option');
        option.value = campaign.name;
        option.textContent = `${campaign.name} (${campaign.pending} pending)`;
        select.appendChild(option);
      });
      
      // Select previously chosen campaign
      const settings = await chrome.storage.local.get(['selectedCampaign']);
      if (settings.selectedCampaign) {
        select.value = settings.selectedCampaign;
      }
      
      // Update pending count
      const totalPending = response.campaigns.reduce((sum, c) => sum + c.pending, 0);
      const pendingEl = document.getElementById('pendingCount');
      if (pendingEl) pendingEl.textContent = totalPending;
    }
  } catch (error) {
    select.innerHTML = '<option value="">Error loading campaigns</option>';
  }
}
