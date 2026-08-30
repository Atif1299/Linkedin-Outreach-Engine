# LinkedIn Lead Harvester - Complete Technical Documentation

## Overview

A Chrome extension that automates LinkedIn outreach by:
1. **Extracting leads** from LinkedIn post engagers (likers/commenters)
2. **Generating AI-powered personalized messages** using OpenAI
3. **Saving leads to Google Sheets** as a simple database
4. **Auto-sending connection requests** with personalized notes

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    CHROME EXTENSION                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ content.js   │    │ background.js │    │ popup.js     │  │
│  │              │    │               │    │              │  │
│  │ - Scrapes    │◄──►│ - API calls   │◄──►│ - Settings   │  │
│  │   LinkedIn   │    │ - Auto-send   │    │ - Stats      │  │
│  │ - Injects UI │    │ - Scheduling  │    │ - Controls   │  │
│  └──────────────┘    └───────┬───────┘    └──────────────┘  │
│                              │                               │
└──────────────────────────────┼───────────────────────────────┘
                               │
           ┌───────────────────┼───────────────────┐
           │                   │                   │
           ▼                   ▼                   ▼
    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
    │Google Sheets│    │   OpenAI    │    │  LinkedIn   │
    │   API       │    │   API       │    │  (scraping) │
    └─────────────┘    └─────────────┘    └─────────────┘
```

---

## File Structure

```
linkedin-lead-harvester/
├── manifest.json        # Extension config, permissions
├── background.js        # Service worker (API calls, auto-send logic)
├── content.js           # Injected into LinkedIn pages (scraping, UI)
├── popup/
│   ├── popup.html       # Extension popup UI
│   ├── popup.js         # Popup logic
│   └── popup.css        # Popup styling
└── icons/               # Extension icons
```

---

## Core Features & Implementation

### 1. Lead Extraction (content.js)

**How it works:**
- Detects LinkedIn post pages
- Injects "🎯 Extract Leads" button
- Scrapes likers/commenters by:
  1. Opening the reactions modal
  2. Scrolling to load all engagers
  3. Extracting name, headline, profile URL

**Key function:**
```javascript
async function extractLeads() {
  const leads = [];
  
  // Click reactions to open modal
  const reactionsButton = document.querySelector('[data-test-id="social-actions__reactions"]');
  reactionsButton.click();
  
  // Wait for modal
  await sleep(1500);
  
  // Get all reactor items
  const reactorItems = document.querySelectorAll('.social-details-reactors-tab-body-list-item');
  
  for (const item of reactorItems) {
    const nameEl = item.querySelector('.text-view-model');
    const headlineEl = item.querySelector('.text-body-small');
    const profileLink = item.querySelector('a[href*="/in/"]');
    
    leads.push({
      name: nameEl?.textContent?.trim(),
      headline: headlineEl?.textContent?.trim(),
      profileUrl: profileLink?.href
    });
  }
  
  return leads;
}
```

---

### 2. AI Message Generation (background.js)

**How it works:**
- Takes lead's name + headline
- Sends to OpenAI with customized prompt
- Returns personalized connection message

**Key function:**
```javascript
async function generatePersonalizedMessage(lead, apiKey) {
  const systemPrompt = `You are an expert at writing LinkedIn connection request messages...
  
YOUR PROFILE (the sender):
- Name: Muhammad Atif
- Role: Lead AI Product Architect @ Schmoozzer | AI Developer
- Expertise: AI Solutions Builder, Agentic AI, LLM architectures, AI automation

FORMAT:
Line 1: "Hey {FirstName},"
Line 2: (blank line)
Line 3-4: Short message (2-3 sentences max, casual tone)
...`;

  const firstName = lead.name.split(' ')[0];
  
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
      max_tokens: 100,
      temperature: 0.7
    })
  });
  
  const data = await response.json();
  return data.choices[0]?.message?.content?.trim();
}
```

---

### 3. Google Sheets Integration (background.js)

**Data Schema (per campaign sheet):**
| Column | Field | Description |
|--------|-------|-------------|
| A | Name | Lead's full name |
| B | Profile URL | LinkedIn profile URL |
| C | Headline | Job title/description |
| D | Status | pending / sent / failed |
| E | Message | AI-generated message |
| F | Sent Date | Timestamp when sent |
| G | Extracted Date | When lead was scraped |

**Key functions:**
```javascript
// Save leads to sheet
async function handleSaveLeads(leads, campaignName) {
  const token = await getAuthToken();
  const rows = leads.map(lead => [
    lead.name,
    lead.profileUrl,
    lead.headline,
    'pending',
    lead.message || '',
    '',  // Sent date (empty initially)
    new Date().toISOString()
  ]);
  
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${sheetName}!A:G:append`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ values: rows })
  });
}

// Update lead status
async function updateLeadStatus(rowIndex, status, campaign) {
  const token = await getAuthToken();
  const sentDate = status === 'sent' ? new Date().toISOString() : '';
  
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${campaign}!D${rowIndex}:F${rowIndex}`, {
    method: 'PUT',
    headers: { 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ values: [[status, '', sentDate]] })
  });
}

