// Background service worker for API calls, Google Sheets integration, and Auto-Send

// ============================================
// SAFE SETTINGS & STATE
// ============================================

const SAFE_SETTINGS = {
  // Safe limits - LinkedIn-friendly
  MAX_DAILY_LIMIT: 25,           // Never exceed 25/day
  MIN_DELAY_MINUTES: 3,          // Minimum 3 minutes between sends
  MAX_DELAY_MINUTES: 7,          // Maximum 7 minutes between sends
  BUSINESS_HOURS_START: 9,       // Only send after 9 AM
  BUSINESS_HOURS_END: 18,        // Only send before 6 PM
  WARM_UP_DAYS: 7,               // Warm-up period
  WARM_UP_START_LIMIT: 5,        // Start with 5/day during warm-up
};

const DEFAULT_SETTINGS = {
  spreadsheetId: '',
  openaiApiKey: '',
  dailyLimit: 25,                // Default: 25/day
  sendTime: '10:00',
  autoSendEnabled: false,
  selectedCampaign: '',
  accountCreatedDate: null,      // For warm-up tracking
};

let autoSendState = {
  running: false,
  sentToday: 0,
  lastReset: null,
  warmUpDay: 1
};

// ============================================
// MESSAGE HANDLERS
// ============================================

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "saveLeads") {
    handleSaveLeads(request.leads, request.campaignName)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === "generateAndSaveMessages") {
    handleGenerateAndSaveMessages(request.leads, request.campaignName)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === "getSettings") {
    chrome.storage.local.get(DEFAULT_SETTINGS, sendResponse);
    return true;
  }
  
  // Auto-send related messages
  if (request.action === "startAutoSend") {
    startAutoSend(request.config)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === "stopAutoSend") {
    stopAutoSend()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
  
  if (request.action === "getAutoSendStatus") {
    sendResponse({
      running: autoSendState.running,
      sentToday: autoSendState.sentToday,
      message: autoSendState.running ? `Sent ${autoSendState.sentToday} today` : 'Not running'
    });
    return true;
  }
  
  if (request.action === "getCampaigns") {
    getCampaigns()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message, campaigns: [] }));
    return true;
  }
  
  if (request.action === "sendOneNow") {
    sendOneConnectionRequest()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message, success: false }));
    return true;
  }
  
  if (request.action === "getSheetStats") {
    getSheetStats()
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }

  if (request.action === "suggestReplyDrafts") {
    handleSuggestReplyDrafts(request.payload)
      .then(sendResponse)
      .catch(error => sendResponse({ error: error.message }));
    return true;
  }
});

// ============================================
// AUTO-SEND SCHEDULER
// ============================================

async function startAutoSend(config) {
  const { dailyLimit, sendTime, campaign } = config;
  
  // Save config
  await chrome.storage.local.set({
    dailyLimit,
    sendTime,
    selectedCampaign: campaign,
    autoSendEnabled: true
  });
  
  // Create daily recurring alarm for scheduled time (for tomorrow onwards)
  const [hours, minutes] = sendTime.split(':').map(Number);
  const now = new Date();
  let scheduledTime = new Date();
  scheduledTime.setHours(hours, minutes, 0, 0);
  
  // If time has passed today, schedule for tomorrow
  if (scheduledTime <= now) {
    scheduledTime.setDate(scheduledTime.getDate() + 1);
  }
  
  const delayMinutes = (scheduledTime - now) / 60000;
  
  // Create daily alarm for recurring sends
  await chrome.alarms.create('dailyAutoSend', {
    delayInMinutes: delayMinutes,
    periodInMinutes: 24 * 60 // Repeat daily
  });
  
  // Also create midnight reset alarm
  await chrome.alarms.create('midnightReset', {
    periodInMinutes: 24 * 60,
    when: getMidnightTimestamp()
  });
  
  autoSendState.running = true;
  
  console.log(`LLH: Auto-send scheduled for ${sendTime} daily`);
  
  // START IMMEDIATELY - don't wait for scheduled time!
  console.log('LLH: Starting auto-send NOW');
  await chrome.alarms.create('sendNext', { delayInMinutes: 0.1 }); // Start in 6 seconds
  
  return { success: true, scheduledFor: sendTime };
}

async function stopAutoSend() {
  await chrome.alarms.clear('dailyAutoSend');
  await chrome.alarms.clear('midnightReset');
  await chrome.alarms.clear('sendNext');
  await chrome.storage.local.set({ autoSendEnabled: false });
  
  autoSendState.running = false;
  
  return { success: true };
}

// Handle alarms
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'dailyAutoSend') {
    console.log('Daily auto-send triggered');
    await runAutoSendBatch();
  }
  
  if (alarm.name === 'midnightReset') {
    console.log('Midnight reset - clearing daily count');
    autoSendState.sentToday = 0;
    await chrome.storage.local.set({ stats: { ...await getStats(), sentToday: 0 } });
  }
  
  if (alarm.name === 'sendNext') {
    await sendNextInQueue();
  }
});

// Run auto-send batch
async function runAutoSendBatch() {
  const settings = await chrome.storage.local.get(['dailyLimit', 'selectedCampaign', 'autoSendEnabled']);
  
  if (!settings.autoSendEnabled) {
    console.log('Auto-send is disabled');
    return;
  }
  
  const limit = Math.min(settings.dailyLimit || 25, SAFE_SETTINGS.MAX_DAILY_LIMIT);
  const remaining = limit - autoSendState.sentToday;
  
  if (remaining <= 0) {
    console.log('Daily limit reached');
    return;
  }
  
  console.log(`Starting auto-send batch: ${remaining} remaining`);
  
  // Start the queue
  await chrome.alarms.create('sendNext', { delayInMinutes: 0.1 });
}

