const https = require('https');
const http = require('http');
const fs = require('fs');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C0ACH02BLG5';
const RELEASEBOT_URL = process.env.RELEASEBOT_URL || 'https://releasebot.io/api/feed/bc2b4e2a-dad6-4245-a2c7-13a7bd9407d4.json';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID || '2ff686b49b3b80ef9502d23028ca574f';
const NOTION_RELEASES_PAGE_ID = process.env.NOTION_RELEASES_PAGE_ID || '302686b49b3b81c8a903ca9111299fe3';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STATE_FILE = 'feed_state.json';
const FEEDS_FILE = 'feeds.json';
const USER_ENV_FILE = 'user_environment.json';

// Configuration
const RETENTION_DAYS = 30;  // Only process items from last 30 days
const MAX_SEEN_IDS = 100;   // Keep last 100 seen IDs per feed (increased from 30)
const MAX_ITEMS_PER_FEED = 5;  // Max items to process per feed per run

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

// ============ Date Utilities ============

/**
 * 오늘 날짜 시작 시간 (KST 00:00:00)
 */
function getTodayStartKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 * 60 * 1000));
  const todayStr = kst.toISOString().split('T')[0];
  // KST 00:00:00을 UTC로 변환 (KST 00:00 = UTC 전날 15:00)
  return new Date(todayStr + 'T00:00:00+09:00');
}

/**
 * 날짜가 오늘인지 확인 (KST 기준)
 */
