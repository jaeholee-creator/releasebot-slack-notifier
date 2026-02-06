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
const NOTION_DB_FILE = 'notion_db_id.txt';
const FEEDS_FILE = 'feeds.json';

// ============ HTTP Utilities ============

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    client.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
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

// ============ RSS/Atom Parser ============

function parseRssFeed(xml, feedConfig) {
  const items = [];
  
  // Try Atom format first
  const atomEntries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  if (atomEntries.length > 0) {
    for (const entry of atomEntries) {
      const title = extractTag(entry, 'title');
      const link = extractAtomLink(entry);
      const published = extractTag(entry, 'published') || extractTag(entry, 'updated');
      const summary = extractTag(entry, 'summary') || extractTag(entry, 'content');
      const id = extractTag(entry, 'id') || link;
      
      items.push({
        id: id,
        title: cleanHtml(title),
        link: link,
        summary: cleanHtml(summary),
        pubDate: published ? new Date(published) : new Date(),
        source: feedConfig.name,
        vendor: feedConfig.vendor,
        feedType: 'rss'
      });
    }
    return items;
  }
  
  // Try RSS 2.0 format
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const item of rssItems) {
    const title = extractTag(item, 'title');
    const link = extractTag(item, 'link');
    const pubDate = extractTag(item, 'pubDate');
    const description = extractTag(item, 'description');
    const guid = extractTag(item, 'guid') || link;
    
    items.push({
      id: guid,
      title: cleanHtml(title),
      link: link,
      summary: cleanHtml(description),
      pubDate: pubDate ? new Date(pubDate) : new Date(),
      source: feedConfig.name,
      vendor: feedConfig.vendor,
      feedType: 'rss'
    });
  }
  
  return items;
}

function extractTag(xml, tag) {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i');
  const match = xml.match(regex);
  if (match) {
    return match[1].replace(/^<!\[CDATA\[|\]\]>$/g, '').trim();
  }
  return '';
}

function extractAtomLink(entry) {
  const linkMatch = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/);
  return linkMatch ? linkMatch[1] : '';
}

function cleanHtml(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// ============ State Management ============

function loadState() {
  try {
    const content = fs.readFileSync(STATE_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    return { releasebot: { lastSeenId: 0 }, rss: {} };
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

async function getOrCreateNotionDatabase() {
  let dbId = null;
  try {
    dbId = fs.readFileSync(NOTION_DB_FILE, 'utf8').trim();
    if (dbId) {
      try {
        await notionRequest('GET', `/v1/databases/${dbId}`);
        return dbId;
      } catch (e) {
        dbId = null;
      }
    }
  } catch (e) {}
  
  console.log(`  → Creating new Notion database...`);
  
  const dbPayload = {
    parent: { page_id: NOTION_PAGE_ID },
    title: [{ type: 'text', text: { content: 'Release Updates' } }],
    properties: {
      '제품명': { title: {} },
      '버전': { rich_text: {} },
      '벤더': { select: {} },
      '요약': { rich_text: {} },
      '날짜': { date: {} },
      'URL': { url: {} },
      '소스': { select: {} }
    }
  };
  
  const result = await notionRequest('POST', '/v1/databases', dbPayload);
  dbId = result.id;
  fs.writeFileSync(NOTION_DB_FILE, dbId);
  console.log(`  ✓ Created Notion database: ${dbId}`);
  
  return dbId;
}

async function addToNotion(dbId, item, translatedSummary) {
  const isRss = item.feedType === 'rss';
  
  const product = isRss ? item.source : (item.product?.display_name || 'Unknown');
  const vendor = isRss ? item.vendor : (item.product?.vendor?.display_name || '');
  const version = isRss ? '' : (item.release_details?.release_number || item.release_details?.release_name || '');
  const releaseDate = isRss 
    ? (item.pubDate instanceof Date ? item.pubDate.toISOString() : item.pubDate)
    : (item.release_date || item.created_at);
  const url = isRss ? item.link : `https://releasebot.io/updates/${item.product?.vendor?.slug || ''}`;
  const source = isRss ? 'RSS' : 'Releasebot';
  
  const pagePayload = {
    parent: { database_id: dbId },
    properties: {
      '제품명': { title: [{ text: { content: isRss ? item.title.substring(0, 100) : product } }] },
      '버전': { rich_text: [{ text: { content: version || '-' } }] },
      '벤더': { select: { name: vendor || 'Unknown' } },
      '요약': { rich_text: [{ text: { content: (translatedSummary || '').substring(0, 2000) } }] },
      '날짜': { date: releaseDate ? { start: releaseDate.split('T')[0] } : null },
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
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: translatedSummary.length > 500 ? translatedSummary.substring(0, 500) + '...' : translatedSummary
      }
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

async function processReleasebotFeed(state, notionDbId) {
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
    .sort((a, b) => a.id - b.id);
  
  console.log(`  New releases: ${newReleases.length}`);
  
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
    
    console.log(`  → ${feed.name}: ${feed.url}`);
    
    try {
      const xml = await fetchUrl(feed.url);
      const items = parseRssFeed(xml, feed);
      
      const feedState = state.rss[feed.id] || { seenIds: [] };
      const seenSet = new Set(feedState.seenIds || []);
      
      const newItems = items.filter(item => !seenSet.has(item.id));
      console.log(`    Found ${items.length} items, ${newItems.length} new`);
      
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
  
  // Load state and feeds config
  const state = loadState();
  if (!state.rss) state.rss = {};
  if (!state.releasebot) state.releasebot = { lastSeenId: 0 };
  
  const feedsConfig = loadFeeds();
  
  // Initialize Notion
  let notionDbId = null;
  if (NOTION_API_TOKEN) {
    try {
      notionDbId = await getOrCreateNotionDatabase();
      console.log(`  Notion DB: ${notionDbId}`);
    } catch (e) {
      console.error(`  Notion setup failed: ${e.message}`);
    }
  }
  
  // Process all feeds
  const releasebotItems = await processReleasebotFeed(state, notionDbId);
  const rssItems = await processRssFeeds(state, feedsConfig);
  
  const allItems = [...releasebotItems, ...rssItems];
  
  console.log(`\n📬 Total new items to process: ${allItems.length}`);
  
  if (allItems.length === 0) {
    console.log('No new items found');
    saveState(state);
    return;
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