// Send next lead in queue - WITH SAFETY MEASURES
async function sendNextInQueue() {
  const settings = await chrome.storage.local.get(['dailyLimit', 'selectedCampaign', 'spreadsheetId', 'autoSendEnabled']);
  
  // Check if auto-send is still enabled
  if (!settings.autoSendEnabled) {
    console.log('LLH: Auto-send disabled, stopping queue');
    return;
  }
  
  // LOG business hours but don't block (user might want to run tests)
  const currentHour = new Date().getHours();
  if (currentHour < SAFE_SETTINGS.BUSINESS_HOURS_START || currentHour >= SAFE_SETTINGS.BUSINESS_HOURS_END) {
    console.log('LLH: Note - running outside typical business hours (9 AM - 6 PM)');
    // Continue anyway - don't block
  }
  
  // SAFETY CHECK 2: Calculate safe daily limit (with warm-up)
  let safeLimit = Math.min(settings.dailyLimit || 25, SAFE_SETTINGS.MAX_DAILY_LIMIT);
  
  // Apply warm-up: start with 5/day, gradually increase
  if (autoSendState.warmUpDay <= SAFE_SETTINGS.WARM_UP_DAYS) {
    const warmUpLimit = SAFE_SETTINGS.WARM_UP_START_LIMIT + 
                        Math.floor((autoSendState.warmUpDay - 1) * 
                        (SAFE_SETTINGS.MAX_DAILY_LIMIT - SAFE_SETTINGS.WARM_UP_START_LIMIT) / 
                        SAFE_SETTINGS.WARM_UP_DAYS);
    safeLimit = Math.min(safeLimit, warmUpLimit);
    console.log(`LLH: Warm-up day ${autoSendState.warmUpDay}, limit: ${safeLimit}/day`);
  }
  
  // SAFETY CHECK 3: Daily limit
  if (autoSendState.sentToday >= safeLimit) {
    console.log(`LLH: Daily limit (${safeLimit}) reached, stopping for today`);
    return;
  }
  
  try {
    // Get next pending lead from sheet
    const lead = await getNextPendingLead(settings.selectedCampaign);
    
    if (!lead) {
      console.log('LLH: No more pending leads in campaign');
      return;
    }
    
    console.log(`LLH: Processing lead: ${lead.name}`);
    
    // Send connection request
    const result = await sendConnectionRequest(lead);
    
    if (result.success) {
      autoSendState.sentToday++;
      
      // Update sheet status
      await updateLeadStatus(lead.rowIndex, 'sent', settings.selectedCampaign);
      
      // Update stats
      await updateStats({ sentToday: autoSendState.sentToday });
      
      // SAFE DELAY: 3-7 minutes random (not 1-2 minutes!)
      const minDelay = SAFE_SETTINGS.MIN_DELAY_MINUTES;
      const maxDelay = SAFE_SETTINGS.MAX_DELAY_MINUTES;
      const delay = minDelay + Math.random() * (maxDelay - minDelay);
      
      console.log(`LLH: Sent to ${lead.name}, ${autoSendState.sentToday}/${safeLimit} today. Next in ${delay.toFixed(1)} min`);
      
      await chrome.alarms.create('sendNext', { delayInMinutes: delay });
    } else {
      // Mark as failed
      await updateLeadStatus(lead.rowIndex, 'failed', settings.selectedCampaign);
      console.log(`LLH: Failed for ${lead.name}: ${result.error}`);
      
      // Longer delay on failure (5 minutes)
      await chrome.alarms.create('sendNext', { delayInMinutes: 5 });
    }
  } catch (error) {
    console.error('LLH: Error in send queue:', error);
    // Retry after longer delay on error (10 minutes)
    await chrome.alarms.create('sendNext', { delayInMinutes: 10 });
  }
}

// Send one connection request immediately
async function sendOneConnectionRequest() {
  const settings = await chrome.storage.local.get(['selectedCampaign', 'spreadsheetId']);
  
  if (!settings.selectedCampaign) {
    throw new Error('Please select a campaign first');
  }
  
  if (!settings.spreadsheetId) {
    throw new Error('Please set Google Sheet ID in settings');
  }
  
  console.log('LLH: Looking for pending leads in:', settings.selectedCampaign);
  
  let lead;
  try {
    lead = await getNextPendingLead(settings.selectedCampaign);
  } catch (error) {
    console.error('LLH: Error getting lead:', error);
    throw new Error('Cannot read sheet: ' + error.message);
  }
  
  if (!lead) {
    throw new Error('No pending leads found in "' + settings.selectedCampaign + '"');
  }
  
  console.log('LLH: Found lead:', lead.name, lead.profileUrl);
  
  const result = await sendConnectionRequest(lead);
  
  if (result.success) {
    await updateLeadStatus(lead.rowIndex, 'sent', settings.selectedCampaign);
    autoSendState.sentToday++;
    await updateStats({ sentToday: autoSendState.sentToday });
    return { success: true, name: lead.name };
  } else {
    await updateLeadStatus(lead.rowIndex, 'failed', settings.selectedCampaign);
    throw new Error(result.error || 'Failed to send');
  }
}

// ============================================
// LINKEDIN SENDER (Opens tab and sends)
// ============================================

async function sleepMs(ms) {
  await new Promise(r => setTimeout(r, ms));
}

// Service worker often has no "current window" (alarms) — must pick/create one
async function openLeadTab(url) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const windows = await chrome.windows.getAll({ windowTypes: ['normal'] });
      const target =
        windows.find(w => w.focused && w.id != null) ||
        windows.find(w => w.id != null) ||
        null;

      if (target?.id != null) {
        return await chrome.tabs.create({ url, active: true, windowId: target.id });
      }

      const created = await chrome.windows.create({ url, focused: true, type: 'normal' });
      return created.tabs?.[0] || null;
    } catch (e) {
      const msg = String(e?.message || e).toLowerCase();
      if (msg.includes('cannot be edited') || msg.includes('dragging')) {
        await sleepMs(500 + attempt * 300);
        continue;
      }
      throw e;
    }
  }
  return null;
}

async function runInTab(tabId, func, args = [], options = {}) {
  const { allFrames = false } = options;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const injectionResults = await chrome.scripting.executeScript({
        target: allFrames ? { tabId, allFrames: true } : { tabId },
        func,
        args,
        world: 'MAIN'
      });
      const results = (injectionResults || [])
        .map(r => r?.result)
        .filter(r => r != null && typeof r === 'object');

      if (!allFrames) return results[0] || null;

      const success = results.find(r =>
        r.ready === true ||
        r.clicked === true ||
        r.found === true ||
        r.ok === true ||
        r.alreadyHasTextarea === true
      );
      if (success) return success;
      return results.find(r => r.error) || results[0] || null;
    } catch (e) {
      const msg = String(e?.message || e).toLowerCase();
      if ((msg.includes('cannot be edited') || msg.includes('dragging')) && attempt < 2) {
        await sleepMs(500);
        continue;
      }
      return { error: e.message };
    }
  }
  return { error: 'Tab script injection failed' };
}

