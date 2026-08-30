# LinkedIn Outreach Engine

Chrome extension package: **LinkedIn Lead Harvester**.

Automated lead extraction from LinkedIn posts. Save engagers to Google Sheets and generate personalized outreach messages.

## 🚀 Quick Setup

### Step 1: Create Google Cloud OAuth

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select existing
3. Enable **Google Sheets API**
4. Go to **APIs & Services → Credentials**
5. Create **OAuth 2.0 Client ID** (Chrome Extension type)
6. Copy the **Client ID**

### Step 2: Create Google Sheet

1. Create a new Google Sheet
2. Copy the **Sheet ID** from the URL:
   ```
   https://docs.google.com/spreadsheets/d/[THIS-IS-YOUR-SHEET-ID]/edit
   ```

### Step 3: Configure Extension

1. Open `manifest.json`
2. Replace `823333525467-ge6k2jvenrhmmjrhl9q6jnk8uptj4s56.apps.googleusercontent.com` with your Client ID
3. Load extension in Chrome: `chrome://extensions/` → Load unpacked
4. Click extension icon → Enter Sheet ID and OpenAI API Key

## 📖 Usage

1. Go to any LinkedIn post with likes/comments
2. Click **🎯 Extract Leads** button
3. Enter campaign name
4. Click **💾 Save to Google Sheets** or **🤖 Generate & Save**
5. Open the extension popup → choose a campaign → start Auto-Send

## 📁 Project Structure

```
Linkedin-Outreach-Engine/
├── manifest.json       # Extension config
├── background.js       # API calls
├── content.js          # DOM scraping
├── content.css         # Styling
├── popup/              # Settings UI
└── icons/              # Extension icons
```

## ⚠️ Important Notes

- Rate limit yourself: Don't extract from too many posts at once
- LinkedIn may update their DOM - selectors might need adjustment
- Google Sheets OAuth requires user consent on first use
