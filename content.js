// LinkedIn Lead Harvester - Content Script
// DOM hooks updated for LinkedIn 2026 (hashed CSS classes — use aria/text/role)

(function() {
  'use strict';
  
  if (window.linkedInLeadHarvesterLoaded) return;
  window.linkedInLeadHarvesterLoaded = true;
  
  let extractedLeads = [];
  let isExtracting = false;
  
  function sanitizeText(text) {
    if (!text) return '';
    return text
      .replace(/[\u{1F600}-\u{1F6FF}]/gu, '')
      .replace(/[\u{2600}-\u{26FF}]/gu, '')
      .replace(/[\u{2700}-\u{27BF}]/gu, '')
      .replace(/[\u{1F300}-\u{1F5FF}]/gu, '')
      .replace(/[\u{1F900}-\u{1F9FF}]/gu, '')
      .replace(/[\u{1FA00}-\u{1FA6F}]/gu, '')
      .replace(/[\u{1FA70}-\u{1FAFF}]/gu, '')
      .replace(/[^\x00-\xFF]/g, '')
      .trim();
  }
  
  function sanitizeLead(lead) {
    return {
      ...lead,
      name: sanitizeText(lead.name),
      headline: sanitizeText(lead.headline || ''),
      source: lead.source,
      profileUrl: lead.profileUrl
    };
  }
  
  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
  
  function normalizeProfileUrl(href) {
    if (!href) return '';
    try {
      const u = new URL(href, location.origin);
      const match = u.pathname.match(/\/in\/[^\/]+/);
      if (!match) return '';
      return `https://www.linkedin.com${match[0]}/`.replace(/\/+$/, '/');
    } catch {
      return href.split('?')[0].split('#')[0];
    }
  }
  
  function parseNameAndHeadline(text) {
    const lines = (text || '')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean);
    
    let name = (lines[0] || '')
      .replace(/\s*[•·]\s*\d+(st|nd|rd)\+?/i, '')
      .replace(/\s*Verified Profile.*/i, '')
      .replace(/\s*Premium Profile.*/i, '')
      .replace(/\s*\bYou\b\s*$/i, '')
      .trim();
    
    // Prefer a cleaner duplicate name line if present (e.g. "Name 1st" then "Name • 1st")
    const alt = lines.find(l => /•\s*\d+(st|nd|rd)/i.test(l));
    if (alt) {
      const cleaned = alt
        .replace(/\s*[•·]\s*\d+(st|nd|rd)\+?/i, '')
        .replace(/\s*Verified Profile.*/i, '')
        .trim();
      if (cleaned && cleaned.length <= name.length) name = cleaned;
    }
    
    const headline = lines.find((l, i) => {
      if (i === 0) return false;
      if (/^(connect|message|follow|pending|reply|\d+\s*reactions?)$/i.test(l)) return false;
      if (/followers?/i.test(l) && l.length < 40) return false;
      if (/•\s*\d+(st|nd|rd)/i.test(l)) return false;
      if (l === name) return false;
      return l.length > 2;
    }) || '';
    
    return { name, headline };
  }
  
  // Current LinkedIn: posts are role=listitem (or ancestors) with "N reactions" link
  function findFeedPosts() {
    const posts = new Set();
    
    document.querySelectorAll('[role="listitem"]').forEach(el => {
      if (findReactionsControl(el)) posts.add(el);
    });
    
    // Fallback: any block that contains both a Feed post heading and reactions
    document.querySelectorAll('h2').forEach(h => {
      if (!/feed post/i.test(h.textContent || '')) return;
      let scope = h.parentElement;
      for (let i = 0; i < 12 && scope; i++) {
        if (findReactionsControl(scope) && scope.querySelectorAll('button').length > 2) {
          posts.add(scope);
          break;
        }
        scope = scope.parentElement;
      }
    });
    
    // Legacy fallbacks if LinkedIn reverts
    document.querySelectorAll('.feed-shared-update-v2, .occludable-update').forEach(el => {
      posts.add(el);
    });
    
    return Array.from(posts);
  }
  
  function findReactionsControl(scope) {
    if (!scope) return null;
    
    const byText = Array.from(scope.querySelectorAll('a, button')).find(el => {
      const t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      return /^\d[\d,]*\s+reactions?$/i.test(t) || /^\d[\d,]*\s+reactions?/i.test(aria);
    });
    if (byText) return byText;
    
    return scope.querySelector('.social-details-social-counts__reactions-count') ||
           scope.querySelector('[data-test-id="social-actions__reactions"]');
  }
  
  function findReactionsDialog() {
    const dialogs = Array.from(document.querySelectorAll('dialog'));
    const openDialog = dialogs.find(d => {
      const h = d.querySelector('h2');
      return h && /reactions/i.test(h.textContent || '') && (d.open || d.hasAttribute('open') || d.getAttribute('aria-hidden') !== 'true');
    });
    if (openDialog) return openDialog;
    
    const h2 = Array.from(document.querySelectorAll('h2')).find(h => /^reactions$/i.test((h.textContent || '').trim()));
    if (h2) return h2.closest('dialog') || h2.parentElement;
    
    return document.querySelector('.social-details-reactors-modal, [data-test-modal-id="reactions-modal"]');
  }
  
  function dismissReactionsDialog(modal) {
    const root = modal || document;
    const dismiss = Array.from(root.querySelectorAll('button')).find(b => {
      const aria = (b.getAttribute('aria-label') || '').toLowerCase();
      return aria === 'dismiss' || aria.includes('dismiss') || aria.includes('close');
    });
    if (dismiss) {
      dismiss.click();
      return true;
    }
    const legacy = document.querySelector('.artdeco-modal__dismiss');
    if (legacy) {
      legacy.click();
      return true;
    }
    return false;
  }
  
  function findReactionsScrollContainer(modal) {
    if (!modal) return null;

    // Live LinkedIn: likers list scrolls inside a div with overflow-y:auto that contains /in/ links
    const candidates = Array.from(modal.querySelectorAll('div')).filter(el => {
      const style = window.getComputedStyle(el);
      const oy = style.overflowY;
      if (oy !== 'auto' && oy !== 'scroll') return false;
      if (el.scrollHeight <= el.clientHeight + 20) return false;
      return el.querySelector('a[href*="/in/"]');
    });

    if (candidates.length) {
      return candidates.sort((a, b) => {
        const diff = b.querySelectorAll('a[href*="/in/"]').length - a.querySelectorAll('a[href*="/in/"]').length;
        if (diff !== 0) return diff;
        return b.scrollHeight - a.scrollHeight;
      })[0];
    }

    return modal.querySelector('.artdeco-modal__content') ||
           modal.querySelector('[class*="modal__content"]') ||
           null;
  }

  async function waitForReactionsList(modal, timeoutMs = 25000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const scrollContainer = findReactionsScrollContainer(modal);
      const linkCount = scrollContainer
        ? scrollContainer.querySelectorAll('a[href*="/in/"]').length
        : modal.querySelectorAll('a[href*="/in/"]').length;
      if (scrollContainer && linkCount > 0) {
        return { ready: true, scrollContainer, linkCount };
      }
      await sleep(400);
    }
    return { ready: false, scrollContainer: null, linkCount: 0 };
  }

  async function scrollReactionsList(modal, scrollContainer) {
    let lastLinkCount = scrollContainer.querySelectorAll('a[href*="/in/"]').length;
    let staleRounds = 0;

    for (let i = 0; i < 40; i++) {
      const links = scrollContainer.querySelectorAll('a[href*="/in/"]');
      const atBottom =
        scrollContainer.scrollTop + scrollContainer.clientHeight >= scrollContainer.scrollHeight - 8;

      if (links.length === lastLinkCount && atBottom) {
        staleRounds++;
        if (staleRounds >= 4) break;
      } else if (links.length > lastLinkCount) {
        staleRounds = 0;
        lastLinkCount = links.length;
      }

      scrollContainer.scrollTop += Math.max(320, Math.floor(scrollContainer.clientHeight * 0.85));
      scrollContainer.dispatchEvent(new Event('scroll', { bubbles: true }));

      if (links.length) {
        links[links.length - 1].scrollIntoView({ block: 'end', behavior: 'auto' });
      }

      await sleep(650);
    }
  }
  
  function injectExtractButton() {
    const posts = findFeedPosts();
    
    posts.forEach(post => {
      if (post.querySelector('.llh-extract-btn')) return;
      
      const reactionsEl = findReactionsControl(post);
      if (!reactionsEl) return;
      
      const host = reactionsEl.parentElement || post;
      if (host.querySelector('.llh-extract-btn')) return;
      
      const btn = document.createElement('button');
      btn.className = 'llh-extract-btn';
      btn.type = 'button';
      btn.innerHTML = '🎯 Extract Leads';
      btn.title = 'Extract likers and commenters from this post';
      
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        extractLeadsFromPost(post, btn);
      });
      
      if (reactionsEl.nextSibling) {
        host.insertBefore(btn, reactionsEl.nextSibling);
      } else {
        host.appendChild(btn);
      }
    });
  }
  
  async function expandComments(post) {
    const commentBtn = Array.from(post.querySelectorAll('button, a')).find(el => {
      const aria = (el.getAttribute('aria-label') || '').trim();
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      return aria === 'Comment' || /^comment$/i.test(text) || /^\d+\s+comments?$/i.test(text);
    });
    if (commentBtn) {
      commentBtn.click();
      await sleep(1200);
    }
    
    for (let i = 0; i < 4; i++) {
      const seeMore = Array.from(post.querySelectorAll('button')).find(b =>
        /see\s+\d+\s+more\s+comments?/i.test(b.textContent || '') ||
        /see\s+\d+\s+more\s+comments?/i.test(b.getAttribute('aria-label') || '')
      );
      if (!seeMore) break;
      seeMore.click();
      await sleep(900);
    }
  }
  
  function isReplyControl(el) {
    const aria = (el.getAttribute('aria-label') || '').trim();
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return /^reply$/i.test(aria) || /^reply$/i.test(text);
  }
  
  function extractCommenters(post) {
    const commenters = [];
    const seen = new Set();
    
    // Legacy
    post.querySelectorAll('.comments-comment-item').forEach(item => {
      const profileLink = item.querySelector('a[href*="/in/"]');
      if (!profileLink) return;
      const profileUrl = normalizeProfileUrl(profileLink.href);
      if (!profileUrl || seen.has(profileUrl)) return;
      
      const nameEl = item.querySelector('.comments-post-meta__name-text') ||
                     item.querySelector('.hoverable-link-text');
      const headlineEl = item.querySelector('.comments-post-meta__headline');
      const parsed = parseNameAndHeadline(
        nameEl ? `${nameEl.textContent}\n${headlineEl?.textContent || ''}` : profileLink.innerText
      );
      
      if (parsed.name) {
        seen.add(profileUrl);
        commenters.push({
          name: parsed.name,
          profileUrl,
          headline: parsed.headline || headlineEl?.textContent?.trim() || '',
          source: 'commenter'
        });
      }
    });
    
    // Current DOM: Reply is often aria-label="Reply" with empty text
    Array.from(post.querySelectorAll('button')).filter(isReplyControl).forEach(reply => {
      let scope = reply;
      for (let i = 0; i < 12 && scope && scope !== post; i++) {
        const optionsHint = Array.from(scope.querySelectorAll('button')).some(b =>
          /’s comment|\'s comment/i.test(b.getAttribute('aria-label') || '')
        );
        const link = scope.querySelector('a[href*="/in/"]');
        if (link && ((scope.innerText || '').length < 2500) && (optionsHint || i >= 3)) {
          const profileUrl = normalizeProfileUrl(link.href);
          if (profileUrl && !seen.has(profileUrl)) {
            const parsed = parseNameAndHeadline(link.innerText || scope.innerText);
            const name = (parsed.name || '')
              .split('\n')[0]
              .replace(/\s*[•·].*$/, '')
              .replace(/\s*Verified Profile.*/i, '')
              .trim();
            if (name) {
              seen.add(profileUrl);
              commenters.push({
                name,
                profileUrl,
                headline: parsed.headline,
                source: 'commenter'
              });
            }
          }
          break;
        }
        scope = scope.parentElement;
      }
    });
    
    // Fallback: buttons titled "View more options for X's comment"
    Array.from(post.querySelectorAll('button')).forEach(btn => {
      const aria = btn.getAttribute('aria-label') || '';
      const m = aria.match(/View more options for (.+?)(?:’s|'s) comment/i);
      if (!m) return;
      let scope = btn;
      for (let i = 0; i < 10 && scope; i++) {
        const link = scope.querySelector('a[href*="/in/"]');
        if (link) {
          const profileUrl = normalizeProfileUrl(link.href);
          if (profileUrl && !seen.has(profileUrl)) {
            const parsed = parseNameAndHeadline(link.innerText || '');
            seen.add(profileUrl);
            commenters.push({
              name: (parsed.name || m[1]).replace(/\s*Verified Profile.*/i, '').trim(),
              profileUrl,
              headline: parsed.headline,
              source: 'commenter'
            });
          }
          break;
        }
        scope = scope.parentElement;
      }
    });
    
    return commenters;
  }
  
  async function extractLikers() {
    const likers = [];
    const seen = new Set();
    
    let modal = findReactionsDialog();
    for (let i = 0; i < 15 && !modal; i++) {
      await sleep(400);
      modal = findReactionsDialog();
    }
    if (!modal) return likers;

    // Likers can take 10+ seconds to render after dialog opens — wait for real rows
    const loaded = await waitForReactionsList(modal);
    if (!loaded.ready || !loaded.scrollContainer) {
      console.warn('LLH: Reactions list did not finish loading');
      return likers;
    }

    await scrollReactionsList(modal, loaded.scrollContainer);
    
    loaded.scrollContainer.querySelectorAll('a[href*="/in/"]').forEach(profileLink => {
      const profileUrl = normalizeProfileUrl(profileLink.href);
      if (!profileUrl || seen.has(profileUrl)) return;
      
      const parsed = parseNameAndHeadline(profileLink.innerText || profileLink.textContent || '');
      let name = parsed.name;
      let headline = parsed.headline;
      
      if (!name) {
        const item = profileLink.closest('li') || profileLink.closest('.artdeco-entity-lockup, .social-details-reactors-tab-body-list-item') || profileLink.parentElement;
        const nameEl = item?.querySelector('.artdeco-entity-lockup__title') || item?.querySelector('[class*="name"]');
        const headlineEl = item?.querySelector('.artdeco-entity-lockup__subtitle') || item?.querySelector('.artdeco-entity-lockup__caption');
        name = nameEl?.textContent?.trim().split('\n')[0] || '';
        headline = headlineEl?.textContent?.trim() || '';
      }
      
      name = name.replace(/View.*profile/i, '').trim();
      if (!name || name.length < 2) {
        const urlMatch = profileUrl.match(/\/in\/([^\/]+)/);
        name = urlMatch ? urlMatch[1].replace(/-/g, ' ') : 'Unknown';
      }
      
      seen.add(profileUrl);
      likers.push({
        name,
        profileUrl,
        headline,
        source: 'liker'
      });
    });
    
    return likers;
  }
  
  async function extractLeadsFromPost(post, button) {
    if (isExtracting) return;
    isExtracting = true;
    
    const originalText = button.innerHTML;
    button.innerHTML = '⏳ Extracting...';
    button.disabled = true;
    
    extractedLeads = [];
    
    try {
      await expandComments(post);
      const commenters = extractCommenters(post);
      extractedLeads.push(...commenters);
      
      const reactionsBtn = findReactionsControl(post);
      if (reactionsBtn) {
        reactionsBtn.click();
        const likers = await extractLikers();
        extractedLeads.push(...likers);
        
        dismissReactionsDialog();
        await sleep(400);
      }
      
      const uniqueLeads = removeDuplicates(extractedLeads);
      showResultsPanel(uniqueLeads);
      button.innerHTML = `✅ ${uniqueLeads.length} leads found`;
      
    } catch (error) {
      console.error('LLH: Error extracting leads:', error);
      button.innerHTML = '❌ Error';
    } finally {
      isExtracting = false;
      button.disabled = false;
      setTimeout(() => {
        button.innerHTML = originalText;
      }, 3000);
    }
  }
  
  function removeDuplicates(leads) {
    const seen = new Set();
    return leads.filter(lead => {
      const key = lead.profileUrl;
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }
  
  function showResultsPanel(leads) {
    const existingPanel = document.querySelector('.llh-results-panel');
    if (existingPanel) existingPanel.remove();
    
    const panel = document.createElement('div');
    panel.className = 'llh-results-panel';
    panel.innerHTML = `
      <div class="llh-panel-header">
        <h3>🎯 ${leads.length} Leads Extracted</h3>
        <button class="llh-close-btn">×</button>
      </div>
      <div class="llh-panel-body">
        <div class="llh-lead-list">
          ${leads.slice(0, 10).map(lead => `
            <div class="llh-lead-item">
              <strong>${lead.name}</strong>
              <span class="llh-lead-headline">${lead.headline || 'No headline'}</span>
              <span class="llh-lead-source">${lead.source}</span>
            </div>
          `).join('')}
          ${leads.length > 10 ? `<div class="llh-more">...and ${leads.length - 10} more</div>` : ''}
        </div>
        <div class="llh-actions">
          <input type="text" class="llh-campaign-name" placeholder="Campaign name (e.g., ai-creators)" />
          <button class="llh-save-btn">💾 Save to Google Sheets</button>
          <button class="llh-csv-btn">📥 Download CSV</button>
          <button class="llh-generate-btn">🤖 Generate & Save</button>
        </div>
      </div>
    `;
    
    document.body.appendChild(panel);
    
    panel.querySelector('.llh-close-btn').addEventListener('click', () => panel.remove());
    
    panel.querySelector('.llh-save-btn').addEventListener('click', async () => {
      const campaignName = panel.querySelector('.llh-campaign-name').value || `campaign-${Date.now()}`;
      const saveBtn = panel.querySelector('.llh-save-btn');
      saveBtn.disabled = true;
      saveBtn.textContent = '⏳ Saving...';
      
      try {
        if (!chrome.runtime?.id) {
          throw new Error('Extension was reloaded. Please refresh this page (F5).');
        }
        
        const sanitizedLeads = leads.map(sanitizeLead);
        const sanitizedCampaignName = sanitizeText(campaignName);
        
        const response = await chrome.runtime.sendMessage({
          action: 'saveLeads',
          leads: sanitizedLeads,
          campaignName: sanitizedCampaignName
        });
        
        if (response.error) throw new Error(response.error);
        saveBtn.textContent = `✅ Saved ${response.count} leads!`;
      } catch (error) {
        const errMsg = error.message || 'Unknown error';
        if (errMsg.includes('Extension context invalidated') || errMsg.includes('sendMessage')) {
          saveBtn.textContent = '❌ Refresh page (F5)';
        } else {
          saveBtn.textContent = '❌ ' + errMsg;
        }
      }
    });
    
    panel.querySelector('.llh-csv-btn').addEventListener('click', () => {
      const campaignName = sanitizeText(panel.querySelector('.llh-campaign-name').value) || 'leads';
      const csvBtn = panel.querySelector('.llh-csv-btn');
      
      const headers = ['Name', 'Profile URL', 'Headline', 'Source'];
      const rows = leads.map(lead => [
        sanitizeText(lead.name),
        lead.profileUrl,
        sanitizeText(lead.headline || ''),
        lead.source
      ]);
      
      const csvContent = [headers, ...rows]
        .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(','))
        .join('\n');
      
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${campaignName}-${Date.now()}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      
      csvBtn.textContent = '✅ Downloaded!';
      setTimeout(() => { csvBtn.textContent = '📥 Download CSV'; }, 2000);
    });
    
    panel.querySelector('.llh-generate-btn').addEventListener('click', async () => {
      const campaignName = panel.querySelector('.llh-campaign-name').value || `campaign-${Date.now()}`;
      const genBtn = panel.querySelector('.llh-generate-btn');
      genBtn.disabled = true;
      genBtn.textContent = '⏳ Generating & Saving...';
      
      try {
        if (!chrome.runtime?.id) {
          throw new Error('Extension was reloaded. Please refresh this page (F5).');
        }
        
        const sanitizedLeads = leads.map(sanitizeLead);
        const sanitizedCampaignName = sanitizeText(campaignName);
        
        const response = await chrome.runtime.sendMessage({
          action: 'generateAndSaveMessages',
          leads: sanitizedLeads,
          campaignName: sanitizedCampaignName
        });
        
        if (response.error) throw new Error(response.error);
        genBtn.textContent = `✅ ${response.count} leads with messages saved!`;
      } catch (error) {
        const errMsg = error.message || 'Unknown error';
        if (errMsg.includes('Extension context invalidated') || errMsg.includes('sendMessage')) {
          genBtn.textContent = '❌ Extension reloaded - refresh page (F5)';
        } else {
          genBtn.textContent = '❌ ' + errMsg;
        }
      }
    });
  }
  
  // ============================================
  // MESSAGING REPLY COPILOT
  // Live DOM hooks (audited): .msg-entity-lockup__entity-title, li.msg-s-message-list__event,
  // .msg-s-event-listitem__body, .msg-form__contenteditable / aria Write a message…
  // ============================================

  const LLH_SENDER_NAME = 'Muhammad Atif';
  const LLH_GOAL_KEY = 'llhReplyGoal';
  const LLH_GOALS = ['rapport', 'work', 'ask', 'close'];
  const LLH_GOAL_DEFAULT = 'work';
  const LLH_GOAL_CHIPS = [
    { id: 'rapport', label: 'Rapport' },
    { id: 'work', label: 'Work' },
    { id: 'ask', label: 'Ask' },
    { id: 'close', label: 'Close' }
  ];
  let llhReplyStack = [];
  let llhReplyStackIndex = 0;
  let llhTrackedIdentity = null;
  let llhCurrentGoal = LLH_GOAL_DEFAULT;
  let llhSuggestInFlight = false;

  function isMessagingPage() {
    return /\/messaging\//i.test(location.pathname);
  }

  function getOpenConversationRoot() {
    // Prefer the thread that owns the visible compose box (avoids bubble/other-thread bleed)
    const compose =
      document.querySelector('.msg-form__contenteditable') ||
      document.querySelector('div[role="textbox"][aria-label*="Write a message"]');
    const fromCompose =
      compose?.closest('.msg-convo-wrapper, .msg-thread, .msg-overlay-conversation-bubble') ||
      compose?.closest('section, aside, main');
    if (fromCompose && fromCompose.querySelector('li.msg-s-message-list__event, .msg-s-message-list')) {
      return fromCompose;
    }

    const wrappers = [...document.querySelectorAll('.msg-convo-wrapper, .msg-thread, .msg-overlay-conversation-bubble')];
    const withList = wrappers.find(w => w.querySelector('li.msg-s-message-list__event'));
    return withList || document.querySelector('main') || document.body;
  }

  function scrapePeerContext(root) {
    const scope = root || getOpenConversationRoot();
    const titleEl =
      scope.querySelector('h2.msg-entity-lockup__entity-title') ||
      scope.querySelector('.msg-entity-lockup__entity-title') ||
      scope.querySelector('a.msg-thread__link-to-profile') ||
      scope.querySelector('.msg-overlay-bubble-header__title');
    let name = (titleEl?.textContent || '').replace(/\s+/g, ' ').trim();
    name = name
      .replace(/\s*Status is online.*/i, '')
      .replace(/\s*Active now.*/i, '')
      .replace(/\s*Open the options list.*/i, '')
      .trim();

    let headline = '';
    const infoEl = scope.querySelector('.msg-entity-lockup__entity-info');
    if (infoEl) {
      const info = (infoEl.textContent || '').replace(/\s+/g, ' ').trim();
      if (info && !/status is online|active now|away/i.test(info)) {
        headline = info;
      }
    }
    if (!headline) {
      const occ = scope.querySelector(
        '.msg-entity-lockup__entity-info--occupation, .artdeco-entity-lockup__subtitle, .msg-s-profile-card__occupation'
      );
      if (occ) headline = (occ.textContent || '').replace(/\s+/g, ' ').trim();
    }

    return { peerName: name || 'there', peerHeadline: headline };
  }

  function scrapeConversationMessages(limit = 10) {
    const root = getOpenConversationRoot();
    const list =
      root.querySelector('.msg-s-message-list, ul.msg-s-message-list-content') || root;
    const events = [...list.querySelectorAll('li.msg-s-message-list__event')];
    const messages = [];

    for (const li of events) {
      // Never take events from a different conversation root
      if (!root.contains(li)) continue;

      const bodyEl = li.querySelector('.msg-s-event-listitem__body');
      if (!bodyEl) continue;
      const text = (bodyEl.innerText || bodyEl.textContent || '').trim();
      if (!text) continue;

      const nameEl = li.querySelector(
        '.msg-s-message-group__name, .msg-s-message-group__meta a, a.inline-block'
      );
      const sender = (nameEl?.textContent || '').replace(/\s+/g, ' ').trim();
      const role =
        sender && new RegExp(LLH_SENDER_NAME.replace(/\s+/g, '\\s+'), 'i').test(sender)
          ? 'me'
          : 'them';

      messages.push({ role, text: text.slice(0, 1200), sender });
    }

    return messages.slice(-limit);
  }

  function getThreadIdFromDom(root) {
    const href =
      (root && root.querySelector?.('a[href*="/messaging/thread/"]')?.getAttribute('href')) ||
      location.pathname ||
      '';
    const m = String(href).match(/\/messaging\/thread\/([^\/\?]+)/i);
    return m ? decodeURIComponent(m[1]) : '';
  }

  function getConversationIdentity() {
    const root = getOpenConversationRoot();
    const { peerName } = scrapePeerContext(root);
    return {
      threadId: getThreadIdFromDom(root),
      peerName: (peerName || '').replace(/\s+/g, ' ').trim()
    };
  }

  function identitiesDiffer(a, b) {
    if (!a || !b) return false;
    if (a.threadId && b.threadId && a.threadId !== b.threadId) return true;
    const an = (a.peerName || '').toLowerCase();
    const bn = (b.peerName || '').toLowerCase();
    if (!an || !bn || an === 'there' || bn === 'there') return false;
    return an !== bn;
  }

  function resetReplyStack() {
    llhReplyStack = [];
    llhReplyStackIndex = 0;
  }

  function closeReplyPanelAndReset() {
    document.querySelector('.llh-reply-panel')?.remove();
    resetReplyStack();
  }

  function closeReplyPanelOnThreadSwitch() {
    const next = getConversationIdentity();
    if (!llhTrackedIdentity) {
      llhTrackedIdentity = next;
      return;
    }
    if (identitiesDiffer(llhTrackedIdentity, next)) {
      llhTrackedIdentity = next;
      closeReplyPanelAndReset();
    } else {
      llhTrackedIdentity = next;
    }
  }

  function getStoredGoal() {
    return new Promise(resolve => {
      try {
        chrome.storage.local.get({ [LLH_GOAL_KEY]: LLH_GOAL_DEFAULT }, data => {
          const g = data?.[LLH_GOAL_KEY];
          resolve(LLH_GOALS.includes(g) ? g : LLH_GOAL_DEFAULT);
        });
      } catch (e) {
        resolve(LLH_GOAL_DEFAULT);
      }
    });
  }

  function setStoredGoal(goal) {
    const value = LLH_GOALS.includes(goal) ? goal : LLH_GOAL_DEFAULT;
    llhCurrentGoal = value;
    try {
      chrome.storage.local.set({ [LLH_GOAL_KEY]: value });
    } catch (e) { /* ignore */ }
    return value;
  }

  function snippetText(text, max = 80) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    if (s.length <= max) return s;
    return s.slice(0, max) + '…';
  }

  function buildContextStripHtml(peerName, messages) {
    const last2 = (messages || []).slice(-2);
    const rows = last2.map(m => {
      const role = m.role === 'me' ? 'You' : (m.sender || peerName || 'Them');
      return `<div class="llh-context-msg"><span class="llh-context-role">${escapeHtml(role)}</span> ${escapeHtml(snippetText(m.text))}</div>`;
    }).join('');
    return `
      <div class="llh-context-strip">
        <div class="llh-context-label">Context</div>
        <div class="llh-context-peer">${escapeHtml(peerName || 'Unknown')}</div>
        ${rows || '<div class="llh-context-msg">No messages scraped</div>'}
      </div>`;
  }

  function buildGoalChipsHtml(selected, disabled) {
    return `
      <div class="llh-goal-row">
        <span class="llh-goal-label">Goal</span>
        <div class="llh-goal-chips">
          ${LLH_GOAL_CHIPS.map(g => `
            <button type="button" class="llh-goal-chip${g.id === selected ? ' active' : ''}" data-goal="${g.id}"${disabled ? ' disabled' : ''}>${g.label}</button>
          `).join('')}
        </div>
      </div>`;
  }

  function findComposeBox() {
    const root = getOpenConversationRoot();
    return (
      root.querySelector('.msg-form__contenteditable') ||
      root.querySelector('div[role="textbox"][aria-label*="Write a message"]') ||
      document.querySelector('.msg-form__contenteditable') ||
      document.querySelector('div[role="textbox"][aria-label*="Write a message"]')
    );
  }

  function insertIntoCompose(text) {
    const box = findComposeBox();
    if (!box) return false;
    box.focus();
    try {
      const ok = document.execCommand('selectAll', false, null);
      if (ok) document.execCommand('insertText', false, text);
      else {
        box.textContent = text;
        box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      }
    } catch (e) {
      box.textContent = text;
      box.dispatchEvent(new InputEvent('input', { bubbles: true }));
    }
    return true;
  }

  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (e) {
      return false;
    }
  }

  function injectSuggestReplyButton() {
    if (!isMessagingPage() && !document.querySelector('.msg-overlay-conversation-bubble, .msg-form')) return;
    if (!document.querySelector('.msg-form, .msg-form__contenteditable')) return;

    // One button per open compose footer (main thread and/or bubble)
    document.querySelectorAll('form.msg-form, .msg-form').forEach(form => {
      if (form.querySelector('.llh-suggest-reply-btn')) return;
      const footer = form.querySelector('.msg-form__footer') || form;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'llh-suggest-reply-btn';
      btn.textContent = '✨ Suggest reply';
      btn.title = 'Draft 2 human reply stacks from THIS chat only (you still send)';
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        document.querySelector('.llh-reply-panel')?.remove();
        resetReplyStack();
        runSuggestReply(btn);
      });
      footer.insertBefore(btn, footer.firstChild);
    });
  }

  async function runSuggestReply(btn, goalOverride) {
    if (llhSuggestInFlight) return;
    llhSuggestInFlight = true;

    const original = btn ? btn.textContent : '';
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ Drafting...';
    }

    const meta = { peerName: '', peerHeadline: '', messages: [], goal: LLH_GOAL_DEFAULT };
    let identityAtStart = null;

    try {
      if (!chrome.runtime?.id) {
        throw new Error('Extension was reloaded. Refresh this page (F5).');
      }

      const root = getOpenConversationRoot();
      const { peerName, peerHeadline } = scrapePeerContext(root);
      const messages = scrapeConversationMessages(10);
      const goal = LLH_GOALS.includes(goalOverride) ? setStoredGoal(goalOverride) : await getStoredGoal();
      llhCurrentGoal = goal;
      llhTrackedIdentity = getConversationIdentity();
      identityAtStart = llhTrackedIdentity;

      meta.peerName = peerName;
      meta.peerHeadline = peerHeadline;
      meta.messages = messages;
      meta.goal = goal;

      if (!messages.length) {
        throw new Error('No messages found in this conversation yet.');
      }

      // Guard: them-senders should match open peer (catches cross-thread bleed)
      const themSenders = [...new Set(messages.filter(m => m.role === 'them').map(m => m.sender).filter(Boolean))];
      const peerKey = peerName.toLowerCase().split(/\s+/)[0];
      if (peerKey && themSenders.length) {
        const mismatch = themSenders.every(s => !s.toLowerCase().includes(peerKey) && !peerName.toLowerCase().includes(s.toLowerCase().split(/\s+/)[0]));
        if (mismatch) {
          throw new Error('Thread mismatch — reopen this chat and try Suggest reply again.');
        }
      }

      showReplyDraftPanel({ loading: true }, meta);

      const response = await chrome.runtime.sendMessage({
        action: 'suggestReplyDrafts',
        payload: {
          peerName,
          peerHeadline,
          messages,
          senderName: LLH_SENDER_NAME,
          goal
        }
      });

      if (identitiesDiffer(identityAtStart, getConversationIdentity())) {
        return;
      }

      if (response?.error) throw new Error(response.error);
      if (!response?.options?.length) throw new Error('No drafts returned');

      showReplyDraftPanel(response, meta);
    } catch (error) {
      if (identityAtStart && identitiesDiffer(identityAtStart, getConversationIdentity())) {
        return;
      }
      showReplyDraftPanel({ error: error.message || 'Failed' }, meta);
    } finally {
      llhSuggestInFlight = false;
      if (btn) {
        btn.disabled = false;
        btn.textContent = original || '✨ Suggest reply';
      }
    }
  }

  function showReplyDraftPanel(result, meta) {
    document.querySelector('.llh-reply-panel')?.remove();

    const panel = document.createElement('div');
    panel.className = 'llh-reply-panel';
    const goal = LLH_GOALS.includes(meta?.goal) ? meta.goal : llhCurrentGoal;
    const stage = result.stage || '';
    const loading = !!result.loading;
    const contextHtml = buildContextStripHtml(meta?.peerName, meta?.messages);
    const chipsHtml = buildGoalChipsHtml(goal, loading);

    let bodyHtml = '';
    if (result.error) {
      bodyHtml = `<p class="llh-reply-error">${escapeHtml(result.error)}</p>`;
    } else if (loading) {
      bodyHtml = `<p class="llh-reply-loading">Drafting…</p>`;
    } else {
      bodyHtml = result.options.map((opt) => {
        const pathHint = opt.id === 'B' ? 'warmer' : 'clearer path';
        const msgs = (opt.messages || []).map((m, i) => `
          <div class="llh-reply-bubble" data-opt="${opt.id}" data-idx="${i}">
            <div class="llh-reply-bubble-label">Msg ${i + 1}</div>
            <div class="llh-reply-bubble-text">${escapeHtml(m)}</div>
            <div class="llh-reply-bubble-actions">
              <button type="button" class="llh-reply-copy" data-opt="${opt.id}" data-idx="${i}">Copy</button>
              <button type="button" class="llh-reply-insert" data-opt="${opt.id}" data-idx="${i}">Insert</button>
            </div>
          </div>`).join('');
        return `
          <div class="llh-reply-option" data-opt="${opt.id}">
            <div class="llh-reply-option-header">
              <strong>Option ${opt.id} <span class="llh-reply-option-sub">· ${pathHint}</span></strong>
              <button type="button" class="llh-reply-use-stack" data-opt="${opt.id}">Use stack</button>
            </div>
            ${msgs}
          </div>`;
      }).join('');
    }

    panel.innerHTML = `
      <div class="llh-reply-panel-header">
        <h3>Suggest reply ${meta?.peerName ? `· ${escapeHtml(meta.peerName)}` : ''}</h3>
        <button type="button" class="llh-close-btn">×</button>
      </div>
      ${contextHtml}
      ${chipsHtml}
      <div class="llh-reply-panel-meta">
        ${stage ? `<span class="llh-reply-stage">Stage: ${escapeHtml(stage)}</span>` : ''}
        <span class="llh-reply-goal">Goal: ${escapeHtml(goal)}</span>
        ${meta?.peerHeadline ? `<span class="llh-reply-headline">${escapeHtml(meta.peerHeadline)}</span>` : ''}
        <span class="llh-reply-hint">You send manually — never auto-send</span>
      </div>
      <div class="llh-reply-panel-body">${bodyHtml}</div>
      <div class="llh-reply-panel-footer">
        <button type="button" class="llh-reply-copy-next" disabled>Copy next</button>
        <span class="llh-reply-stack-status"></span>
      </div>`;

    document.body.appendChild(panel);
    panel.querySelector('.llh-close-btn').onclick = () => {
      panel.remove();
      resetReplyStack();
    };

    panel.querySelectorAll('.llh-goal-chip').forEach(chip => {
      chip.addEventListener('click', async () => {
        const next = chip.dataset.goal;
        if (!LLH_GOALS.includes(next) || next === goal || loading) return;
        setStoredGoal(next);
        const suggestBtn = document.querySelector('.llh-suggest-reply-btn');
        runSuggestReply(suggestBtn, next);
      });
    });

    if (result.error || loading) return;

    const findMsg = (optId, idx) => {
      const opt = result.options.find(o => o.id === optId);
      return opt?.messages?.[Number(idx)] || '';
    };

    panel.querySelectorAll('.llh-reply-copy').forEach(btn => {
      btn.addEventListener('click', async () => {
        const text = findMsg(btn.dataset.opt, btn.dataset.idx);
        const ok = await copyText(text);
        btn.textContent = ok ? 'Copied' : 'Fail';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
      });
    });

    panel.querySelectorAll('.llh-reply-insert').forEach(btn => {
      btn.addEventListener('click', () => {
        const text = findMsg(btn.dataset.opt, btn.dataset.idx);
        const ok = insertIntoCompose(text);
        btn.textContent = ok ? 'Inserted' : 'No box';
        setTimeout(() => { btn.textContent = 'Insert'; }, 1200);
      });
    });

    const copyNextBtn = panel.querySelector('.llh-reply-copy-next');
    const statusEl = panel.querySelector('.llh-reply-stack-status');

    panel.querySelectorAll('.llh-reply-use-stack').forEach(btn => {
      btn.addEventListener('click', () => {
        const opt = result.options.find(o => o.id === btn.dataset.opt);
        llhReplyStack = opt?.messages || [];
        llhReplyStackIndex = 0;
        copyNextBtn.disabled = llhReplyStack.length === 0;
        statusEl.textContent = `Stack ${btn.dataset.opt}: 0/${llhReplyStack.length} — click Copy next`;
        panel.querySelectorAll('.llh-reply-option').forEach(el => {
          el.classList.toggle('active', el.dataset.opt === btn.dataset.opt);
        });
      });
    });

    copyNextBtn.addEventListener('click', async () => {
      if (!llhReplyStack.length || llhReplyStackIndex >= llhReplyStack.length) return;
      const text = llhReplyStack[llhReplyStackIndex];
      await copyText(text);
      insertIntoCompose(text);
      llhReplyStackIndex++;
      statusEl.textContent =
        llhReplyStackIndex >= llhReplyStack.length
          ? `Done — sent stack manually (${llhReplyStack.length} msgs)`
          : `Copied ${llhReplyStackIndex}/${llhReplyStack.length} — paste/send, then Copy next`;
      if (llhReplyStackIndex >= llhReplyStack.length) copyNextBtn.disabled = true;
    });
  }

  function escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  
  const observer = new MutationObserver(() => {
    clearTimeout(window.llhInjectTimeout);
    window.llhInjectTimeout = setTimeout(() => {
      injectExtractButton();
      injectSuggestReplyButton();
      closeReplyPanelOnThreadSwitch();
    }, 500);
  });
  
  observer.observe(document.body, { childList: true, subtree: true });
  setTimeout(() => {
    injectExtractButton();
    injectSuggestReplyButton();
    closeReplyPanelOnThreadSwitch();
  }, 1000);
  window.addEventListener('popstate', closeReplyPanelOnThreadSwitch);
  setInterval(closeReplyPanelOnThreadSwitch, 800);
  
  let scrollTimeout;
  window.addEventListener('scroll', () => {
    clearTimeout(scrollTimeout);
    scrollTimeout = setTimeout(injectExtractButton, 300);
  }, { passive: true });
  
  console.log('LinkedIn Lead Harvester content script loaded (2026 DOM + messaging copilot)');
})();