async function sendConnectionRequest(lead) {
  let tab = null;
  const MIN_TAB_MS = 20000; // Tab must stay open at least 20 seconds
  const STEP_MS = 2000;
  const started = Date.now();

  const ensureMinLifetime = async () => {
    const wait = MIN_TAB_MS - (Date.now() - started);
    if (wait > 0) await sleepMs(wait);
  };

  const closeTabSafe = async () => {
    if (!tab?.id) return;
    await ensureMinLifetime();
    const tabId = tab.id;
    tab = null;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await chrome.tabs.get(tabId);
        await chrome.tabs.remove(tabId);
        return;
      } catch (e) {
        const msg = String(e?.message || e).toLowerCase();
        if (msg.includes('no tab') || msg.includes('invalid tab')) return;
        if (msg.includes('cannot be edited') || msg.includes('dragging')) {
          await sleepMs(400 + attempt * 200);
          continue;
        }
        return;
      }
    }
  };

  const stepDelay = async () => {
    await sleepMs(STEP_MS);
  };
  
  try {
    tab = await openLeadTab(lead.profileUrl);
    if (!tab?.id) {
      return { success: false, error: 'Could not open profile tab (no browser window)' };
    }
    
    console.log('LLH: Opened profile:', lead.profileUrl);
    
    // Profile load: wait 2–5s, keep polling until ready (no early tab close)
    const loadMs = 2000 + Math.floor(Math.random() * 3001);
    const loadDeadline = Date.now() + loadMs;
    let ready = false;
    while (Date.now() < loadDeadline) {
      const state = await runInTab(tab.id, isProfileReady);
      if (state?.ready) {
        ready = true;
        break;
      }
      await sleepMs(400);
    }
    if (!ready) {
      for (let i = 0; i < 15 && !ready; i++) {
        const state = await runInTab(tab.id, isProfileReady);
        if (state?.ready) {
          ready = true;
          break;
        }
        await sleepMs(400);
      }
    }
    
    await stepDelay();
    let connectResult = await runInTab(tab.id, findAndClickConnect);
    console.log('LLH: Direct connect result:', connectResult);
    
    if (!connectResult?.found) {
      console.log('LLH: Trying More dropdown...');
      await stepDelay();
      const moreResult = await runInTab(tab.id, clickMoreDropdown);
      console.log('LLH: More click:', moreResult);
      await stepDelay();
      
      for (let i = 0; i < 8 && !connectResult?.found; i++) {
        connectResult = await runInTab(tab.id, clickConnectFromDropdown);
        if (connectResult?.found) break;
        await sleepMs(600);
      }
    }
    
    if (!connectResult?.found) {
      await closeTabSafe();
      return { success: false, error: connectResult?.error || 'Connect not found in profile or dropdown' };
    }
    
    console.log('LLH: Connect triggered via', connectResult.via || connectResult.from);
    
    await stepDelay();
    let inviteReady = false;
    for (let i = 0; i < 30 && !inviteReady; i++) {
      const invite = await runInTab(tab.id, waitForInviteModal, [], { allFrames: true });
      if (invite?.ready) {
        inviteReady = true;
        console.log('LLH: Invite UI ready', invite);
        break;
      }
      await sleepMs(400);
    }
    
    if (!inviteReady) {
      await closeTabSafe();
      return { success: false, error: 'Invite dialog did not appear after Connect' };
    }
    
    if (lead.message) {
      await stepDelay();
      let addClicked = false;
      for (let i = 0; i < 20 && !addClicked; i++) {
        const r = await runInTab(tab.id, clickAddNoteButton, [], { allFrames: true });
        console.log('LLH: Add a note click', r);
        if (r?.clicked || r?.alreadyHasTextarea) {
          addClicked = true;
          break;
        }
        await sleepMs(500);
      }
      if (!addClicked) {
        await closeTabSafe();
        return { success: false, error: 'Add a note button not clicked' };
      }

      await stepDelay();
      let typedOk = false;
      for (let i = 0; i < 25 && !typedOk; i++) {
        const typed = await runInTab(tab.id, typeInviteMessage, [lead.message], { allFrames: true });
        console.log('LLH: Type message', typed);
        if (typed?.ok) {
          typedOk = true;
          break;
        }
        await sleepMs(400);
      }
      if (!typedOk) {
        await closeTabSafe();
        return { success: false, error: 'Could not type invite note' };
      }
    } else {
      await stepDelay();
      let sendWithout = null;
      for (let i = 0; i < 15; i++) {
        sendWithout = await runInTab(tab.id, clickSendWithoutNote, [], { allFrames: true });
        if (sendWithout?.clicked) break;
        await sleepMs(400);
      }
      if (!sendWithout?.clicked) {
        await closeTabSafe();
        return { success: false, error: 'Send without a note not found' };
      }
      await closeTabSafe();
      return { success: true };
    }
    
    await stepDelay();
    let sendResult = null;
    for (let i = 0; i < 20; i++) {
      sendResult = await runInTab(tab.id, clickSendInvitation, [], { allFrames: true });
      console.log('LLH: Send invitation', sendResult);
      if (sendResult?.clicked) break;
      await sleepMs(500);
    }
    
    if (!sendResult?.clicked) {
      await closeTabSafe();
      return { success: false, error: sendResult?.error || 'Send invitation button not found' };
    }
    
    await closeTabSafe();
    return { success: true };
    
  } catch (error) {
    const msg = String(error?.message || error).toLowerCase();
    if (!msg.includes('cannot be edited') && !msg.includes('dragging')) {
    console.error('LLH: Send error:', error);
    }
    await closeTabSafe();
    return { success: false, error: error.message };
  }
}

// ============================================
// INJECTED FUNCTIONS (run in LinkedIn page context)
// ============================================

function isProfileReady() {
  const hasConnect =
    !!document.querySelector('a[href*="/preload/custom-invite"]') ||
    [...document.querySelectorAll('button, a')].some(el => {
      const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
      return t.includes('connect') || t.includes('pending') || t.includes('message');
    });
  const hasMore = [...document.querySelectorAll('button')].some(b => (b.getAttribute('aria-label') || '') === 'More');
  return { ready: hasConnect || hasMore, url: location.href };
}

