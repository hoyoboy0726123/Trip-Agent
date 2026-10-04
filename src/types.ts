export interface Env {
  /** 每次部署不同的版本號（前端用來發現新版） */
  CF_VERSION?: WorkerVersionMetadata;
  ASSETS: Fetcher;
  AI: Ai;
  ROOM: DurableObjectNamespace<import("./room").TripRoom>;
  REGISTRY: DurableObjectNamespace<import("./registry").Registry>;
  /** 簽 cookie、圖片網址與加密朋友的 API 金鑰都用它；改掉 = 所有人重新登入、已存的金鑰要重填 */
  SESSION_SECRET: string;
  /** 建立新旅程要輸入的邀請碼 */
  INVITE_CODE: string;
  /** 擁有者後台（看所有旅程、刪除旅程） */
  OWNER_PASSWORD?: string;
  /** 擁有者的 Gemini 金鑰（選填）：所有旅程優先使用，用完才用朋友自己填的 */
  GEMINI_API_KEY?: string;
  GEMINI_MODEL: string;
  /** 寫旅遊日記用的模型（比較會寫長文、照格式；一天一篇，額度跟聊天分開） */
  GEMINI_WRITER_MODEL?: string;
  GEMINI_RPM?: string;
  GEMINI_TPM?: string;
  GEMINI_RPD?: string;
  WORKERS_AI_MODEL: string;
}

export interface SessionUser {
  room: string;
  name: string;
  admin: boolean;
  /** 密碼版本：管理員改密碼後，舊的登入全部失效 */
  ver: number;
}

// ---- 與模型無關的對話格式 ----

export type Part =
  | { text: string }
  | { image: { mime: string; data: string } }
  | { call: { id: string; name: string; args: Record<string, unknown>; sig?: string } }
  | { result: { id: string; name: string; response: unknown } };

export interface Turn {
  role: "user" | "model";
  parts: Part[];
}

export interface ToolDecl {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateResult {
  text: string;
  calls: { id: string; name: string; args: Record<string, unknown>; sig?: string }[];
}

export type ProviderId = "gemini" | "workers-ai" | "gemini-own";

export interface Provider {
  id: ProviderId;
  model: string;
  generate(opts: {
    system: string;
    turns: Turn[];
    tools?: ToolDecl[];
    onDelta?: (text: string) => void;
    json?: boolean;
    /** 最多輸出幾個 token（目前只有 Workers AI 需要，預設 2048） */
    maxTokens?: number;
    /** Gemini 整段回應的時限（預設 45 秒；寫長文的模型要久一點） */
    timeoutMs?: number;
  }): Promise<GenerateResult>;
}
