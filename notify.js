const https = require('https');
const http = require('http');
const fs = require('fs');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C0ACH02BLG5';
const RELEASEBOT_URL = process.env.RELEASEBOT_URL || 'https://releasebot.io/api/feed/bc2b4e2a-dad6-4245-a2c7-13a7bd9407d4.json';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID || '2ff686b49b3b80ef9502d23028ca574f';
const STATE_FILE = 'feed_state.json';
const FEEDS_FILE = 'feeds.json';

// ============ HTTP Utilities ============

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ReleaseBot/1.0)'
      }
    };
    client.get(url, options, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = res.headers.location.startsWith('http') 
          ? res.headers.location 
          : new URL(res.headers.location, url).href;
        return fetchUrl(redirectUrl).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function fetchJson(url) {
  return fetchUrl(url).then(data => JSON.parse(data));
}

// ============ RSS/Atom Parser (Improved) ============

function parseRssFeed(xml, feedConfig) {
  const items = [];
  
  // Try Atom format first
  const atomEntries = xml.match(/<entry[^>]*>[\s\S]*?<\/entry>/gi) || [];
  if (atomEntries.length > 0) {
    for (const entry of atomEntries) {
      const title = extractTagContent(entry, 'title');
      const link = extractAtomLink(entry);
      const published = extractTagContent(entry, 'published') || extractTagContent(entry, 'updated');
      const content = extractTagContent(entry, 'content') || extractTagContent(entry, 'summary');
      const id = extractTagContent(entry, 'id') || link;
      
      items.push({
        id: id,
        title: stripHtml(title),
        link: link,
        summary: stripHtml(content).substring(0, 500),
        pubDate: published ? new Date(published) : new Date(),
        source: feedConfig.name,
        vendor: feedConfig.vendor,
        feedType: 'rss'
      });
    }
    return items;
  }
  
  // Try RSS 2.0 format
  const rssItems = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) || [];
  for (const item of rssItems) {
    const title = extractTagContent(item, 'title');
    const link = extractTagContent(item, 'link') || extractAtomLink(item);
    const pubDate = extractTagContent(item, 'pubDate') || extractTagContent(item, 'dc:date');
    const description = extractTagContent(item, 'description') || extractTagContent(item, 'content:encoded');
    const guid = extractTagContent(item, 'guid') || link;
    
    items.push({
      id: guid,
      title: stripHtml(title),
      link: stripHtml(link),
      summary: stripHtml(description).substring(0, 500),
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      source: feedConfig.name,
      vendor: feedConfig.vendor,
      feedType: 'rss'
    });
  }
  
  return items;
}

function extractTagContent(xml, tagName) {
  // Handle namespaced tags like content:encoded
  const escapedTag = tagName.replace(':', '\\:');
  
  // Try to match with CDATA
  const cdataRegex = new RegExp(`<${escapedTag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${escapedTag}>`, 'i');
  let match = xml.match(cdataRegex);
  if (match) return match[1].trim();
  
  // Try regular content
  const regex = new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, 'i');
  match = xml.match(regex);
  if (match) return match[1].trim();
  
  return '';
}

function extractAtomLink(entry) {
  // Try alternate link first
  let match = entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (match) return match[1];
  
  // Try any link with href
  match = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (match) return match[1];
  
  return '';
}

function stripHtml(text) {
  if (!text) return '';
  
  // STEP 1: Remove CDATA markers
  let result = text.replace(/^<!\[CDATA\[|\]\]>$/g, '');
  
  // STEP 2: Decode HTML entities FIRST (before stripping tags!)
  result = result
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  
  // STEP 3: Now strip HTML tags (after entities are decoded to actual < and >)
  result = result
    // Remove script and style contents
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    // Convert block elements to newlines for readability
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    // Remove all remaining HTML tags
    .replace(/<[^>]+>/g, '');
  
  // STEP 4: Normalize whitespace
  result = result
    .replace(/\n\s*\n\s*\n/g, '\n\n')  // Max 2 consecutive newlines
    .replace(/[ \t]+/g, ' ')            // Multiple spaces to single
    .replace(/\n /g, '\n')              // Remove leading space after newline
    .replace(/ \n/g, '\n')              // Remove trailing space before newline
    .trim();
  
  return result;
}

// ============ State Management ============

