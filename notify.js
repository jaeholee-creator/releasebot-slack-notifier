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

// ============ RSS/Atom Parser ============

function parseRssFeed(xml, feedConfig) {
  const items = [];
  
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
  const escapedTag = tagName.replace(':', '\\:');
  
  const cdataRegex = new RegExp(`<${escapedTag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${escapedTag}>`, 'i');
  let match = xml.match(cdataRegex);
  if (match) return match[1].trim();
  
  const regex = new RegExp(`<${escapedTag}[^>]*>([\\s\\S]*?)<\\/${escapedTag}>`, 'i');
  match = xml.match(regex);
  if (match) return match[1].trim();
  
  return '';
}

function extractAtomLink(entry) {
  let match = entry.match(/<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["']/i);
  if (match) return match[1];
  
  match = entry.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i);
  if (match) return match[1];
  
  return '';
}

function stripHtml(text) {
  if (!text) return '';
  
  let result = text.replace(/^<!\[CDATA\[|\]\]>$/g, '');
  
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
  
  result = result
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/h[1-6]>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '');
  
  result = result
    .replace(/\n\s*\n\s*\n/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n /g, '\n')
    .replace(/ \n/g, '\n')
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
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  return kst.toISOString().split('T')[0];
}

async function getOrCreateDailyPage(state) {
  const today = getTodayString();
  const pageTitle = `${today} 신규 배포`;
  
  if (state.notion?.dailyPageId && state.notion?.dailyPageDate === today) {
    console.log(`  → Using existing daily page: ${pageTitle}`);
    return state.notion.dailyPageId;
  }
  
  console.log(`  → Creating daily page: ${pageTitle}`);
  
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
  
  state.notion = {
    dailyPageId: pageId,
    dailyPageDate: today
  };
  
  return pageId;
}

async function addToNotion(pageId, item, translatedSummary) {
  const isRss = item.feedType === 'rss';
  
  const title = isRss ? item.title : (item.release_details?.release_name || item.product?.display_name || 'Unknown');
  const vendor = isRss ? item.vendor : (item.product?.vendor?.display_name || 'Unknown');
  const url = isRss ? item.link : `https://releasebot.io/updates/${item.product?.vendor?.slug || ''}`;
  const source = isRss ? `📡 ${item.source}` : '🤖 Releasebot';
  const releaseDate = isRss 
    ? (item.pubDate instanceof Date ? item.pubDate.toLocaleDateString('ko-KR') : '')
    : (item.release_date ? new Date(item.release_date).toLocaleDateString('ko-KR') : '');
  
  const blocks = [
    {
      object: 'block',
      type: 'heading_3',
      heading_3: {
        rich_text: [
          {
            type: 'text',
            text: { content: `🚀 ${title.substring(0, 100)}`, link: url ? { url: url } : null }
          }
        ]
      }
    }
  ];
  
  if (translatedSummary) {
    const summaryText = translatedSummary.length > 500 
      ? translatedSummary.substring(0, 500) + '...' 
      : translatedSummary;
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [{ type: 'text', text: { content: summaryText } }]
      }
    });
  }
  
  blocks.push({
    object: 'block',
    type: 'paragraph',
    paragraph: {
      rich_text: [
        {
          type: 'text',
          text: { content: `${source} • ${vendor}${releaseDate ? ` • 📅 ${releaseDate}` : ''}` },
          annotations: { color: 'gray' }
        }
      ]
    }
  });
  
  blocks.push({
    object: 'block',
    type: 'divider',
    divider: {}
  });
  
  await notionRequest('PATCH', `/v1/blocks/${pageId}/children`, { children: blocks });
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
    
    console.log(`  → ${feed.name}`);
    
    try {
      const xml = await fetchUrl(feed.url);
      const items = parseRssFeed(xml, feed);
      
      const feedState = state.rss[feed.id] || { seenIds: [] };
      const seenSet = new Set(feedState.seenIds || []);
      
      const newItems = items.filter(item => !seenSet.has(item.id));
      console.log(`    Found ${items.length} items, ${newItems.length} new`);
      
      const limitedItems = newItems.slice(0, 5);
      
      for (const item of limitedItems) {
        allItems.push(item);
        seenSet.add(item.id);
      }
      
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
  
  const state = loadState();
  if (!state.rss) state.rss = {};
  if (!state.releasebot) state.releasebot = { lastSeenId: 0 };
  if (!state.notion) state.notion = {};
  
  const feedsConfig = loadFeeds();
  
  const releasebotItems = await processReleasebotFeed(state);
  const rssItems = await processRssFeeds(state, feedsConfig);
  
  const allItems = [...releasebotItems, ...rssItems];
  
  console.log(`\n📬 Total new items to process: ${allItems.length}`);
  
  if (allItems.length === 0) {
    console.log('No new items found');
    saveState(state);
    return;
  }
  
  let notionPageId = null;
  if (NOTION_API_TOKEN) {
    try {
      notionPageId = await getOrCreateDailyPage(state);
    } catch (e) {
      console.error(`  Notion setup failed: ${e.message}`);
    }
  }
  
  for (const item of allItems) {
    const isRss = item.feedType === 'rss';
    const itemName = isRss ? item.title.substring(0, 50) : (item.product?.display_name || 'Unknown');
    
    console.log(`\nProcessing: ${itemName}...`);
    
    const summary = isRss ? item.summary : (item.release_details?.release_summary || '');
    let translatedSummary = summary;
    if (summary && DEEPL_API_KEY) {
      console.log('  📝 Translating...');
      translatedSummary = await translateToKorean(summary.substring(0, 1500));
    }
    
    try {
      const { blocks, text } = formatSlackMessage(item, translatedSummary);
      await postToSlack(SLACK_CHANNEL_ID, blocks, text);
      console.log('  ✓ Slack: Posted');
    } catch (e) {
      console.error(`  ✗ Slack: ${e.message}`);
    }
    
    if (notionPageId) {
      try {
        await addToNotion(notionPageId, item, translatedSummary);
        console.log('  ✓ Notion: Added');
      } catch (e) {
        console.error(`  ✗ Notion: ${e.message}`);
      }
    }
    
    await sleep(1500);
  }
  
  saveState(state);
  console.log('\n✓ State saved');
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