function waitForInviteModal() {
  // Must be self-contained: executeScript only injects this function
  const docs = [document];
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const d = iframe.contentDocument;
      if (d && d.documentElement) docs.push(d);
    } catch (e) {}
  }

  for (const doc of docs) {
    const byHeading = [...doc.querySelectorAll('h2')].some(h =>
      /add a note to your invitation/i.test(h.textContent || '')
    );
    const addNote = doc.querySelector('button[aria-label="Add a note"]');
    const sendWithout = doc.querySelector('button[aria-label="Send without a note"]');
    const sendInvite = doc.querySelector('button[aria-label="Send invitation"]');
    const textarea = doc.querySelector('textarea#custom-message, textarea[name="message"]');
    let href = '';
    try { href = doc.defaultView?.location?.href || ''; } catch (e) {}
    const onInviteUrl = /\/preload\/custom-invite/i.test(href) || /\/preload\/\?_bprMode/i.test(href);
    const dialog = [...doc.querySelectorAll('[role="dialog"], dialog, .artdeco-modal')].find(d =>
      /add a note|invitation|send without/i.test(d.innerText || '')
    );
    const ready = !!(byHeading || addNote || sendWithout || sendInvite || textarea || (onInviteUrl && dialog));
    if (ready) {
      return {
        ready: true,
        onInviteUrl,
        hasAddNote: !!addNote,
        hasSendWithout: !!sendWithout,
        hasTextarea: !!textarea,
        url: href || location.href
      };
    }
  }
  return {
    ready: false,
    onInviteUrl: false,
    hasAddNote: false,
    hasSendWithout: false,
    hasTextarea: false,
    url: location.href
  };
}

function findAndClickConnect() {
  function isSidebar(el) {
    if (!el) return true;
    if (el.closest('aside')) return true;
    if (el.closest('[data-view-name="profile-right-rail"]')) return true;
    const nearby = (el.closest('section, div')?.innerText || '').slice(0, 180).toLowerCase();
    if (/explore premium profiles|more profiles for you/i.test(nearby)) return true;
    return false;
  }

  const pending = [...document.querySelectorAll('button, a')].some(el => {
    const t = ((el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '')).toLowerCase();
    return /\bpending\b/.test(t) || /withdraw/.test(t);
  });
  if (pending) {
    return { found: false, error: 'Connection already pending' };
  }

  const vanity = (location.pathname.match(/\/in\/([^\/]+)/) || [])[1] || '';

  let connectEl =
    [...document.querySelectorAll('a[href*="/preload/custom-invite"]')].find(a => {
      if (isSidebar(a)) return false;
      const href = a.getAttribute('href') || '';
      return !vanity || href.includes(vanity);
    }) || null;

  if (!connectEl) {
    connectEl = [...document.querySelectorAll('a, button')].find(el => {
      if (isSidebar(el)) return false;
      const aria = (el.getAttribute('aria-label') || '');
      return /invite .+ to connect/i.test(aria);
    }) || null;
  }

  if (!connectEl) {
    connectEl = [...document.querySelectorAll('a, button')].find(el => {
      if (isSidebar(el)) return false;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return text === 'connect' || text === '+ connect';
    }) || null;
  }

  if (!connectEl) {
    return { found: false, error: 'Connect control not found in main profile' };
  }

  connectEl.click();
  return {
    found: true,
    via: connectEl.tagName,
    aria: connectEl.getAttribute('aria-label') || '',
    href: connectEl.getAttribute('href') || ''
  };
}

function clickMoreDropdown() {
  const candidates = [...document.querySelectorAll('button')].filter(b => {
    const aria = (b.getAttribute('aria-label') || '').trim();
    if (aria !== 'More' && aria !== 'More actions') return false;
    if (b.closest('aside')) return false;
    if (b.closest('footer')) return false;
    return true;
  });

  const moreBtn =
    candidates.find(b => {
      const root = b.parentElement?.parentElement || b.parentElement;
      const txt = (root?.innerText || '').toLowerCase();
      return /follow|message|connect/i.test(txt);
    }) || candidates[0];

  if (!moreBtn) return { clicked: false, error: 'More button not found' };
    moreBtn.click();
    return { clicked: true };
}

function clickConnectFromDropdown() {
  const menuConnect =
    document.querySelector('[role="menu"] a[role="menuitem"][href*="/preload/custom-invite"]') ||
    [...document.querySelectorAll('[role="menu"] [role="menuitem"]')].find(el => {
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
      return text === 'connect';
    });

  if (menuConnect) {
    menuConnect.click();
    return { found: true, from: 'menu-menuitem', href: menuConnect.getAttribute('href') || '' };
  }

  const anyMenuItem = [...document.querySelectorAll('[role="menuitem"]')].find(el => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
    const href = el.getAttribute('href') || '';
    return text === 'connect' || href.includes('/preload/custom-invite');
  });
  if (anyMenuItem) {
    anyMenuItem.click();
    return { found: true, from: 'menuitem', href: anyMenuItem.getAttribute('href') || '' };
  }

  return { found: false, error: 'Connect not found in dropdown' };
}

function clickAddNoteButton() {
  const docs = [document];
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const d = iframe.contentDocument;
      if (d && d.documentElement) docs.push(d);
    } catch (e) {}
  }

  for (const doc of docs) {
    const heading = [...doc.querySelectorAll('h2')].find(h =>
      /add a note to your invitation/i.test(h.textContent || '')
    );
    const modal =
      heading?.closest('.artdeco-modal') ||
      heading?.closest('[role="dialog"]') ||
      [...doc.querySelectorAll('.artdeco-modal, [role="dialog"]')].find(d =>
        /add a note to your invitation/i.test(d.innerText || '')
      ) ||
      doc;

    const ta =
      modal.querySelector('textarea#custom-message') ||
      modal.querySelector('textarea[name="message"]') ||
      doc.querySelector('textarea#custom-message') ||
      doc.querySelector('textarea[name="message"]');
    if (ta) {
      return { alreadyHasTextarea: true, clicked: false };
    }

    const addNoteBtn =
      modal.querySelector('button[aria-label="Add a note"]') ||
      doc.querySelector('button[aria-label="Add a note"]') ||
      [...modal.querySelectorAll('button')].find(b => {
        const aria = (b.getAttribute('aria-label') || '').trim().toLowerCase();
        const text = (b.innerText || b.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return aria === 'add a note' || text === 'add a note';
      });

    if (!addNoteBtn) continue;

    const view = doc.defaultView || window;
    addNoteBtn.scrollIntoView({ block: 'center', inline: 'center' });
    addNoteBtn.focus();
    addNoteBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view }));
    addNoteBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view }));
    addNoteBtn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view }));
    addNoteBtn.click();

    return {
      clicked: true,
      aria: addNoteBtn.getAttribute('aria-label') || '',
      text: (addNoteBtn.innerText || '').trim()
    };
  }

  return { clicked: false, error: 'Add a note button not found' };
}