function loadState() {
  try {
    const content = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return { releasebot: { lastSeenId: 0 }, rss: {}, notion: {} };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadFeeds() {
  try {
    const content = fs.readFileSync(FEEDS_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return { rssFeeds: [] };
  }
}

// ============ Notion Functions ============

function notionRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    
    const options = {
      hostname: 'api.notion.com',
      path: path,
      method: method,
      headers: {
        'Authorization': `Bearer ${NOTION_API_TOKEN}`,
        'Content-Type': 'application/json',
        'Notion-Version': '2022-06-28'
      }
    };
    
    if (payload) {
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(new Error(`Notion API error (${res.statusCode}): ${result.message || JSON.stringify(result)}`));
          } else {
            resolve(result);
          }
        } catch (e) {
          reject(new Error(`Failed to parse Notion response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getTodayString() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000)); // UTC+9
  return kst.toISOString().split('T')[0]; // YYYY-MM-DD
}

function getYesterdayRange() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000)); // UTC+9
  
  // Yesterday start (00:00:00 KST)
  const yesterdayStart = new Date(kst);
  yesterdayStart.setDate(yesterdayStart.getDate() - 1);
  yesterdayStart.setHours(0, 0, 0, 0);
  
  // Yesterday end (23:59:59 KST)
  const yesterdayEnd = new Date(kst);
  yesterdayEnd.setDate(yesterdayEnd.getDate() - 1);
  yesterdayEnd.setHours(23, 59, 59, 999);
  
  // Convert back to UTC for comparison
  const startUtc = new Date(yesterdayStart.getTime() - (9 * 60 * 60 * 1000));
  const endUtc = new Date(yesterdayEnd.getTime() - (9 * 60 * 60 * 1000));
  
  return { start: startUtc, end: endUtc };
}

function isYesterday(date) {
  if (!date) return false;
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return false;
  
  const { start, end } = getYesterdayRange();
  return d >= start && d <= end;
}

function getYesterdayString() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000)); // UTC+9
  kst.setDate(kst.getDate() - 1);
  return kst.toISOString().split('T')[0]; // YYYY-MM-DD
}

async function getOrCreateDailyPage(state) {
  const yesterday = getYesterdayString();
  const pageTitle = `${yesterday} 신규 배포`;
  
  if (state.notion?.dailyPageId && state.notion?.dailyPageDate === yesterday) {
    console.log(`  → Using existing daily page: ${pageTitle}`);
    return { pageId: state.notion.dailyPageId, dbId: state.notion.dailyDbId };
  }
  
  console.log(`  → Creating daily page: ${pageTitle}`);
  
  // Create new page for today
  const pagePayload = {
    parent: { page_id: NOTION_PAGE_ID },
    properties: {
      title: {
        title: [{ text: { content: pageTitle } }]
      }
    },
    children: [
      {
        object: 'block',
        type: 'heading_2',
        heading_2: {
          rich_text: [{ text: { content: '📦 오늘의 릴리스' } }]
        }
      }
    ]
  };
  
  const page = await notionRequest('POST', '/v1/pages', pagePayload);
  const pageId = page.id;
  console.log(`  ✓ Created page: ${pageId}`);
  
  // Create database inside the page
  console.log(`  → Creating database inside page...`);
  const dbPayload = {
    parent: { page_id: pageId },
    title: [{ type: 'text', text: { content: '릴리스 목록' } }],
    is_inline: true,
    properties: {
      '제목': { title: {} },
      '벤더': { select: {} },
      '날짜': { date: {} },
      '요약': { rich_text: {} },
      'URL': { url: {} },
      '소스': { select: {} }
    }
  };
  
  const db = await notionRequest('POST', '/v1/databases', dbPayload);
  const dbId = db.id;
  console.log(`  ✓ Created database: ${dbId}`);
  
  state.notion = {
    dailyPageId: pageId,
    dailyDbId: dbId,
    dailyPageDate: yesterday
  };
  
  return { pageId, dbId };
}

async function addToNotion(dbId, item, translatedSummary) {
  const isRss = item.feedType === 'rss';
  
  const title = isRss ? item.title : (item.release_details?.release_name || item.product?.display_name || 'Unknown');
  const vendor = isRss ? item.vendor : (item.product?.vendor?.display_name || 'Unknown');
  const releaseDate = isRss 
    ? (item.pubDate instanceof Date ? item.pubDate.toISOString() : item.pubDate)
    : (item.release_date || item.created_at);
  const url = isRss ? item.link : `https://releasebot.io/updates/${item.product?.vendor?.slug || ''}`;
  const source = isRss ? 'RSS' : 'Releasebot';
  
  const pagePayload = {
    parent: { database_id: dbId },
    properties: {
      '제목': { title: [{ text: { content: title.substring(0, 100) } }] },
      '벤더': { select: { name: vendor } },
      '날짜': { date: releaseDate ? { start: releaseDate.split('T')[0] } : null },
      '요약': { rich_text: [{ text: { content: (translatedSummary || '').substring(0, 2000) } }] },
      'URL': { url: url || null },
      '소스': { select: { name: source } }
    }
  };
  
  await notionRequest('POST', '/v1/pages', pagePayload);
}

// ============ Translation ============

function translateToKorean(text) {
  if (!DEEPL_API_KEY || !text) {
    return Promise.resolve(text);
  }
  
  return new Promise((resolve) => {
    const postData = JSON.stringify({ text: [text], target_lang: 'KO' });
    
    const options = {
      hostname: 'api-free.deepl.com',
      path: '/v2/translate',
      method: 'POST',
      headers: {
        'Authorization': `DeepL-Auth-Key ${DEEPL_API_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.translations && result.translations[0]) {
            resolve(result.translations[0].text);
          } else {
            resolve(text);
          }
        } catch (e) {
          resolve(text);
        }
      });
    });
    
    req.on('error', () => resolve(text));
    req.write(postData);
    req.end();
  });
}

// ============ Slack Functions ============

function postToSlack(channel, blocks, text) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({ channel, blocks, text });
    
    const options = {
      hostname: 'slack.com',
      path: '/api/chat.postMessage',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Bearer ${SLACK_BOT_TOKEN}`,
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.ok) resolve(result);
          else reject(new Error(`Slack API error: ${result.error}`));
        } catch (e) {
          reject(new Error(`Failed to parse Slack response: ${e.message}`));
        }
      });
    });
    
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

function formatSlackMessage(item, translatedSummary) {
  const isRss = item.feedType === 'rss';
  
  const title = isRss ? item.title : `${item.product?.vendor?.display_name || ''} ${item.product?.display_name || 'Unknown'}`;
  const version = isRss ? '' : (item.release_details?.release_number || item.release_details?.release_name || '');
  const url = isRss ? item.link : `https://releasebot.io/updates/${item.product?.vendor?.slug || ''}`;
  const vendor = isRss ? item.vendor : (item.product?.vendor?.display_name || '');
  const source = isRss ? `📡 ${item.source}` : '🤖 Releasebot';
  const releaseDate = isRss 
    ? (item.pubDate instanceof Date ? item.pubDate.toLocaleDateString('ko-KR') : '')
    : (item.release_date ? new Date(item.release_date).toLocaleDateString('ko-KR') : '');
  
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🚀 ${title}`.substring(0, 150),
        emoji: true
      }
    }
  ];
  
  if (version) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*버전:* \`${version}\`` }
    });
  }
  
  if (translatedSummary) {
    const summaryText = translatedSummary.length > 500 
      ? translatedSummary.substring(0, 500) + '...' 
      : translatedSummary;
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: summaryText }
    });
  }
  
  if (url) {
    blocks.push({
      type: 'actions',
      elements: [{
        type: 'button',
        text: { type: 'plain_text', text: '📖 자세히 보기', emoji: true },
        url: url,
        action_id: 'view_release'
      }]
    });
  }
  
  blocks.push({
    type: 'context',
    elements: [{
      type: 'mrkdwn',
      text: `${source} • ${vendor}${releaseDate ? ` • 📅 ${releaseDate}` : ''}`
    }]
  });
  
  blocks.push({ type: 'divider' });
  
  return { blocks, text: `${title} ${version}`.trim() };
}

