const https = require('https');
const http = require('http');
const fs = require('fs');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C0ACH02BLG5';
const RELEASEBOT_URL = process.env.RELEASEBOT_URL || 'https://releasebot.io/api/feed/bc2b4e2a-dad6-4245-a2c7-13a7bd9407d4.json';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const STATE_FILE = 'feed_state.json';
const FEEDS_FILE = 'feeds.json';
const USER_ENV_FILE = 'user_environment.json';
// Notion 통합 발행용 큐 파일 (ai_trend_collector가 09:00에 읽어서 통합 발행)
const NOTION_QUEUE_FILE = 'notion_queue.json';

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

// ============ Notion Queue ============

/**
 * 처리된 아이템을 notion_queue.json에 누적 저장.
 * ai_trend_collector가 오전 9시 실행 시 큐를 읽어 통합 발행.
 */
function appendToNotionQueue(newItems) {
  let existing = { items: [] };
  try {
    if (fs.existsSync(NOTION_QUEUE_FILE)) {
      const content = fs.readFileSync(NOTION_QUEUE_FILE, 'utf8');
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed.items)) {
        existing = parsed;
      }
    }
  } catch (e) {
    console.warn(`  ⚠️ Queue file read failed: ${e.message}`);
  }

  existing.items = [...existing.items, ...newItems];
  existing.updated_at = new Date().toISOString();

  fs.writeFileSync(NOTION_QUEUE_FILE, JSON.stringify(existing, null, 2));
  console.log(`  ✓ Notion Queue: ${newItems.length}개 추가 (누적 ${existing.items.length}개)`);
}

// ============ Claude API ============

async function callClaude(prompt) {
  if (!ANTHROPIC_API_KEY) {
    return null;
  }

  return new Promise((resolve) => {
    const payload = JSON.stringify({
      model: 'claude-3-haiku-20240307',  // Claude 3 Haiku (가장 저렴: $0.25/$1.25 per MTok)
      max_tokens: 1500,  // 800에서 1500으로 증가 (환경 비교 분석)
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

  // MCP 서버 상세 정보
  const mcpDetails = Object.entries(userEnv.mcp_servers || {})
    .map(([name, info]) => `  - ${name}: ${info.description} (도구: ${(info.tools || []).join(', ')})`)
    .join('\n');

  // 스킬 상세 정보
  const skillDetails = Object.entries(userEnv.skills || {})
    .map(([name, desc]) => `  - ${name}: ${desc}`)
    .join('\n');

  // AI 모델 사용 현황
  const aiModels = Object.entries(userEnv.ai_models_used || {})
    .map(([name, info]) => `  - ${name}: ${info.usage}`)
    .join('\n');

  // 활성 프로젝트 상세
  const activeProjectDetails = Object.entries(userEnv.active_projects || {})
    .map(([name, info]) => `  - ${name}: ${info.description}\n    스택: ${(info.tech_stack || []).join(', ')}\n    연동: ${(info.integrations || []).join(', ')}`)
    .join('\n');

  const prompt = `당신은 소프트웨어 릴리스 분석 전문가입니다.
새로운 릴리스가 사용자의 **구체적인 개발 환경**에 어떤 영향을 미치는지 분석해주세요.

## 사용자 개발 환경 (상세)

### CLI 도구
- ${userEnv.cli_tool?.name || 'Unknown'} (${userEnv.cli_tool?.vendor || ''}, 모델: ${userEnv.cli_tool?.model || 'Unknown'})

### MCP 서버 (연동 도구)
${mcpDetails || '  없음'}

### 스킬 (자동화)
${skillDetails || '  없음'}

### AI 모델
${aiModels || '  없음'}

### 기술 스택
${(userEnv.technology_stack || []).join(', ')}

### 활성 프로젝트
${activeProjectDetails || '  없음'}

## 새로운 릴리스
**벤더:** ${vendor}
**제목:** ${title}
**내용:**
${summary.substring(0, 1200)}

## 분석 요청

다음 형식으로 **한국어**로 응답하세요.
반드시 사용자의 구체적 도구/서버명을 언급하세요.

**📊 관련도:** [🔴 매우 높음 / 🟡 보통 / 🟢 낮음 / ⚪ 무관]

**💡 핵심:** (이 릴리스의 핵심 내용을 1-2문장으로)

**🔍 환경 비교:**
- **현재:** 사용자가 현재 사용 중인 관련 도구/기술 (구체적 이름)
- **차이:** 이 릴리스와 현재 환경의 주요 차이점
- **시너지:** 사용자의 MCP 서버, 스킬, 프로젝트와의 시너지 가능성
  (예: "Playwright MCP와 함께 사용하면 브라우저 테스트 자동화 강화 가능")
  (예: "Context7 MCP로 이 기술의 최신 문서를 즉시 검색 가능")

**🎯 액션:** [즉시 적용 📥 / 검토 필요 🔍 / 참고만 📌 / 해당 없음 ➖]
- 구체적 다음 단계 1-2개

---
전체 응답은 500자 이내로 작성하세요.
무관한 릴리스는 간단히 "이 릴리스는 [간단 설명]이며, 현재 환경과 직접적 관련은 없습니다."로 응답하세요.`;

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

// ============ Translation ============

function translateToKorean(text) {
  if (!DEEPL_API_KEY || !text) {
    if (!DEEPL_API_KEY && text) {
      console.warn('  ⚠️ Translation skipped: DEEPL_API_KEY not set');
    }
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
            const translated = result.translations[0].text;
            console.log(`  ✓ Translation: ${text.length} chars -> ${translated.length} chars`);
            resolve(translated);
          } else {
            console.warn(`  ⚠️ Translation failed: unexpected response`);
            resolve(text);
          }
        } catch (e) {
          console.warn(`  ⚠️ Translation parse error: ${e.message}`);
          resolve(text);
        }
      });
    });

    req.on('error', (e) => {
      console.warn(`  ⚠️ Translation network error: ${e.message}`);
      resolve(text);
    });

    req.setTimeout(10000, () => {
      console.warn('  ⚠️ Translation timeout (10s)');
      req.destroy();
      resolve(text);
    });

    req.write(postData);
    req.end();
  });
}

