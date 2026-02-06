const https = require('https');
const fs = require('fs');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C0ACH02BLG5';
const RELEASEBOT_URL = process.env.RELEASEBOT_URL || 'https://releasebot.io/api/feed/bc2b4e2a-dad6-4245-a2c7-13a7bd9407d4.json';
const DEEPL_API_KEY = process.env.DEEPL_API_KEY;
const NOTION_API_TOKEN = process.env.NOTION_API_TOKEN;
const NOTION_PAGE_ID = process.env.NOTION_PAGE_ID || '2ff686b49b3b80ef9502d23028ca574f';
const LAST_SEEN_FILE = 'last_seen_id.txt';
const NOTION_DB_FILE = 'notion_db_id.txt';

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Failed to parse JSON: ${e.message}`));
        }
      });
    }).on('error', reject);
  });
}

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
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function getOrCreateNotionDatabase() {
  // Check if we have a stored database ID
  let dbId = null;
  try {
    dbId = fs.readFileSync(NOTION_DB_FILE, 'utf8').trim();
    if (dbId) {
      console.log(`  → Using existing Notion database: ${dbId}`);
      // Verify database still exists
      try {
        await notionRequest('GET', `/v1/databases/${dbId}`);
        return dbId;
      } catch (e) {
        console.log(`  → Database not found, creating new one...`);
        dbId = null;
      }
    }
  } catch (e) {
    // No stored DB ID
  }
  
  // Create new database
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
      'URL': { url: {} }
    }
  };
  
  const result = await notionRequest('POST', '/v1/databases', dbPayload);
  dbId = result.id;
  
  // Save database ID
  fs.writeFileSync(NOTION_DB_FILE, dbId);
  console.log(`  ✓ Created Notion database: ${dbId}`);
  
  return dbId;
}

async function addToNotion(dbId, release, translatedSummary) {
  const product = release.product?.display_name || 'Unknown Product';
  const vendor = release.product?.vendor?.display_name || '';
  const vendorSlug = release.product?.vendor?.slug || '';
  const version = release.release_details?.release_number || release.release_details?.release_name || '';
  const releaseDate = release.release_date || release.created_at;
  const releasebotUrl = vendorSlug 
    ? `https://releasebot.io/updates/${vendorSlug}`
    : 'https://releasebot.io/updates';
  
  const pagePayload = {
    parent: { database_id: dbId },
    properties: {
      '제품명': {
        title: [{ text: { content: product } }]
      },
      '버전': {
        rich_text: [{ text: { content: version || '-' } }]
      },
      '벤더': {
        select: { name: vendor || 'Unknown' }
      },
      '요약': {
        rich_text: [{ 
          text: { 
            content: (translatedSummary || '').substring(0, 2000) 
          } 
        }]
      },
      '날짜': {
        date: releaseDate ? { start: releaseDate.split('T')[0] } : null
      },
      'URL': {
        url: releasebotUrl
      }
    }
  };
  
  await notionRequest('POST', '/v1/pages', pagePayload);
}

function translateToKorean(text) {
  if (!DEEPL_API_KEY) {
    console.log('    ⚠ DEEPL_API_KEY not set, skipping translation');
    return Promise.resolve(text);
  }
  
  if (!text) {
    return Promise.resolve(text);
  }
  
  console.log(`    → Calling DeepL API (text length: ${text.length})`);
  
  return new Promise((resolve) => {
    // New DeepL API format: header-based authentication
    const postData = JSON.stringify({
      text: [text],
      target_lang: 'KO'
    });
    
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
        console.log(`    → DeepL response status: ${res.statusCode}`);
        try {
          const result = JSON.parse(data);
          if (result.translations && result.translations[0]) {
            console.log(`    ✓ Translation successful`);
            resolve(result.translations[0].text);
          } else {
            console.warn(`    ⚠ Translation failed: ${JSON.stringify(result)}`);
            resolve(text);
          }
        } catch (e) {
          console.warn(`    ⚠ Translation parse error: ${e.message}, response: ${data.substring(0, 200)}`);
          resolve(text);
        }
      });
    });
    
    req.on('error', (e) => {
      console.warn(`    ⚠ Translation request error: ${e.message}`);
      resolve(text);
    });
    
    req.write(postData);
    req.end();
  });
}

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
          if (result.ok) {
            resolve(result);
          } else {
            reject(new Error(`Slack API error: ${result.error}`));
          }
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