// ============ Main Functions ============

async function processReleasebotFeed(state) {
  console.log('\n📦 Processing Releasebot feed...');
  
  const lastSeenId = state.releasebot?.lastSeenId || 0;
  console.log(`  Last seen ID: ${lastSeenId}`);
  
  let data;
  try {
    data = await fetchJson(RELEASEBOT_URL);
  } catch (e) {
    console.error(`  ✗ Failed to fetch Releasebot: ${e.message}`);
    return [];
  }
  
  const releases = data.releases || [];
  const newReleases = releases
    .filter(r => r.id > lastSeenId)
    .filter(r => isYesterday(r.release_date || r.created_at))
    .sort((a, b) => a.id - b.id);
  
  const { start, end } = getYesterdayRange();
  console.log(`  Filtering for yesterday: ${start.toISOString()} ~ ${end.toISOString()}`);
  console.log(`  New releases from yesterday: ${newReleases.length}`);
  
  const processed = [];
  for (const release of newReleases) {
    release.feedType = 'releasebot';
    processed.push(release);
    state.releasebot.lastSeenId = release.id;
  }
  
  return processed;
}

async function processRssFeeds(state, feedsConfig) {
  const rssFeeds = feedsConfig.rssFeeds || [];
  if (rssFeeds.length === 0) {
    console.log('\n📡 No RSS feeds configured');
    return [];
  }
  
  console.log(`\n📡 Processing ${rssFeeds.length} RSS feed(s)...`);
  
  const allItems = [];
  
  for (const feed of rssFeeds) {
    if (!feed.enabled) continue;
    
    console.log(`  → ${feed.name}`);
    
    try {
      const xml = await fetchUrl(feed.url);
      const items = parseRssFeed(xml, feed);
      
      const feedState = state.rss[feed.id] || { seenIds: [] };
      const seenSet = new Set(feedState.seenIds || []);
      
      const newItems = items
        .filter(item => !seenSet.has(item.id))
        .filter(item => isYesterday(item.pubDate));
      console.log(`    Found ${items.length} items, ${newItems.length} from yesterday`);
      
      // Limit to most recent 5 new items per feed
      const limitedItems = newItems.slice(0, 5);
      
      for (const item of limitedItems) {
        allItems.push(item);
        seenSet.add(item.id);
      }
      
      // Keep only last 100 seen IDs per feed
      state.rss[feed.id] = {
        seenIds: Array.from(seenSet).slice(-100)
      };
      
    } catch (e) {
      console.error(`    ✗ Failed: ${e.message}`);
    }
  }
  
  return allItems;
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Release Notifier (Releasebot + RSS) ===\n');
  
  if (!SLACK_BOT_TOKEN) {
    console.error('❌ Error: SLACK_BOT_TOKEN is required');
    process.exit(1);
  }
  
  console.log('Configuration:');
  console.log(`  SLACK_CHANNEL_ID: ${SLACK_CHANNEL_ID}`);
  console.log(`  DEEPL_API_KEY: ${DEEPL_API_KEY ? 'set' : 'NOT SET'}`);
  console.log(`  NOTION_API_TOKEN: ${NOTION_API_TOKEN ? 'set' : 'NOT SET'}`);
  console.log(`  Filtering: Yesterday only (${getYesterdayString()})`);
  
  // Load state and feeds config
  const state = loadState();
  if (!state.rss) state.rss = {};
  if (!state.releasebot) state.releasebot = { lastSeenId: 0 };
  if (!state.notion) state.notion = {};
  
  const feedsConfig = loadFeeds();
  
  // Process all feeds first
  const releasebotItems = await processReleasebotFeed(state);
  const rssItems = await processRssFeeds(state, feedsConfig);
  
  const allItems = [...releasebotItems, ...rssItems];
  
  console.log(`\n📬 Total new items to process: ${allItems.length}`);
  
  if (allItems.length === 0) {
    console.log('No new items found');
    saveState(state);
    return;
  }
  
  // Initialize Notion daily page if needed
  let notionDbId = null;
  if (NOTION_API_TOKEN) {
    try {
      const { dbId } = await getOrCreateDailyPage(state);
      notionDbId = dbId;
    } catch (e) {
      console.error(`  Notion setup failed: ${e.message}`);
    }
  }
  
  // Process each item
  for (const item of allItems) {
    const isRss = item.feedType === 'rss';
    const itemName = isRss ? item.title.substring(0, 50) : (item.product?.display_name || 'Unknown');
    
    console.log(`\nProcessing: ${itemName}...`);
    
    // Get summary and translate
    const summary = isRss ? item.summary : (item.release_details?.release_summary || '');
    let translatedSummary = summary;
    if (summary && DEEPL_API_KEY) {
      console.log('  📝 Translating...');
      translatedSummary = await translateToKorean(summary.substring(0, 1500));
    }
    
    // Post to Slack
    try {
      const { blocks, text } = formatSlackMessage(item, translatedSummary);
      await postToSlack(SLACK_CHANNEL_ID, blocks, text);
      console.log('  ✓ Slack: Posted');
    } catch (e) {
      console.error(`  ✗ Slack: ${e.message}`);
    }
    
    // Add to Notion
    if (notionDbId) {
      try {
        await addToNotion(notionDbId, item, translatedSummary);
        console.log('  ✓ Notion: Added');
      } catch (e) {
        console.error(`  ✗ Notion: ${e.message}`);
      }
    }
    
    await sleep(1500);
  }
  
  // Save state
  saveState(state);
  console.log('\n✓ State saved');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