function isToday(date) {
  if (!date || isNaN(date.getTime())) return false;
  const todayStart = getTodayStartKST();
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  return date >= todayStart && date < tomorrowStart;
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
        pubDate: published ? new Date(published) : null,  // null if no date
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
      pubDate: pubDate ? new Date(pubDate) : null,  // null if no date
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

function loadUserEnvironment() {
  try {
    const content = fs.readFileSync(USER_ENV_FILE, 'utf8');
    return JSON.parse(content);
  } catch (e) {
    console.warn('⚠️ user_environment.json not found, analysis will be skipped');
    return null;
  }
}

// ============ Claude API ============

async function callClaude(prompt) {
  if (!ANTHROPIC_API_KEY) {
    return null;
  }

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 800,  // 500에서 800으로 증가 (더 상세한 분석)
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.content && result.content[0]) {
            resolve(result.content[0].text);
          } else {
            console.error('  ✗ Claude API unexpected response:', JSON.stringify(result).substring(0, 200));
            resolve(null);
          }
        } catch (e) {
          console.error('  ✗ Claude API parse error:', e.message);
          resolve(null);
        }
      });
    });

    req.on('error', (e) => {
      console.error('  ✗ Claude API request error:', e.message);
      resolve(null);
    });

    req.setTimeout(30000, () => {
      console.error('  ✗ Claude API timeout');
      req.destroy();
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}


/**
 * 사용자 환경과 릴리스의 관련성 분석
 */
async function analyzeRelevanceToEnvironment(item, userEnv) {
  if (!ANTHROPIC_API_KEY || !userEnv) {
    return null;
  }

  const isRss = item.feedType === 'rss';
  const title = isRss ? item.title : (item.release_details?.release_name || item.product?.display_name || 'Unknown');
  const summary = isRss ? item.summary : (item.release_details?.release_summary || '');
  const vendor = isRss ? item.vendor : (item.product?.vendor?.display_name || 'Unknown');

  // 환경 정보를 구조화된 형태로 요약 (user_environment.json v2.0 구조에 맞춤)
  const envContext = {
    cli: userEnv.cli_tool?.name || 'Unknown',
    mcpServers: Object.keys(userEnv.mcp_servers || {}).join(', '),
    skills: Object.keys(userEnv.skills || {}).join(', '),
    techStack: (userEnv.technology_stack || []).join(', '),
    activeProjects: Object.keys(userEnv.active_projects || {}).join(', '),
    interests: (userEnv.interests_and_focus || userEnv.interests || []).slice(0, 5).join(', ')
  };

  const prompt = `당신은 소프트웨어 릴리스 분석 전문가입니다. 새로운 릴리스가 사용자의 개발 환경에 미치는 영향을 분석해주세요.

## 사용자 환경
- CLI 도구: ${envContext.cli}
- MCP 서버: ${envContext.mcpServers}
- 스킬: ${envContext.skills}
- 기술 스택: ${envContext.techStack}
- 활성 프로젝트: ${envContext.activeProjects}
- 관심사: ${envContext.interests}

## 새로운 릴리스
**벤더:** ${vendor}
**제목:** ${title}
**내용:**
${summary.substring(0, 1200)}

## 분석 요청
다음 형식으로 **한국어**로 간결하게 응답해주세요:

**📊 관련도:** [🔴 매우 높음 / 🟡 보통 / 🟢 낮음 / ⚪ 무관]

**💡 핵심 요약:** (1-2문장으로 이 릴리스의 핵심 내용)

**🎯 환경 영향:**
- 현재 사용 중인 도구/기술과의 연관성
- 이 릴리스가 사용자 환경에 미칠 구체적 영향
- (관련 없으면 "이 기술/도구는 [간단 설명]")

**✅ 액션 아이템:** [즉시 적용 📥 / 검토 필요 🔍 / 참고만 📌 / 해당 없음 ➖]

**이유:** (1문장으로 액션 아이템 선택 사유)

---
전체 응답은 250자 이내로 작성하세요.`;

  try {
    const analysis = await callClaude(prompt);
    if (analysis) {
      console.log(`  ✓ Analysis complete (${analysis.length} chars)`);
    }
    return analysis;
  } catch (e) {
    console.error(`  ✗ Analysis failed: ${e.message}`);
    return null;
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

async function getOrCreateReleasesPage(state) {
  // 사용자가 이미 생성한 "🚀 신규 배포" 페이지 사용
  const releasesPageId = NOTION_RELEASES_PAGE_ID;

  console.log(`  ✓ Using Releases page: ${releasesPageId}`);

  return {
    releasesPageId: releasesPageId
  };
}

async function getOrCreateDailyPage(state, releasesPageId) {
  const today = getTodayString();
  const pageTitle = `📅 ${today} 신규 배포`;

  if (state.notion.dailyPageDate === today && state.notion.dailyPageId) {
    console.log(`  ✓ Today's page exists: ${state.notion.dailyPageId}`);
    return state.notion.dailyPageId;
  }

  console.log(`  📄 Creating child page: ${pageTitle}`);

  const payload = {
    parent: { page_id: releasesPageId },
    properties: {
      title: { title: [{ text: { content: pageTitle }}]}
    },
    icon: { emoji: '📅' },
    children: [
      {
        type: 'heading_2',
        heading_2: {
          rich_text: [{ text: { content: '🚀 오늘의 릴리스' }}]
        }
      }
    ]
  };

  const response = await notionRequest('POST', '/v1/pages', payload);
  const pageId = response.id;

  state.notion.dailyPageDate = today;
  state.notion.dailyPageId = pageId;

  console.log(`  ✓ Child page created: ${pageId}`);

  return pageId;
}

async function addLinkToReleasesPage(releasesPageId, dailyPageId, dateString) {
  console.log(`  🔗 Adding link to Releases page: ${dateString}`);

  // "신규 배포" 페이지 상단에 링크 추가
  const existingBlocks = await notionRequest('GET', `/v1/blocks/${releasesPageId}/children`);

  // 이미 오늘 날짜 링크가 있는지 확인
  for (const block of existingBlocks.results) {
    if (block.type === 'child_page' && block.child_page) {
      const pageTitle = block.child_page.title || '';
      if (pageTitle.includes(dateString)) {
        console.log(`  ✓ Child page already exists for ${dateString}`);
        return;
      }
    }
  }

  console.log(`  ✓ Child page will appear automatically in Releases page`);
}

async function addToNotion(dailyPageId, item, translatedSummary, analysis) {
  const isRss = item.feedType === 'rss';

  const title = isRss ? item.title : (item.release_details?.release_name || item.product?.display_name || 'Unknown');
  const vendor = isRss ? item.vendor : (item.product?.vendor?.display_name || 'Unknown');
  const url = isRss ? item.link : `https://releasebot.io/updates/${item.product?.vendor?.slug || ''}`;
  const dateStr = isRss
    ? (item.pubDate instanceof Date ? item.pubDate.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '')
    : (item.release_date ? new Date(item.release_date).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '');

  const blocks = [
    {
      object: 'block',
      type: 'heading_3',
      heading_3: {
        rich_text: [
          {
            type: 'text',
            text: { content: `🔹 ${title.substring(0, 100)}` }
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
          text: { content: `📡 ${vendor} • ${dateStr}` },
          annotations: { color: 'gray' }
        }
      ]
    }
  });

  if (url) {
    blocks.push({
      object: 'block',
      type: 'paragraph',
      paragraph: {
        rich_text: [
          {
            type: 'text',
            text: { content: '🔗 ', link: null }
          },
          {
            type: 'text',
            text: { content: '자세히 보기', link: { url: url } },
            annotations: { color: 'blue' }
          }
        ]
      }
    });
  }

  // 환경 분석 결과 추가
  if (analysis) {
    blocks.push({
      object: 'block',
      type: 'callout',
      callout: {
        rich_text: [{ type: 'text', text: { content: analysis } }],
        icon: { emoji: '📊' },
        color: 'blue_background'
      }
    });
  }

  blocks.push({
    object: 'block',
    type: 'divider',
    divider: {}
  });

  await notionRequest('PATCH', `/v1/blocks/${dailyPageId}/children`, { children: blocks });
  console.log(`  ✓ Notion: Added to child page`);
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

function formatSlackMessage(item, translatedSummary, analysis) {
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
  
  // 환경 분석 결과 추가
  if (analysis) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `📊 *환경 분석:*\n${analysis}`
      }
    });
  }
  
  blocks.push({ type: 'divider' });
  
  return { blocks, text: `${title} ${version}`.trim() };
}

