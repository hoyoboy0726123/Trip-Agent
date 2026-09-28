// 一鍵部署（Windows / Mac / Linux 通用）：登入 Cloudflare → 部署 → 設定邀請碼、後台密碼與金鑰
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(root);

const run = (cmd) => spawnSync(cmd, { shell: true, stdio: "inherit" }).status === 0;
const output = (cmd) => spawnSync(cmd, { shell: true, encoding: "utf8" }).stdout ?? "";
const step = (t) => console.log(`\n▶︎ ${t}`);

console.log("🧳 旅伴 AI 部署精靈");

if (!existsSync("node_modules")) {
  step("安裝套件…");
  if (!run("npm install")) process.exit(1);
}

step("登入 Cloudflare（會打開瀏覽器，請按 Allow）");
if (output("npx wrangler whoami").includes("not authenticated")) {
  if (!run("npx wrangler login")) process.exit(1);
}

step("部署到 Cloudflare");
if (!run("npx wrangler deploy")) process.exit(1);

step("設定邀請碼與密碼");
const existing = output("npx wrangler secret list");
const rl = createInterface({ input: process.stdin, output: process.stdout });
const ask = async (q) => (await rl.question(q)).trim();
const secrets = {};
// SESSION_SECRET 也用來加密朋友的 API 金鑰：已經設定過就絕對不要換，不然大家存的金鑰都會解不開
if (!existing.includes("SESSION_SECRET")) secrets.SESSION_SECRET = randomBytes(32).toString("base64url");
const invite = await ask(`🔑 邀請碼（給朋友建立旅程用）${existing.includes("INVITE_CODE") ? "，不改直接 Enter" : ""}：`);
if (invite) secrets.INVITE_CODE = invite;
const owner = await ask(`🛠 擁有者後台密碼（至少 8 個字）${existing.includes("OWNER_PASSWORD") ? "，不改直接 Enter" : ""}：`);
if (owner) secrets.OWNER_PASSWORD = owner;
const gemini = await ask("🤖 你的 Gemini API key（選填，所有旅程優先使用；直接 Enter 跳過）：");
if (gemini) secrets.GEMINI_API_KEY = gemini;
rl.close();

if (Object.keys(secrets).length) {
  // 用 JSON 檔一次設定，避免 Windows 管線把換行字元一起存進去
  const file = join(tmpdir(), `trip-agent-secrets-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(secrets));
  try {
    run(`npx wrangler secret bulk "${file}"`);
  } finally {
    unlinkSync(file);
  }
}

console.log("\n🎉 完成！打開上面部署顯示的網址，把網址和邀請碼給朋友就可以建立旅程。");
console.log("   擁有者後台：<網址>/owner");