function typeInviteMessage(message) {
  const docs = [document];
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const d = iframe.contentDocument;
      if (d && d.documentElement) docs.push(d);
    } catch (e) {}
  }

  for (const doc of docs) {
    const ta =
      doc.querySelector('textarea#custom-message') ||
      doc.querySelector('textarea[name="message"]');
    if (!ta) continue;

    const desired = String(message || '').substring(0, 300);
    const view = doc.defaultView || window;
    ta.focus();
    ta.click();

    const proto = view.HTMLTextAreaElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(ta, desired);
    else ta.value = desired;

    ta.dispatchEvent(new InputEvent('input', { bubbles: true, data: desired, inputType: 'insertText' }));
    ta.dispatchEvent(new Event('change', { bubbles: true }));
    ta.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));

    return { ok: (ta.value || '').trim().length > 0, length: (ta.value || '').length };
  }

  return { ok: false, error: 'textarea missing' };
}

function clickSendWithoutNote() {
  const docs = [document];
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const d = iframe.contentDocument;
      if (d && d.documentElement) docs.push(d);
    } catch (e) {}
  }

  for (const doc of docs) {
    const btn =
      doc.querySelector('button[aria-label="Send without a note"]') ||
      [...doc.querySelectorAll('button')].find(b =>
        /send without a note/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || ''))
      );
    if (!btn || btn.disabled) continue;
    btn.click();
    return { clicked: true };
  }
  return { clicked: false, error: 'Send without a note not found' };
}

function clickSendInvitation() {
  const docs = [document];
  for (const iframe of document.querySelectorAll('iframe')) {
    try {
      const d = iframe.contentDocument;
      if (d && d.documentElement) docs.push(d);
    } catch (e) {}
  }

  for (const doc of docs) {
    const btn =
      doc.querySelector('button[aria-label="Send invitation"]') ||
      doc.querySelector('button[aria-label="Send now"]') ||
      [...doc.querySelectorAll('button')].find(b => {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const text = (b.innerText || '').replace(/\s+/g, ' ').trim().toLowerCase();
        return aria === 'send invitation' || aria === 'send now' || text === 'send';
      });

    if (!btn || btn.disabled) continue;
    btn.click();
    return { clicked: true, via: btn.getAttribute('aria-label') || (btn.innerText || '').trim() };
  }
  return { clicked: false, error: 'Send invitation not found' };
}

// ============================================
// GOOGLE SHEETS FUNCTIONS
// ============================================

// Get stats from Google Sheet for selected campaign
async function getSheetStats() {
  const settings = await chrome.storage.local.get(['spreadsheetId', 'selectedCampaign']);
  
  if (!settings.spreadsheetId || !settings.selectedCampaign) {
    return { total: 0, pending: 0, sentToday: 0 };
  }
  
  const token = await getAuthToken();
  const campaignName = settings.selectedCampaign;
  
  // Get all data from the campaign sheet (columns A-F)
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${settings.spreadsheetId}/values/${encodeURIComponent(campaignName)}!A:F`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  
  if (!response.ok) {
    throw new Error('Cannot read sheet data');
  }
  
  const data = await response.json();
  const rows = data.values || [];
  
  if (rows.length <= 1) {
    return { total: 0, pending: 0, sentToday: 0 };
  }
  
  // Get today's date in YYYY-MM-DD format for comparison
  const today = new Date().toISOString().split('T')[0];
  
  let total = 0;
  let pending = 0;
  let sentToday = 0;
  
  // Skip header row
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0]) continue; // Skip empty rows
    
    total++;
    const status = (row[3] || '').toLowerCase().trim(); // Column D = Status
    const sentDate = row[5] || ''; // Column F = Sent Date
    
    if (status === 'pending') {
      pending++;
    } else if (status === 'sent') {
      // Check if sent today
      if (sentDate && sentDate.includes(today)) {
        sentToday++;
      }
    }
  }
  
  return { total, pending, sentToday };
}

async function getCampaigns() {
  console.log('LLH: getCampaigns() called');
  
  const settings = await chrome.storage.local.get(['spreadsheetId']);
  console.log('LLH: Spreadsheet ID:', settings.spreadsheetId);
  
  if (!settings.spreadsheetId) {
    console.log('LLH: No spreadsheet ID configured');
    return { campaigns: [] };
  }
  
  try {
    const token = await getAuthToken();
    console.log('LLH: Got auth token');
    
    // Get spreadsheet info to list all sheets
    const response = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${settings.spreadsheetId}`,
      { headers: { 'Authorization': `Bearer ${token}` } }
    );
    
    console.log('LLH: Spreadsheet API response status:', response.status);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('LLH: Cannot access spreadsheet:', response.status, errorText);
      throw new Error(`Cannot access spreadsheet: ${response.status} ${errorText}`);
    }
    
    const data = await response.json();
    console.log('LLH: Found sheets:', data.sheets?.map(s => s.properties.title));
    
    const campaigns = [];
    
    for (const sheet of data.sheets) {
      const title = sheet.properties.title;
      console.log('LLH: Processing sheet:', title);
      
      if (title === 'Settings' || title === 'Sheet1') {
        console.log('LLH: Skipping system sheet:', title);
        continue;
      }
      
      // Count pending leads in this sheet
      const valuesResponse = await fetch(
        `https://sheets.googleapis.com/v4/spreadsheets/${settings.spreadsheetId}/values/${encodeURIComponent(title)}!D:D`,
        { headers: { 'Authorization': `Bearer ${token}` } }
      );
      
      if (valuesResponse.ok) {
        const values = await valuesResponse.json();
        const pending = (values.values || []).filter(row => row[0] === 'pending').length;
        console.log(`LLH: Sheet "${title}" has ${pending} pending leads`);
        campaigns.push({ name: title, pending });
      } else {
        console.warn(`LLH: Could not read values from sheet "${title}":`, valuesResponse.status);
      }
    }
    
    console.log('LLH: Final campaigns list:', campaigns);
    return { campaigns };
    
  } catch (error) {
    console.error('LLH: Error in getCampaigns:', error);
    // Return empty array instead of throwing - allows UI to show "No campaigns"
    return { campaigns: [], error: error.message };
  }
}