// Get next pending lead
async function getNextPendingLead(campaign) {
  const token = await getAuthToken();
  const response = await fetch(`.../${campaign}!A:F`);
  const data = await response.json();
  
  for (let i = 1; i < data.values.length; i++) {
    if (data.values[i][3] === 'pending') {
      return {
        rowIndex: i + 1,
        name: data.values[i][0],
        profileUrl: data.values[i][1],
        headline: data.values[i][2],
        message: data.values[i][4]
      };
    }
  }
  return null;
}
```

---

### 4. Auto-Send System (background.js)

**Safety Settings:**
```javascript
const SAFE_SETTINGS = {
  MAX_DAILY_LIMIT: 15,           // Never exceed 15/day
  MIN_DELAY_MINUTES: 3,          // Minimum 3 minutes between sends
  MAX_DELAY_MINUTES: 7,          // Maximum 7 minutes between sends
  BUSINESS_HOURS_START: 9,       // 9 AM
  BUSINESS_HOURS_END: 18,        // 6 PM
  WARM_UP_DAYS: 7,               // Gradual ramp-up period
  WARM_UP_START_LIMIT: 5,        // Start with 5/day
};
```

**Send Flow (6 steps):**
```javascript
async function sendConnectionRequest(lead) {
  // Step 1: Open profile in foreground tab
  const tab = await chrome.tabs.create({
    url: lead.profileUrl,
    active: true
  });
  
  // Step 2: Wait for page load (10 seconds)
  await sleep(10000);
  
  // Step 3: Find and click Connect button
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: findAndClickConnect
  });
  
  // If not found, try More dropdown
  if (!found) {
    await executeScript(clickMoreDropdown);
    await sleep(2000);
    await executeScript(clickConnectFromDropdown);
  }
  
  // Step 4: Wait for modal (3 seconds)
  await sleep(3000);
  
  // Step 5: Click "Add a note" and type message
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: clickAddNoteAndType,
    args: [lead.message]
  });
  await sleep(2500);
  
  // Step 6: Click Send button
  await executeScript(clickSendButton);
  await sleep(3000);
  
  // Close tab
  await chrome.tabs.remove(tab.id);
}
```

**Queue Processing:**
```javascript
async function sendNextInQueue() {
  // Check if auto-send enabled
  if (!settings.autoSendEnabled) return;
  
  // Check daily limit (with warm-up)
  let safeLimit = Math.min(settings.dailyLimit, 15);
  if (warmUpDay <= 7) {
    safeLimit = Math.min(safeLimit, 5 + warmUpDay);
  }
  
  if (sentToday >= safeLimit) return;
  
  // Get next pending lead from sheet
  const lead = await getNextPendingLead(campaign);
  if (!lead) return;
  
  // Send connection request
  const result = await sendConnectionRequest(lead);
  
  if (result.success) {
    await updateLeadStatus(lead.rowIndex, 'sent', campaign);
    sentToday++;
    
    // Schedule next with random delay (3-7 minutes)
    const delay = 3 + Math.random() * 4;
    chrome.alarms.create('sendNext', { delayInMinutes: delay });
  } else {
    await updateLeadStatus(lead.rowIndex, 'failed', campaign);
    chrome.alarms.create('sendNext', { delayInMinutes: 5 });
  }
}
```

---

### 5. Injected Scripts (run in LinkedIn page context)

**Find Connect Button:**
```javascript
function findAndClickConnect() {
  // Only search in main profile area, not sidebar recommendations
  const mainSection = document.querySelector('main');
  const profileActions = document.querySelector('.pvs-profile-actions');
  const searchArea = profileActions || mainSection || document;
  
  // Method 1: aria-label
  let btn = searchArea.querySelector('button[aria-label*="connect" i]');
  
  // Method 2: Button text
  if (!btn) {
    const buttons = searchArea.querySelectorAll('button');
    for (const b of buttons) {
      if (b.textContent.trim() === 'Connect' && !b.closest('aside')) {
        btn = b;
        break;
      }
    }
  }
  
  if (btn) {
    btn.click();
    return { found: true };
  }
  return { found: false };
}
```

**Click Add Note & Type:**
```javascript
function clickAddNoteAndType(message) {
  const addNoteBtn = document.querySelector('button[aria-label="Add a note"]') ||
    [...document.querySelectorAll('button')].find(b => b.textContent.includes('Add a note'));
  
  if (addNoteBtn) {
    addNoteBtn.click();
    
    setTimeout(() => {
      const textarea = document.querySelector('textarea');
      if (textarea) {
        textarea.focus();
        textarea.value = message;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, 500);
  }
}
```

---

## Chrome Extension Permissions (manifest.json)

```json
{
  "manifest_version": 3,
  "name": "LinkedIn Lead Harvester",
  "permissions": [
    "storage",           // Save settings locally
    "identity",          // Google OAuth
    "alarms",            // Schedule auto-send
    "tabs",              // Open/close tabs
    "scripting"          // Inject scripts into LinkedIn
  ],
  "host_permissions": [
    "https://www.linkedin.com/*",
    "https://sheets.googleapis.com/*",
    "https://api.openai.com/*"
  ],
  "oauth2": {
    "client_id": "YOUR_CLIENT_ID.apps.googleusercontent.com",
    "scopes": ["https://www.googleapis.com/auth/spreadsheets"]
  }
}
```

---

## Data Flow Summary

```
1. USER visits LinkedIn post
   │
2. CONTENT.JS injects "Extract Leads" button
   │
3. USER clicks → scrapes engagers → shows in UI
   │
4. USER clicks "Generate & Save"
   │
   ├──► BACKGROUND.JS calls OpenAI for each lead
   │    └──► Returns personalized message
   │
   └──► BACKGROUND.JS saves to Google Sheets
        (Name, URL, Headline, Status=pending, Message, Date)
   │
5. USER enables Auto-Send
   │
6. BACKGROUND.JS starts alarm-based queue
   │
   ├──► Every 3-7 min: Get next pending lead from Sheet
   │    └──► Open profile → Click Connect → Add Note → Send
   │         └──► Update Sheet status to "sent"
   │
   └──► Stops when daily limit reached or no pending leads
```

---

## Key Improvements Needed for Production

1. **Database Backend** - Replace Google Sheets with PostgreSQL/MongoDB
2. **User Authentication** - Multi-user support with accounts
3. **Rate Limiting** - Server-side enforcement of daily limits
4. **Analytics Dashboard** - Track acceptance rates, response rates
5. **A/B Testing** - Test different message templates
6. **Webhook Notifications** - Alert when connection accepted
7. **Retry Logic** - Handle failed sends with exponential backoff
8. **Lead Deduplication** - Prevent sending to same person twice
9. **Campaign Management** - Multiple campaigns with different templates
10. **Compliance** - GDPR, data retention policies

---

## Message Template Format

Current AI prompt structure:
```
YOUR PROFILE (sender):
- Name: Muhammad Atif
- Role: Lead AI Product Architect
- Expertise: AI, Automation, LLMs

FORMAT:
Hey {FirstName},

[2-3 casual sentences referencing their work]
[Soft question or expression of interest]

TONE: Casual, warm, curious (like texting a colleague)
MAX: 280 characters
```

---

## Summary

This extension demonstrates a complete LinkedIn automation workflow:
- Web scraping via content scripts
- AI integration for personalization
- Simple database (Google Sheets)
- Scheduled automation with safety measures
- Multi-step browser automation

The same architecture can be rebuilt with a proper backend, replacing:
- Google Sheets → Database (PostgreSQL)
- Chrome storage → Server-side user sessions
- Chrome alarms → Server-side job queues (Bull, Celery)
- Content script → Puppeteer/Playwright headless browser
