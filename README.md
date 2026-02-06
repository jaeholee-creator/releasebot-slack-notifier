# Releasebot Slack Notifier

Releasebot.io의 IT/AI/Tech 릴리스 소식을 Slack 채널로 자동 전송합니다.

## 설정 방법

### 1. Slack App 생성 및 Bot Token 발급

1. [Slack API](https://api.slack.com/apps) 접속
2. **Create New App** → **From scratch**
3. App 이름 입력 (예: "Release Notifier"), Workspace 선택
4. 좌측 메뉴 **OAuth & Permissions** 클릭
5. **Scopes** → **Bot Token Scopes**에서 추가:
   - `chat:write` (메시지 전송)
   - `chat:write.public` (public 채널에 초대 없이 전송, 선택사항)
6. 페이지 상단 **Install to Workspace** 클릭
7. **Bot User OAuth Token** 복사 (`xoxb-`로 시작)

### 2. Bot을 채널에 초대

Slack에서 알림 받을 채널로 이동 후:
```
/invite @Release Notifier
```
(또는 App 이름으로 초대)

### 3. GitHub Secrets 설정

이 Repository의 **Settings** → **Secrets and variables** → **Actions**에서:

| Secret Name | Value | 필수 |
|-------------|-------|------|
| `SLACK_BOT_TOKEN` | `xoxb-...` (위에서 복사한 토큰) | ✅ |
| `SLACK_CHANNEL_ID` | `C0ACH02BLG5` (기본값 설정됨) | 선택 |
| `RELEASEBOT_URL` | Releasebot API URL (기본값 설정됨) | 선택 |

### 4. 수동 테스트

1. **Actions** 탭 → **Check Releasebot & Notify Slack**
2. **Run workflow** 클릭
3. Slack 채널에서 메시지 확인

## 실행 주기

기본: **30분마다** 자동 실행

변경하려면 `.github/workflows/notify-releases.yml`의 cron 수정:
```yaml
schedule:
  - cron: '0 * * * *'    # 매시간
  - cron: '*/15 * * * *' # 15분마다
  - cron: '0 9 * * *'    # 매일 오전 9시 (UTC)
```

## 메시지 예시

```
🚀 OpenAI ChatGPT Atlas
━━━━━━━━━━━━━━━━━━━━━
Version: 1.2026.28.6

New release introduces Saved Prompts, a Device Tab 
for DevTools, and tab renaming...

📅 2026년 2월 4일
```

## 문제 해결

### "not_in_channel" 에러
→ Bot을 채널에 초대하세요: `/invite @Release Notifier`

### "invalid_auth" 에러
→ SLACK_BOT_TOKEN이 올바른지 확인하세요

### 메시지가 안 옴
→ Actions 탭에서 workflow 실행 로그 확인
