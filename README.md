# 🧳 旅伴 AI Trip Agent

家族旅行的 **AI 群聊助理**，一站式部署在 Cloudflare，**任何國家都能用**。

分享一個網址給朋友：每組朋友用邀請碼建立自己的「旅程」，引導設置會一步步填目的地、日期、住宿、旅伴、密碼，AI 再自動查好當地的時區、貨幣、語言、入境規定、退稅、插座、常用語，確認後就能開始用。每個旅程的資料完全分開。

## 功能

- 💬 **即時群聊**：全家用同一組密碼登入，AI 回答即時逐字出現在每個人的手機上
- 🧠 **長期記憶**：聊天永久保存，AI 自動記住偏好、決定、預訂，也會回想以前聊過的事
- 🌏 **翻譯**：中文 ↔ 當地語言，常用句、語音輸入、念給對方聽、全螢幕給對方看
- 🗺 **找附近、路線、計程車估價**（OpenStreetMap、依當地費率）
- 💰 **記帳分帳**：當地貨幣記帳、換算台幣，拍收據就能記，算出最少轉帳的結算方式
- 🔍 **網路搜尋、找圖片**（Tavily）、天氣（Open-Meteo）、匯率、全球樂園排隊（Queue-Times）
- 🆘 **災害警報**：全球地震（USGS）、颱風／洪水／火山（GDACS）、強風豪雨，主動通知
- ⏰ 提醒、☀️ 每日早報、📔 旅遊日記與相簿、✅ 共用清單、🎫 票券保管箱（離線可看）、📍 家人位置地圖與走散求救
- 🚆 目的地是日本時，另外提供電車即時運行資訊

## AI 額度怎麼算

每個旅程依序使用：

1. 擁有者提供的 Gemini 金鑰（選填，`GEMINI_API_KEY`）
2. Cloudflare Workers AI 免費額度（整個帳號每天 10,000 neurons，台灣時間早上 8 點重置）
3. 旅程自己填的 Gemini 金鑰（引導設置選填，額度用完時才用）

網路搜尋一律用**旅程自己的 Tavily 金鑰**（引導設置必填，免費每月 1,000 次）。朋友的金鑰用 AES-GCM 加密保存，不會回傳給手機。

## 架構

```
手機瀏覽器（PWA，可加到主畫面）
   │ WebSocket
   ▼
Cloudflare Worker ── 靜態網頁、登入（HMAC 簽章 Cookie）、建立旅程
   │
   ├─ Durable Object「Registry」（全站一個）：邀請碼、旅程清單、共用額度冷卻
   └─ Durable Object「TripRoom」（每個旅程一個，SQLite）
        ├─ 群聊廣播（Hibernation WebSocket）
        ├─ 資料：旅程設定、聊天、照片、行程、記憶、帳目、位置、清單、票券
        ├─ AI 初始化（查當地資料）與排程（提醒、早報、日記、警報）
        └─ Agent：Gemini / Workers AI + 29 個工具
```

## 部署

需要：Node.js 20 以上、Cloudflare 帳號（免費）。

```bash
npm install
npm run setup
```

`setup` 會登入 Cloudflare、部署，並設定這些 Secrets：

| 名稱 | 說明 |
| --- | --- |
| `SESSION_SECRET` | 自動產生。簽登入 Cookie 與加密朋友的金鑰，**設定後不要更換**（換了大家要重新登入、已存的金鑰要重填） |
| `INVITE_CODE` | 建立新旅程要輸入的邀請碼 |
| `OWNER_PASSWORD` | 擁有者後台（`/owner`）密碼：看所有旅程、刪除旅程 |
| `GEMINI_API_KEY` | 選填，你的 Gemini 金鑰（https://aistudio.google.com/apikey） |

`wrangler.jsonc` 裡的 `account_id` 決定部署到哪個 Cloudflare 帳號（Workers AI 額度以帳號計算）。

### 更新程式

```bash
npm run deploy
```

資料存在 Durable Object，重新部署不會消失。

## 本機開發

```bash
cp .dev.vars.example .dev.vars   # 填入測試用的值
npm run dev                      # http://localhost:8787
```

## 專案結構

```
src/
  index.ts       路由：建立旅程、登入、轉交旅程房間、擁有者後台 API
  auth.ts        簽章 Cookie、密碼雜湊（PBKDF2）、金鑰加密（AES-GCM）
  registry.ts    Registry：邀請碼、旅程清單、共用額度
  room.ts        TripRoom：群聊、資料庫、Agent 迴圈、排程、長期記憶
  init.ts        建立旅程後的 AI 初始化（查當地資料、常用語、行李清單）
  profile.ts     旅程設定格式、時區換算
  providers.ts   Gemini（串流＋工具呼叫）與 Workers AI 轉接
  tools.ts       工具（搜尋、天氣、附近、記帳、災害警報…）
  translate.ts   中文 ↔ 當地語言翻譯
public/
  common.js      共用（當地時間、金額、API）
  onboard.js     首頁、引導設置、登入、初始化進度、確認頁
  app.js         聊天室、面板、工具箱、翻譯
  owner.html     擁有者後台（網址 /owner）
scripts/setup.mjs 一鍵部署
```