async function getNextPendingLead(campaignName) {
  const settings = await chrome.storage.local.get(['spreadsheetId']);
  const token = await getAuthToken();
  
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${settings.spreadsheetId}/values/${encodeURIComponent(campaignName)}!A:G`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  
  if (!response.ok) {
    throw new Error('Cannot read campaign data');
  }
  
  const data = await response.json();
  const rows = data.values || [];
  
  // Find first pending lead (skip header)
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row[3] === 'pending') {
      return {
        rowIndex: i + 1, // 1-indexed for Sheets API
        name: row[0],
        profileUrl: row[1],
        headline: row[2],
        message: row[4] || ''
      };
    }
  }
  
  return null;
}

async function updateLeadStatus(rowIndex, status, campaignName) {
  const settings = await chrome.storage.local.get(['spreadsheetId']);
  const token = await getAuthToken();
  
  const sentDate = status === 'sent' ? new Date().toISOString() : '';
  
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${settings.spreadsheetId}/values/${encodeURIComponent(campaignName)}!D${rowIndex}:F${rowIndex}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        values: [[status, '', sentDate]]
      })
    }
  );
}

// ============================================
// EXISTING FUNCTIONS (Save, Generate, etc.)
// ============================================

async function handleSaveLeads(leads, campaignName) {
  const settings = await chrome.storage.local.get(['spreadsheetId']);
  
  if (!settings.spreadsheetId) {
    throw new Error("Please set your Google Sheet ID in the extension popup");
  }
  
  const token = await getAuthToken();
  const sheetName = sanitizeText(campaignName) || `campaign-${Date.now()}`;
  const spreadsheetId = settings.spreadsheetId;
  
  await ensureSheetExists(spreadsheetId, sheetName, token);
  
  const rows = leads.map(lead => [
    sanitizeText(lead.name),
    lead.profileUrl,
    sanitizeText(lead.headline || ''),
    'pending',
    '',
    '',
    new Date().toISOString()
  ]);
  
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A:G:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: rows })
    }
  );
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Failed to save to Google Sheets');
  }
  
  return { success: true, count: leads.length, sheetName };
}

async function getAuthToken() {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(token);
      }
    });
  });
}

async function ensureSheetExists(spreadsheetId, sheetName, token) {
  const infoResponse = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}`,
    { headers: { 'Authorization': `Bearer ${token}` } }
  );
  
  if (!infoResponse.ok) {
    throw new Error('Cannot access spreadsheet. Check Sheet ID.');
  }
  
  const spreadsheet = await infoResponse.json();
  const sheetExists = spreadsheet.sheets?.some(s => s.properties.title === sheetName);
  
  if (!sheetExists) {
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          requests: [{ addSheet: { properties: { title: sheetName } } }]
        })
      }
    );
    
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A1:G1?valueInputOption=USER_ENTERED`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          values: [['Name', 'Profile URL', 'Headline', 'Status', 'Message', 'Sent Date', 'Extracted Date']]
        })
      }
    );
  }
}

async function callOpenAiReplyDrafts(apiKey, systemPrompt, userPrompt) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 700,
      temperature: 0.7,
      response_format: { type: 'json_object' }
    })
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    throw new Error('Failed to draft replies' + (errText ? `: ${errText.slice(0, 120)}` : ''));
  }

  const data = await response.json();
  return data.choices[0]?.message?.content?.trim() || '';
}

function isOnlyCounterQuestion(text) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return true;
  if (!t.includes('?')) return false;
  const sentences = t.split(/(?<=[.!?])\s+/).map(s => s.trim()).filter(Boolean);
  const statements = sentences.filter(s => !s.includes('?'));
  return !statements.some(s => s.replace(/[^a-zA-Z0-9]/g, '').length >= 12);
}

function draftsAnswerQuestion(options) {
  if (!options?.length) return false;
  return options.every(opt => {
    const first = opt.messages?.[0];
    return first && !isOnlyCounterQuestion(first);
  });
}

function buildSuggestReplySystemPrompt(goal) {
  return `You draft LinkedIn chat replies for Muhammad Atif.

NORTH STAR — every conversation should move, gradually, toward one of:
1. Time-waste discovery — what eats their time / ops bottleneck that AI or automation can help
2. Collab / swap notes — peer exchange on a real problem they already named
3. Soft meeting — a short call only when stage is warm AND they are open

Never force an AI pitch on declined. Never skip answering their direct question.

SENDER:
- Muhammad Atif — Lead AI Product Architect @ Schmoozzer
- Builds AI agents, LLM systems, business automation
- Voice: short, concrete, peer. Like a smart operator — not a coach, closer, or cheerleader.

GOAL (user-picked — follow strictly): ${goal}
- rapport: Human only; no meeting; light curiosity. No AI pitch. No CTA.
- work: Answer first if they asked. Surface time-waste / bottleneck in THEIR world. Soft bridge to how AI/systems help — no hard CTA, no meeting ask.
- ask: Same as work, plus ONE soft CTA if natural: swap notes / 15-min compare / intro.
- close: Graceful exit; no AI pitch; no meeting.

TASK:
1) Classify stage: early | mid | warm | cooling | declined
2) Return exactly 2 options (A and B), each a STACK of 2–3 short messages he sends one-by-one.

DECLINED (narrow — do NOT overuse):
ONLY if they clearly refuse AI / tech / his offer / further pitch, e.g. "completely out from the AI field", "not interested in AI", "don't pitch me".
NOT declined when they:
- won't promise intros (that's a boundary, conversation continues)
- share a newsletter / ask coaching questions
- engage warmly about career/positioning
Those are mid or warm.

STAGE RULES:
- early: acknowledge + one specific work question. NO meeting ask.
- mid: answer their question / react + light bridge toward the north star, per GOAL.
- warm: answer fully; GOAL=ask may include a soft CTA; GOAL=work stays no hard CTA.
- cooling: short human close / light reopen. No hard push.
- declined: topic refusal only — respect it; no AI pitch; no meeting.

ANSWER FIRST:
If their LAST message contains a question mark, Bubble 1 of EVERY option MUST answer it with a concrete statement.
Bubble 1 must NOT be only a counter-question (e.g. do not reply with just "What's your biggest challenge?").
Example: if they ask "magic wand / 6 months from now what would that look like?" → describe the outcome, then optionally follow up.

STACK RULES:
- Default 2 bubbles; 3 only if mid/warm and natural.
- Bubble 1 = answer / react to THEIR last line (question → answer).
- Msg 2 MUST add new information OR a real ask — never filler ("makes sense", "got it", "appreciate that").
- Match their length/energy. Under ~280 chars per bubble.
- Option A = clearer direct path to the GOAL. Option B = warmer variant. Both still toward the north star when goal is work or ask.

BANNED FLUFF:
"I appreciate that", "truly unique", "wishing you the best", "fascinating", "synergies", "would love to connect", "that's amazing", "great question"

