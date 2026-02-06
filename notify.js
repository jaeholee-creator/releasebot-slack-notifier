const https = require('https');
const fs = require('fs');

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL_ID = process.env.SLACK_CHANNEL_ID || 'C0ACH02BLG5';
const RELEASEBOT_URL = process.env.RELEASEBOT_URL || 'https://releasebot.io/api/feed/bc2b4e2a-dad6-4245-a2c7-13a7bd9407d4.json';
const LAST_SEEN_FILE = 'last_seen_id.txt';

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

function formatRelease(release) {
  const product = release.product?.display_name || 'Unknown Product';
  const vendor = release.product?.vendor?.display_name || '';
  const summary = release.release_details?.release_summary || '';
  const version = release.release_details?.release_number || release.release_details?.release_name || '';
  const releaseDate = release.release_date 
    ? new Date(release.release_date).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })
    : '';
  
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
        text: version ? `*Version:* \`${version}\`` : '_No version info_'
      }
    }
  ];
  
  if (summary) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: summary.length > 500 ? summary.substring(0, 500) + '...' : summary
      }
    });
  }
  
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
    text: `${vendor ? vendor + ' ' : ''}${product} ${version} released`
  };
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  if (!SLACK_BOT_TOKEN) {
    console.error('Error: SLACK_BOT_TOKEN environment variable is required');
    process.exit(1);
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
  
  console.log(`New releases to notify: ${newReleases.length}`);
  
  if (newReleases.length === 0) {
    console.log('No new releases found');
    return;
  }
  
  // Post to Slack
  for (const release of newReleases) {
    const { blocks, text } = formatRelease(release);
    const productName = release.product?.display_name || 'Unknown';
    const version = release.release_details?.release_number || '';
    
    console.log(`Posting: ${productName} ${version}`);
    
    try {
      await postToSlack(SLACK_CHANNEL_ID, blocks, text);
      lastSeenId = release.id;
      console.log(`  ✓ Posted successfully (ID: ${release.id})`);
    } catch (error) {
      console.error(`  ✗ Failed to post: ${error.message}`);
      // Continue with next release
    }
    
    // Rate limiting: wait 1 second between messages
    await sleep(1000);
  }
  
  // Save last seen ID
  fs.writeFileSync(LAST_SEEN_FILE, lastSeenId.toString());
  console.log(`\nSaved last seen ID: ${lastSeenId}`);
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