async function formatRelease(release, translatedSummary) {
  const product = release.product?.display_name || 'Unknown Product';
  const vendor = release.product?.vendor?.display_name || '';
  const vendorSlug = release.product?.vendor?.slug || '';
  const version = release.release_details?.release_number || release.release_details?.release_name || '';
  const releaseDate = release.release_date 
    ? new Date(release.release_date).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  
  // Build URL to Releasebot page
  const releasebotUrl = vendorSlug 
    ? `https://releasebot.io/updates/${vendorSlug}`
    : 'https://releasebot.io/updates';
  
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `🚀 ${vendor ? vendor + ' ' : ''}${product}`,
        emoji: true
      }
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: version ? `*버전:* \`${version}\`` : '_버전 정보 없음_'
      }
    }
  ];
  
  if (translatedSummary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: translatedSummary.length > 500 ? translatedSummary.substring(0, 500) + '...' : translatedSummary
      }
    });
  }
  
  // Add "View Details" button
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: {
          type: 'plain_text',
          text: '📖 자세히 보기',
          emoji: true
        },
        url: releasebotUrl,
        action_id: 'view_release'
      }
    ]
  });
  
  if (releaseDate) {
    blocks.push({
      type: 'context',
      elements: [{
        type: 'mrkdwn',
        text: `📅 ${releaseDate}`
      }]
    });
  }
  
  blocks.push({ type: 'divider' });
  
  return {
    blocks,
    text: `${vendor ? vendor + ' ' : ''}${product} ${version} 릴리스`
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  console.log('=== Releasebot Slack & Notion Notifier ===\n');
  
  if (!SLACK_BOT_TOKEN) {
    console.error('❌ Error: SLACK_BOT_TOKEN environment variable is required');
    process.exit(1);
  }
  
  console.log(`✓ SLACK_BOT_TOKEN: set`);
  console.log(`✓ SLACK_CHANNEL_ID: ${SLACK_CHANNEL_ID}`);
  console.log(`✓ DEEPL_API_KEY: ${DEEPL_API_KEY ? 'set (' + DEEPL_API_KEY.substring(0, 8) + '...)' : 'NOT SET'}`);
  console.log(`✓ NOTION_API_TOKEN: ${NOTION_API_TOKEN ? 'set' : 'NOT SET'}`);
  console.log(`✓ NOTION_PAGE_ID: ${NOTION_PAGE_ID}`);
  console.log('');
  
  // Initialize Notion database if token is set
  let notionDbId = null;
  if (NOTION_API_TOKEN) {
    try {
      notionDbId = await getOrCreateNotionDatabase();
      console.log(`✓ Notion database ready: ${notionDbId}\n`);
    } catch (e) {
      console.error(`⚠ Notion setup failed: ${e.message}`);
      console.log('  Continuing with Slack only...\n');
    }
  }
  
  // Load last seen ID
  let lastSeenId = 0;
  try {
    const content = fs.readFileSync(LAST_SEEN_FILE, 'utf8').trim();
    lastSeenId = parseInt(content, 10) || 0;
  } catch (e) {
    console.log('No previous state found, starting fresh');
  }
  
  console.log(`Last seen ID: ${lastSeenId}`);
  
  // Fetch releases from Releasebot
  console.log('Fetching releases from Releasebot...');
  const data = await fetch(RELEASEBOT_URL);
  const releases = data.releases || [];
  
  console.log(`Total releases in feed: ${releases.length}`);
  
  // Filter new releases
  const newReleases = releases
    .filter(r => r.id > lastSeenId)
    .sort((a, b) => a.id - b.id); // Oldest first
  
  console.log(`New releases to notify: ${newReleases.length}\n`);
  
  if (newReleases.length === 0) {
    console.log('No new releases found');
    return;
  }
  
  // Post to Slack and Notion
  for (const release of newReleases) {
    const productName = release.product?.display_name || 'Unknown';
    const version = release.release_details?.release_number || '';
    const summary = release.release_details?.release_summary || '';
    
    console.log(`Processing: ${productName} ${version}`);
    
    // Translate summary once, use for both Slack and Notion
    let translatedSummary = summary;
    if (summary) {
      console.log('  📝 Translating summary to Korean...');
      translatedSummary = await translateToKorean(summary);
    }
    
    // Post to Slack
    try {
      const { blocks, text } = await formatRelease(release, translatedSummary);
      await postToSlack(SLACK_CHANNEL_ID, blocks, text);
      console.log(`  ✓ Slack: Posted successfully`);
    } catch (error) {
      console.error(`  ✗ Slack: Failed - ${error.message}`);
    }
    
    // Add to Notion
    if (notionDbId) {
      try {
        await addToNotion(notionDbId, release, translatedSummary);
        console.log(`  ✓ Notion: Added to database`);
      } catch (error) {
        console.error(`  ✗ Notion: Failed - ${error.message}`);
      }
    }
    
    lastSeenId = release.id;
    console.log(`  → Updated last seen ID: ${release.id}\n`);
    
    // Rate limiting: wait 1.5 seconds between messages
    await sleep(1500);
  }
  
  // Save last seen ID
  fs.writeFileSync(LAST_SEEN_FILE, lastSeenId.toString());
  console.log(`Saved last seen ID: ${lastSeenId}`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