Ban when declined: AI pitch / meeting about AI.
Ban cross-thread topics that do not appear in THIS chat.

OUTPUT: strict JSON only, no markdown:
{"stage":"early|mid|warm|cooling|declined","options":[{"id":"A","messages":["...","..."]},{"id":"B","messages":["...","..."]}]}`;
}

async function handleSuggestReplyDrafts(payload = {}) {
  const settings = await chrome.storage.local.get(['openaiApiKey']);
  if (!settings.openaiApiKey) {
    throw new Error('Please set your OpenAI API key in settings');
  }

  const peerName = sanitizeText(payload.peerName || 'there');
  const peerHeadline = sanitizeText(payload.peerHeadline || '');
  const senderName = sanitizeText(payload.senderName || 'Muhammad Atif');
  const goal = ['rapport', 'work', 'ask', 'close'].includes(payload.goal) ? payload.goal : 'work';
  const messages = Array.isArray(payload.messages) ? payload.messages.slice(-10) : [];

  if (!messages.length) {
    throw new Error('No conversation messages to draft from');
  }

  const threadLines = messages.map(m => {
    const who = m.role === 'me' ? senderName : (sanitizeText(m.sender) || peerName);
    return `${who}: ${sanitizeText(m.text || '')}`;
  }).join('\n\n');

  const lastThem = [...messages].reverse().find(m => m.role === 'them');
  const needsAnswer = /\?/.test(String(lastThem?.text || ''));

  const systemPrompt = buildSuggestReplySystemPrompt(goal);
  const userPrompt = `Peer name: ${peerName}
Peer headline: ${peerHeadline || '(not visible)'}
Sender: ${senderName}
Goal: ${goal}

Thread (oldest → newest) — THIS conversation only with ${peerName}:
${threadLines}

Weight their LAST message heaviest.
- Draft ONLY for ${peerName}. Do not invent logistics/retirement/AI-refusal topics unless they appear in THIS thread.
- If their last message contains a question → answer it in msg 1 of every option. Do not reply with only a counter-question.
- Msg 2 must add new info or a real ask.
- Use stage=declined ONLY for clear AI/topic refusal — NOT for "I won't promise intros" or coaching questions.
- Option A = clearer path to goal "${goal}". Option B = warmer variant.

Return JSON with stage + options A/B as message stacks.`;

  const raw = await callOpenAiReplyDrafts(settings.openaiApiKey, systemPrompt, userPrompt);
  let result = normalizeSuggestReplyDrafts(raw, messages, goal);

  if (needsAnswer && !draftsAnswerQuestion(result.options)) {
    const repairPrompt = `${userPrompt}

REPAIR: Their last message contains a question. Msg 1 of EVERY option MUST answer it with a concrete statement first. Do NOT reply with only a counter-question.`;
    const repairedRaw = await callOpenAiReplyDrafts(settings.openaiApiKey, systemPrompt, repairPrompt);
    result = normalizeSuggestReplyDrafts(repairedRaw, messages, goal);
    if (!draftsAnswerQuestion(result.options)) {
      throw new Error("Draft didn't answer their question — try again");
    }
  }

  return result;
}

function normalizeSuggestReplyDrafts(raw, threadMessages = [], goal = 'work') {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Draft model returned invalid JSON');
    parsed = JSON.parse(match[0]);
  }

  const stage = String(parsed.stage || '').toLowerCase();
  let validStage = ['early', 'mid', 'warm', 'cooling', 'declined'].includes(stage) ? stage : 'mid';
  const validGoal = ['rapport', 'work', 'ask', 'close'].includes(goal) ? goal : 'work';

  let options = Array.isArray(parsed.options) ? parsed.options : [];
  options = options.slice(0, 2).map((opt, i) => {
    const id = opt.id === 'B' || i === 1 ? 'B' : 'A';
    let messages = Array.isArray(opt.messages) ? opt.messages : [];
    messages = messages
      .map(m => String(m || '').replace(/^["']|["']$/g, '').trim())
      .filter(Boolean)
      .map(m => m.slice(0, 300))
      .slice(0, 3);
    return { id, messages };
  }).filter(o => o.messages.length > 0);

  if (options.length === 0) {
    throw new Error('No usable reply options in model output');
  }

  if (options.length === 1) {
    options[0].id = 'A';
  } else {
    options[0].id = 'A';
    options[1].id = 'B';
  }

  const lastThem = [...threadMessages].reverse().find(m => m.role === 'them');
  const lastText = String(lastThem?.text || '').toLowerCase();

  // Topic refusal only — NOT intro boundaries / coaching questions
  const topicDeclined = /out (of|from) the ai(?:\s+field)?|not (into|in|interested in) ai|don't (do|want) ai|dont (do|want) ai|outside (of )?the ai field|no interest in ai|stop (pitching|pushing) ai/i.test(lastText);
  const askedQuestion = /\?/.test(String(lastThem?.text || ''));
  const softBoundaryOnly = /never want to promise|won't promise|dont want to promise|don't want to promise|keep you in mind|newsletter/i.test(lastText) && !topicDeclined;

  if (topicDeclined) {
    validStage = 'declined';
  } else if (validStage === 'declined' || softBoundaryOnly) {
    // Model over-tagged declined (e.g. intro boundary) — keep conversation going
    validStage = askedQuestion ? 'warm' : 'mid';
  }

  if (topicDeclined) {
    const aiPush = /\bAI\b|artificial intelligence|automation|agentic|machine learning|\bLLM\b|compare notes on how AI|reshaping.*AI|AI might|AI field/i;
    options = options.map(opt => {
      const cleaned = opt.messages.filter(m => !aiPush.test(m));
      if (cleaned.length >= 1) return { ...opt, messages: cleaned };
      return {
        ...opt,
        messages: [
          'Totally fair — thanks for saying that clearly.',
          'Appreciate you sharing your story either way.'
        ]
      };
    });
  }

  return { stage: validStage, goal: validGoal, options };
}

async function generatePersonalizedMessage(lead, apiKey) {
  const systemPrompt = `You write LinkedIn connection notes for Muhammad Atif that get accepted and pull replies toward WORK — without sounding like a spam template.

SENDER:
- Muhammad Atif — Lead AI Product Architect @ Schmoozzer
- Builds AI agents, LLM systems, business automation
- Peer tone: practical, specific, not salesy

AUDIENCE:
Mixed LinkedIn-active people (founders, coaches, assistants, marketers, operators, creators). Infer role from headline and pick the RIGHT work angle. Never force "automation" onto every role.