// ============ Main Functions ============

async function processReleasebotFeed(state) {
  console.log('\n📦 Processing Releasebot feed...');

  const lastSeenId = state.releasebot?.lastSeenId || 0;
  // 최근 7일의 릴리스 가져오기 (테스트용)
  const todayStart = getTodayStartKST();
  const sevenDaysAgo = new Date(todayStart.getTime() - (7 * 24 * 60 * 60 * 1000));

  console.log(`  Last seen ID: ${lastSeenId}`);
  console.log(`  Date filter (last 7 days): ${sevenDaysAgo.toISOString()}`);
  
  let data;
  try {
    data = await fetchJson(RELEASEBOT_URL);
  } catch (e) {
    console.error(`  ✗ Failed to fetch Releasebot: ${e.message}`);
    return [];
  }
  
  const releases = data.releases || [];
  console.log(`  Total releases in API: ${releases.length}`);
  
  const newReleases = releases.filter(r => {
    // ID 체크
    if (r.id <= lastSeenId) return false;

    // 날짜 체크
    const releaseDate = r.release_date ? new Date(r.release_date) : null;
    if (!releaseDate || isNaN(releaseDate.getTime())) {
      console.log(`  ⏭️ Skip (no date): ID=${r.id}`);
      return false;
    }

    if (releaseDate < sevenDaysAgo) {
      return false;  // 7일 이전이면 건너뛰기
    }

    return true;
  }).sort((a, b) => a.id - b.id);
  
  console.log(`  Today's new releases: ${newReleases.length}`);
  
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

  // 최근 7일의 RSS 항목 가져오기 (테스트용)
  const todayStart = getTodayStartKST();
  const sevenDaysAgo = new Date(todayStart.getTime() - (7 * 24 * 60 * 60 * 1000));
  console.log(`  Date filter (last 7 days): ${sevenDaysAgo.toISOString()}`);
  
  const allItems = [];
  
  for (const feed of rssFeeds) {
    if (!feed.enabled) {
      console.log(`  → ${feed.name}: DISABLED`);
      continue;
    }
    
    console.log(`  → ${feed.name}`);
    
    try {
      const xml = await fetchUrl(feed.url);
      const items = parseRssFeed(xml, feed);
      
      console.log(`    RSS items fetched: ${items.length}`);
      
      const feedState = state.rss[feed.id] || { seenIds: [] };
      const seenSet = new Set(feedState.seenIds || []);
      
      // 최근 7일 + 미확인 항목만 필터링
      const newItems = items.filter(item => {
        // 날짜 없는 항목 건너뛰기
        if (!item.pubDate || isNaN(item.pubDate.getTime())) {
          console.log(`    ⏭️ Skip (no date): "${item.title.substring(0, 40)}..."`);
          return false;
        }

        // 7일 이전 항목 건너뛰기
        if (item.pubDate < sevenDaysAgo) {
          return false;
        }

        // 이미 본 항목 건너뛰기
        if (seenSet.has(item.id)) {
          console.log(`    ⏭️ Skip (seen): "${item.title.substring(0, 40)}..."`);
          return false;
        }

        return true;
      });

      console.log(`    Recent new items (last 7 days): ${newItems.length}`);
      
      // 모든 오늘 항목 처리 (개수 제한 없음)
      for (const item of newItems) {
        allItems.push(item);
        seenSet.add(item.id);
      }
      
      // seenIds 업데이트 (최근 100개 유지)
      state.rss[feed.id] = {
        seenIds: Array.from(seenSet).slice(-MAX_SEEN_IDS),
        lastUpdated: new Date().toISOString()
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
  console.log('='.repeat(60));
  console.log('=== Release Notifier (Releasebot + RSS) ===');
  console.log(`=== Started: ${new Date().toISOString()} ===`);
  console.log('='.repeat(60));
  
  if (!SLACK_BOT_TOKEN) {
    console.error('❌ Error: SLACK_BOT_TOKEN is required');
    process.exit(1);
  }
  
  console.log('\n📋 Configuration:');
  console.log(`  SLACK_CHANNEL_ID: ${SLACK_CHANNEL_ID}`);
  console.log(`  DEEPL_API_KEY: ${DEEPL_API_KEY ? 'set' : 'NOT SET'}`);
  console.log(`  NOTION_API_TOKEN: ${NOTION_API_TOKEN ? 'set' : 'NOT SET'}`);
  console.log(`  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? 'set' : 'NOT SET'}`);
  
  const state = loadState();
  if (!state.rss) state.rss = {};
  if (!state.releasebot) state.releasebot = { lastSeenId: 0 };
  if (!state.notion) state.notion = {};
  
  const feedsConfig = loadFeeds();
  const userEnv = loadUserEnvironment();
  
  if (userEnv) {
    console.log(`\n👤 User environment loaded: ${userEnv.cli_tool.name}`);
  }
  
  const releasebotItems = await processReleasebotFeed(state);
  const rssItems = await processRssFeeds(state, feedsConfig);
  
  const allItems = [...releasebotItems, ...rssItems];
  
  console.log(`\n📬 Total new items to process: ${allItems.length}`);

  if (allItems.length === 0) {
    console.log('No new items found');
    saveState(state);
    console.log('\n✓ State saved');
    printSummary(0, 0, 0, 0);
    return;
  }

  let releasesPageId = null;
  let dailyPageId = null;

  if (NOTION_API_TOKEN) {
    try {
      const releasesData = await getOrCreateReleasesPage(state);
      releasesPageId = releasesData.releasesPageId;

      dailyPageId = await getOrCreateDailyPage(state, releasesPageId);

      const today = getTodayString();
      await addLinkToReleasesPage(releasesPageId, dailyPageId, today);
    } catch (e) {
      console.error(`  ✗ Notion setup failed: ${e.message}`);
    }
  }

  let slackSuccessCount = 0;
  let slackFailCount = 0;
  let notionSuccessCount = 0;
  let notionFailCount = 0;

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

    // 환경 분석
    let analysis = null;
    if (userEnv && ANTHROPIC_API_KEY) {
      console.log('  📊 Analyzing relevance...');
      analysis = await analyzeRelevanceToEnvironment(item, userEnv);
    }

    try {
      const { blocks, text } = formatSlackMessage(item, translatedSummary, analysis);
      await postToSlack(SLACK_CHANNEL_ID, blocks, text);
      console.log('  ✓ Slack: Posted');
      slackSuccessCount++;
    } catch (e) {
      console.error(`  ✗ Slack: ${e.message}`);
      slackFailCount++;
    }

    if (dailyPageId) {
      try {
        await addToNotion(dailyPageId, item, translatedSummary, analysis);
        console.log('  ✓ Notion: Added');
        notionSuccessCount++;
      } catch (e) {
        console.error(`  ✗ Notion: ${e.message}`);
        notionFailCount++;
      }
    }

    await sleep(2000);
  }
  
  saveState(state);
  console.log('\n✓ State saved');
  
  printSummary(slackSuccessCount, slackFailCount, notionSuccessCount, notionFailCount);
}

function printSummary(slackSuccess, slackFail, notionSuccess, notionFail) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 EXECUTION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Slack:  ${slackSuccess} succeeded, ${slackFail} failed`);
  console.log(`Notion: ${notionSuccess} succeeded, ${notionFail} failed`);
  console.log(`Completed: ${new Date().toISOString()}`);
  console.log('='.repeat(60));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