// Claude API를 사용한 fallback 번역
async function translateWithClaude(text) {
  if (!ANTHROPIC_API_KEY || !text) {
    return text;
  }

  const prompt = `다음 영문 텍스트를 한국어로 번역하세요. 번역만 출력하세요.\n\n${text.substring(0, 1000)}`;

  try {
    const result = await callClaude(prompt);
    if (result && result.length > 0) {
      console.log(`  ✓ Claude translation: ${text.length} chars -> ${result.length} chars`);
      return result;
    }
    return text;
  } catch (e) {
    console.warn(`  ⚠️ Claude translation failed: ${e.message}`);
    return text;
  }
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
  console.log(`  NOTION_API_TOKEN: ${NOTION_API_TOKEN ? 'set (queue mode)' : 'NOT SET'}`);
  console.log(`  ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY ? 'set' : 'NOT SET'}`);
  console.log(`  → Notion은 직접 쓰지 않고 ${NOTION_QUEUE_FILE}에 큐잉 후 ai_trend_collector가 09:00에 통합 발행`);
  
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

  let slackSuccessCount = 0;
  let slackFailCount = 0;
  const notionQueue = [];

  for (const item of allItems) {
    const isRss = item.feedType === 'rss';
    const itemName = isRss ? item.title.substring(0, 50) : (item.product?.display_name || 'Unknown');

    console.log(`\nProcessing: ${itemName}...`);

    const summary = isRss ? item.summary : (item.release_details?.release_summary || '');
    let translatedSummary = summary;

    if (summary) {
      // 1. DeepL 번역 시도
      if (DEEPL_API_KEY) {
        console.log('  📝 Translating with DeepL...');
        translatedSummary = await translateToKorean(summary.substring(0, 1500));
      }

      // 2. DeepL 실패 또는 없으면 Claude fallback
      if (translatedSummary === summary && ANTHROPIC_API_KEY) {
        console.log('  📝 Trying Claude translation as fallback...');
        translatedSummary = await translateWithClaude(summary.substring(0, 1000));
      }
    }

    // 환경 분석
    let analysis = null;
    if (userEnv && ANTHROPIC_API_KEY) {
      console.log('  📊 Analyzing relevance...');
      analysis = await analyzeRelevanceToEnvironment(item, userEnv);
    }

    // Slack 알림 (실시간 유지)
    try {
      const { blocks, text } = formatSlackMessage(item, translatedSummary, analysis);
      await postToSlack(SLACK_CHANNEL_ID, blocks, text);
      console.log('  ✓ Slack: Posted');
      slackSuccessCount++;
    } catch (e) {
      console.error(`  ✗ Slack: ${e.message}`);
      slackFailCount++;
    }

    // Notion 큐에 추가 (ai_trend_collector가 09:00에 통합 발행)
    const title = isRss
      ? item.title
      : (item.release_details?.release_name || item.product?.display_name || 'Unknown');
    const vendor = isRss
      ? (item.vendor || '')
      : (item.product?.vendor?.display_name || '');
    const url = isRss
      ? item.link
      : `https://releasebot.io/updates/${item.product?.vendor?.slug || ''}`;
    const releaseDate = isRss
      ? (item.pubDate instanceof Date ? item.pubDate.toISOString() : '')
      : (item.release_date || '');

    notionQueue.push({
      title,
      vendor,
      url,
      summary_ko: translatedSummary || summary || '',
      analysis_text: analysis || '',
      source: isRss ? 'rss' : 'releasebot',
      source_name: isRss ? (item.source || '') : 'Releasebot',
      release_date: releaseDate,
      processed_at: new Date().toISOString()
    });
    console.log('  ✓ Queue: Enqueued for Notion');

    await sleep(2000);
  }
  
  saveState(state);
  console.log('\n✓ State saved');

  // Notion 큐 파일에 저장
  if (notionQueue.length > 0) {
    appendToNotionQueue(notionQueue);
  }
  
  printSummary(slackSuccessCount, slackFailCount, notionQueue.length, 0);
}

function printSummary(slackSuccess, slackFail, notionQueued, _unused) {
  console.log('\n' + '='.repeat(60));
  console.log('📊 EXECUTION SUMMARY');
  console.log('='.repeat(60));
  console.log(`Slack:        ${slackSuccess} succeeded, ${slackFail} failed`);
  console.log(`Notion Queue: ${notionQueued} items enqueued (published at 09:00 by ai_trend_collector)`);
  console.log(`Completed: ${new Date().toISOString()}`);
  console.log('='.repeat(60));
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