ROLE → WORK ANGLE (strict):
- Founder / CEO / Owner / Agency → ops bottlenecks, client delivery, scaling without more headcount
- Coach / Consultant / Creator / Author / Therapist → booking, client follow-up, content ops, onboarding — NOT "are you automating your coaching"
- Assistant / EA / Ops / Coordinator → inbox, scheduling, reporting, repetitive admin
- Marketer / Ads / Growth / Sales ops → reporting loops, lead routing, follow-up consistency
- Finance / Product / Engineering peer → one concrete workflow friction from THEIR domain (reporting, handoffs, tooling) — no fake praise
- Unclear headline → use the most concrete noun in the headline; ask one practical question about that work

QUESTION STYLES — pick ONE (rotate; do NOT default to "manual vs automated"):
1) Bottleneck: "Where does most time still disappear in [X]?"
2) Status: "Is [X] mostly handled, or still a weekly firefight?"
3) Tradeoff: "When [X] spikes, do you absorb it yourself or hand it off?"
4) Binary ops (use sparingly, mostly founders/ops/SaaS): "Is [X] still mostly manual on your side?"

STRUCTURE (max 280 chars total):
Hey {FirstName},

[1 short hook from THEIR headline — no fluff words] [1 work question from the styles above]

HARD BANS:
- fascinating / impressive / curious / would love to hear / passionate / exciting work
- synergies / hop on a call / love to connect / always looking to connect
- Same "manual or automated" ending on every note
- Inventing company details not in the headline
- Pitching your AI product

GOOD:
- "Hey Sara,

Scaling Meta-ad brands usually breaks first on reporting + lead follow-up. Where does most of that time still disappear for you?"

- "Hey Mike,

Coaching + client delivery gets messy at the booking → follow-up handoff. Is that mostly handled for you, or still a weekly firefight?"

- "Hey Ayesha,

EA days get eaten by inbox + scheduling triage. When that spikes, do you absorb it yourself or hand parts off?"

BAD:
- Every note ending with "still manual, or have you automated..."
- "Your work sounds fascinating! I'm curious about trends..."`;

  const firstName = lead.name.split(' ')[0];
  
  const userPrompt = `Write ONE LinkedIn connection note.

Name for greeting: ${firstName}
Full name: ${lead.name}
Headline/role: ${lead.headline || 'Professional on LinkedIn'}

Infer role → correct work angle → ONE varied question style (not always manual/automated).
Format:
Hey ${firstName},

[hook + one work question]

Max 280 characters. No quotes. No fluff adjectives. No pitch.`;

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      max_tokens: 120,
      temperature: 0.7
    })
  });
  
  if (!response.ok) {
    throw new Error("Failed to generate message");
  }
  
  const data = await response.json();
  return data.choices[0]?.message?.content?.trim() || '';
}

async function handleGenerateAndSaveMessages(leads, campaignName) {
  const settings = await chrome.storage.local.get(['spreadsheetId', 'openaiApiKey']);
  
  if (!settings.openaiApiKey) {
    throw new Error("Please set your OpenAI API key in settings");
  }
  
  if (!settings.spreadsheetId) {
    throw new Error("Please set your Google Sheet ID in settings");
  }
  
  const token = await getAuthToken();
  const spreadsheetId = settings.spreadsheetId;
  const sheetName = sanitizeText(campaignName) || 'Leads';
  
  const messages = [];
  for (const lead of leads) {
    // Sanitize lead data before generating message
    const sanitizedLead = {
      ...lead,
      name: sanitizeText(lead.name),
      headline: sanitizeText(lead.headline || '')
    };
    const message = await generatePersonalizedMessage(sanitizedLead, settings.openaiApiKey);
    messages.push({ ...sanitizedLead, message });
  }
  
  const rows = messages.map(lead => [
    lead.name,
    lead.profileUrl,
    lead.headline || '',
    'pending',
    sanitizeText(lead.message),
    '',
    new Date().toISOString()
  ]);
  
  await ensureSheetExists(spreadsheetId, sheetName, token);
  
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheetName)}!A:G:append?valueInputOption=USER_ENTERED`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ values: rows })
    }
  );
  
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error?.message || 'Failed to save to Google Sheets');
  }
  
  return { success: true, count: messages.length, messagesGenerated: true };
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

// Sanitize text to remove non-ISO-8859-1 characters that break fetch headers
function sanitizeText(text) {
  if (!text) return '';
  // Remove or replace characters outside ISO-8859-1 range (0-255)
  // This handles emojis, special Unicode chars, etc.
  return text
    .replace(/[\u{1F600}-\u{1F6FF}]/gu, '') // Remove emojis
    .replace(/[\u{2600}-\u{26FF}]/gu, '')   // Remove misc symbols
    .replace(/[\u{2700}-\u{27BF}]/gu, '')   // Remove dingbats
    .replace(/[\u{1F300}-\u{1F5FF}]/gu, '') // Remove misc symbols & pictographs
    .replace(/[\u{1F900}-\u{1F9FF}]/gu, '') // Remove supplemental symbols
    .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '') // Remove chess symbols
    .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '') // Remove symbols extended
    .replace(/[^\x00-\xFF]/g, '')            // Remove any remaining non-ISO-8859-1 chars
    .trim();
}

function getMidnightTimestamp() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setDate(midnight.getDate() + 1);
  midnight.setHours(0, 0, 0, 0);
  return midnight.getTime();
}

async function getStats() {
  const data = await chrome.storage.local.get(['stats']);
  return data.stats || { extracted: 0, sentToday: 0, pending: 0 };
}

async function updateStats(updates) {
  const stats = await getStats();
  await chrome.storage.local.set({ stats: { ...stats, ...updates } });
}

// Initialize on load
chrome.runtime.onInstalled.addListener(async () => {
  console.log('LinkedIn Lead Harvester installed');

  // Hard default daily limit
  await chrome.storage.local.set({ dailyLimit: 25 });
  
  // Check if auto-send was enabled
  const settings = await chrome.storage.local.get(['autoSendEnabled', 'sendTime', 'dailyLimit', 'selectedCampaign']);
  if (settings.autoSendEnabled && settings.selectedCampaign) {
    await startAutoSend({
      sendTime: settings.sendTime || '10:00',
      dailyLimit: settings.dailyLimit || 25,
      campaign: settings.selectedCampaign
    });
  }
});

console.log('LinkedIn Lead Harvester background script loaded');
