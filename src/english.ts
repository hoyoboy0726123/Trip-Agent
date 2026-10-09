/**
 * AI 英語家教（個人助理，只給大人用：Gemini API 條款要求使用者滿 18 歲）：
 * 情境角色扮演、錄一句話給回饋、今日一課、錯句複習卡、連續天數。
 * 這裡放情境、程度、提示詞與複習排程；資料在 english-store.ts，AI 呼叫在 room.ts 的 englishApi。
 * 練習對話不寫進聊天紀錄：不會進長期記憶，也不會因為講到「看醫生」被當成健康話題。
 */

export type EnLevel = "beginner" | "intermediate" | "advanced";

export const LEVELS: Record<EnLevel, { zh: string; desc: string; reply: string }> = {
  beginner: { zh: "初級", desc: "初級（常用字、短句，聽不懂時要放慢、換簡單的說法）", reply: "回覆 1–2 句、每句 12 個字以內，用常用字" },
  intermediate: { zh: "中級", desc: "中級（日常對話沒問題，想說得更自然）", reply: "回覆 1–3 句，用日常口語" },
  advanced: { zh: "進階", desc: "進階（想學道地說法、片語、語氣）", reply: "回覆 2–4 句，自然地用片語和道地說法" },
};
export const levelOf = (v: unknown): EnLevel => (v === "beginner" || v === "advanced" ? v : "intermediate");

export interface Scenario {
  id: string;
  icon: string;
  title: string;
  /** 學習者扮演誰 */
  you: string;
  /** AI 扮演誰 */
  tutor: string;
  /** 這場要完成的任務（Speak 的做法：有目標才不會變成漫無目的的閒聊） */
  goals: string[];
  /** 第一句（不用 AI 產生，省一次額度） */
  opener: string;
  /** 即時語音對話時 AI 的聲音（Gemini 預設聲音） */
  voice: string;
}

export const SCENARIOS: Scenario[] = [
  { id: "cafe", icon: "☕", title: "咖啡店點餐", you: "客人", tutor: "咖啡店店員 Emma", voice: "Kore", goals: ["點一杯飲料和一樣點心", "問有沒有不含乳製品的選擇", "付款並說要內用還是外帶"], opener: "Hi there! What can I get for you today?" },
  { id: "restaurant", icon: "🍝", title: "餐廳用餐", you: "客人", tutor: "服務生 Daniel", voice: "Puck", goals: ["說幾位、有沒有訂位", "問推薦的餐點並點餐", "請服務生結帳"], opener: "Good evening! Welcome in. Do you have a reservation?" },
  { id: "directions", icon: "🗺️", title: "問路", you: "觀光客", tutor: "熱心的路人 Sarah", voice: "Kore", goals: ["問怎麼去最近的地鐵站", "確認要走多久", "道謝並問附近有沒有便利商店"], opener: "Hi! You look a little lost. Can I help you find something?" },
  { id: "hotel", icon: "🏨", title: "飯店入住", you: "房客", tutor: "飯店櫃台 Michael", voice: "Puck", goals: ["報名字辦理入住", "問早餐時間和 Wi-Fi 密碼", "請他們幫忙寄放行李"], opener: "Welcome to the Harbor Hotel. Are you checking in today?" },
  { id: "airport", icon: "✈️", title: "機場報到", you: "旅客", tutor: "航空公司地勤 Lisa", voice: "Kore", goals: ["辦理報到、托運一件行李", "要求靠窗的位子", "問登機門和登機時間"], opener: "Good morning. Where are you flying to today? May I see your passport, please?" },
  { id: "shopping", icon: "🛍️", title: "逛街購物", you: "客人", tutor: "服飾店店員 Chloe", voice: "Kore", goals: ["問有沒有別的尺寸或顏色", "問可不可以試穿", "問能不能退稅或之後退換"], opener: "Hi, welcome in! Are you looking for anything in particular?" },
  { id: "doctor", icon: "🩺", title: "看醫生", you: "病人", tutor: "診所醫生 Dr. Brown", voice: "Charon", goals: ["說明哪裡不舒服、多久了", "回答醫生的問題（過敏、正在吃的藥）", "問藥怎麼吃、要不要回診"], opener: "Hello, I'm Dr. Brown. What brings you in today?" },
  { id: "smalltalk", icon: "💬", title: "跟新朋友閒聊", you: "你自己", tutor: "在聚會上認識的 Alex", voice: "Puck", goals: ["自我介紹（做什麼、從哪裡來）", "聊一個興趣並反問對方", "約下次見面或交換聯絡方式"], opener: "Hey! I don't think we've met. I'm Alex, nice to meet you." },
  { id: "meeting", icon: "💼", title: "工作會議", you: "團隊成員", tutor: "同事 Priya", voice: "Kore", goals: ["簡單報告自己的工作進度", "提出一個問題或需要的協助", "確認下一步和截止日"], opener: "Morning! Shall we start with a quick update from you?" },
  { id: "phone", icon: "📞", title: "打電話訂位", you: "打電話的人", tutor: "餐廳接電話的 Tom", voice: "Puck", goals: ["訂位：日期、時間、人數", "問有沒有包廂或靠窗的位子", "留下名字和電話"], opener: "Thank you for calling Bella Cucina. How can I help you?" },
];
export const scenarioOf = (id: unknown) => SCENARIOS.find((s) => s.id === id);

/** 今日一課的主題（每天輪一個，也可以自己選） */
export const TOPICS = ["旅遊", "餐廳點餐", "購物", "工作", "閒聊交朋友", "交通", "看醫生", "電話與預約", "表達意見", "日常生活"];

/** 間隔複習：答對就拉長到第 1、3、7、14、30、60 天後 */
export const SRS_STEPS = [1, 3, 7, 14, 30, 60];
export type Grade = "good" | "hard" | "again";

/** 複習完排下一次：記得 → 下一個間隔；模糊 → 同一個間隔的一半；忘了 → 明天從頭 */
export function nextReview(step: number, grade: Grade): { step: number; days: number } {
  const s = Math.min(Math.max(step, 0), SRS_STEPS.length - 1);
  if (grade === "good") return { step: Math.min(s + 1, SRS_STEPS.length - 1), days: SRS_STEPS[s] };
  if (grade === "hard") return { step: s, days: Math.max(1, Math.ceil(SRS_STEPS[s] / 2)) };
  return { step: 0, days: 1 };
}

export interface Turn {
  role: "tutor" | "user";
  text: string;
}
const transcript = (turns: Turn[]) => turns.slice(-16).map((t) => `${t.role === "tutor" ? "Tutor" : "Learner"}: ${t.text}`).join("\n");
const goalsText = (s: Scenario) => s.goals.map((g, i) => `${i}. ${g}`).join("\n");

/** 角色扮演的一輪：留在角色裡回應，挑一個最重要的錯給更自然的說法，記下完成了哪些任務 */
export function rolePrompt(s: Scenario, level: EnLevel, turns: Turn[], said: string, audio: boolean): string {
  return `你是英語口說家教，正在跟一位台灣的成人學習者做情境角色扮演。
情境：${s.title}。你扮演：${s.tutor}；學習者扮演：${s.you}。
學習者這場的任務：
${goalsText(s)}
程度：${LEVELS[level].desc}。

規則：
- reply：用英文、留在角色裡自然回應，引導學習者把任務做完；${LEVELS[level].reply}；一次只問一個問題。學習者說中文或卡住時，用簡單的英文接話。
- correction：學習者這句如果有文法錯、用字不自然或中英夾雜，只挑最重要的一個，給 {"you":"他說的原句","better":"更自然的說法","zh":"這句的中文意思","why":"繁體中文一句話說明為什麼"}；沒問題就給 null。不要挑剔已經自然的說法。
- goals_done：到這句為止已經完成的任務編號（累計），例如 [0, 1]。
- hint_zh：學習者卡住、說中文或答非所問時，用繁體中文提示下一句可以怎麼說，附一句英文例句；其他時候給空字串。
${audio ? `- heard：照實寫出你聽到學習者說的英文，包含文法錯誤和漏字，不要自動修正。
- pronunciation：只寫真的聽得出來的「發音」問題（音發錯、重音放錯），最多 2 個：[{"word":"單字","tip":"繁體中文，具體說怎麼發"}]；文法、用字問題放在 correction，不要放這裡；發音清楚就給空陣列，不要編造。` : ""}
只輸出 JSON：{${audio ? '"heard":"...",' : ""}"reply":"...","correction":null,"goals_done":[],"hint_zh":""${audio ? ',"pronunciation":[]' : ""}}

到目前的對話：
${transcript(turns)}
${audio ? "學習者剛剛說的話在音檔裡。" : `Learner（剛剛說的）: ${said}`}`;
}

/** 即時語音對話（Gemini Live）的角色設定：語音裡不能給文字回饋，說錯時用正確的說法自然地重說一遍 */
export function livePrompt(s: Scenario, level: EnLevel): string {
  return `你是「${s.tutor}」，正在跟一位台灣的成人英語學習者做情境角色扮演（語音對話）。
情境：${s.title}。學習者扮演：${s.you}。
學習者這場要完成的任務：
${goalsText(s)}
程度：${LEVELS[level].desc}。

規則：
- 全程用英文說話，留在角色裡；${LEVELS[level].reply}；一次只問一個問題；說話清楚，速度比平常稍慢一點。
- 對話一開始，先說你的第一句：「${s.opener}」
- 學習者說錯時不要停下來上課，用正確的說法自然地把他的意思說一遍（例如他說 "I want to drinking here"，你說 "Sure, you'd like to drink here."）。
- 學習者說中文、卡住或聽不懂時，放慢、換更簡單的說法，或給一句可以照著說的英文："You can say: ..."
- 引導學習者把任務做完；任務都完成後，禮貌地結束對話。`;
}

/** 卡住時的提示：下一句可以怎麼說 */
export function hintPrompt(s: Scenario, level: EnLevel, turns: Turn[], goalsDone: number[]): string {
  const left = s.goals.map((g, i) => (goalsDone.includes(i) ? "" : `${i}. ${g}`)).filter(Boolean).join("\n") || "（任務都完成了，可以自然地結束對話）";
  return `你是英語口說家教。學習者在情境「${s.title}」（扮演${s.you}）卡住了，程度：${LEVELS[level].desc}。
還沒完成的任務：
${left}
請建議學習者下一句可以怎麼回 Tutor 的最後一句。只輸出 JSON：{"hint_zh":"繁體中文說明可以怎麼回","examples":["英文例句1","英文例句2（換一種說法）"]}

對話：
${transcript(turns)}`;
}

/** 結束後的回饋卡：做得好的、可以說得更自然的、值得記的片語 */
export function reportPrompt(s: Scenario, level: EnLevel, turns: Turn[]): string {
  return `你是英語口說家教。學習者剛完成情境角色扮演「${s.title}」（扮演${s.you}，程度：${LEVELS[level].desc}）。
任務：
${goalsText(s)}
請根據下面的對話給一張回饋卡（繁體中文說明，英文例句）：
- summary_zh：一兩句總評，先說做得好的地方。
- did_well：具體做得好的地方，最多 3 點。
- better：最多 3 句「可以說得更自然」：{"you":"學習者原句","better":"更自然的說法","zh":"中文意思","why":"繁體中文一句話"}。只挑真的有幫助的，沒有就空陣列。
- phrases：這個情境值得記住的實用片語，2–4 個：{"en":"英文","zh":"中文意思"}。
- goals_done：完成了哪些任務編號。
只輸出 JSON：{"summary_zh":"","did_well":[],"better":[],"phrases":[],"goals_done":[]}

對話：
${transcript(turns)}`;
}

/** 今日一課：6 句真的會用到的句子，附中文、用法、句型，最後一題造句 */
export function lessonPrompt(level: EnLevel, topic: string, recent: string[]): string {
  return `幫台灣成人英語學習者產生今天的口說小課。程度：${LEVELS[level].desc}。主題：${topic}。
產生 6 句實用、自然、真實生活會用到的英文句子（不要課本腔），每句附：
- zh：自然的繁體中文意思
- note：繁體中文一句，說明什麼時候用、或發音和語氣重點
- pattern：可以替換的句型，例如 "Could I get ___?"
最後出一題造句練習 task_zh：請學習者用今天的其中一個句型，說一句跟自己生活有關的話。
最近學過的句子不要重複：${recent.slice(0, 30).join(" / ") || "（無）"}
只輸出 JSON：{"title_zh":"這課的標題","items":[{"en":"","zh":"","note":"","pattern":""}],"task_zh":""}`;
}

/** 錄一句話：跟讀（有目標句）或自由說，照實寫聽到的，給發音、文法提示 */
export function audioCheckPrompt(level: EnLevel, target: string, task: string): string {
  const mode = target
    ? `學習者在跟讀這句：「${target}」。`
    : task
      ? `學習者在做造句練習：「${task}」。`
      : "學習者自由說了一段英文。";
  return `你是英語發音與口說教練，學習者是台灣成人，程度：${LEVELS[level].desc}。
${mode}
請聽音檔，只輸出 JSON：
{"heard":"照實寫出聽到的英文，包含錯誤和漏字，不要自動修正",
 "match":"${target ? "很接近｜大致正確｜要再練 三選一" : ""}",
 "missing":[${target ? '"跟讀時漏掉或唸錯的字"' : ""}],
 "pronunciation":[{"word":"單字","tip":"繁體中文，具體說怎麼發（例如 th 要把舌尖放在上下牙齒之間）"}],
 "grammar":[{"you":"原句","better":"更自然的說法","why":"繁體中文一句話"}],
 "better":"${target ? "" : "整段更自然的說法（已經很自然就照原句）"}",
 "praise_zh":"一句具體的鼓勵",
 "audio_ok":true}
規則：所有中文一律用繁體中文；只寫真的聽得出來的問題，發音清楚就給空陣列，不要為了給建議而編造；pronunciation 只放發音問題（文法放 grammar）；發音提示最多 3 個；${target ? "有漏字或多字時 match 不能給「很接近」；" : ""}${target ? "grammar 給空陣列；" : ""}聲音太小、太吵或沒有說英文，audio_ok 給 false。`;
}

/**
 * 跟讀：不給 AI 看目標句，只請它照實寫出聽到什麼、給發音提示；漏了哪些字由程式比對。
 * 給它看目標句的話，它會不自覺「補完」漏掉的字（實測：少唸最後兩個字，它回報聽到整句）
 */
export function shadowPrompt(level: EnLevel): string {
  return `你是英語發音教練，學習者是台灣成人，程度：${LEVELS[level].desc}。
請聽音檔，只輸出 JSON：
{"heard":"逐字照實寫出音檔裡的英文，包含漏字、多字、唸錯的字；不要修正、不要補完",
 "pronunciation":[{"word":"單字","tip":"繁體中文，具體說怎麼發（例如 th 要把舌尖放在上下牙齒之間）"}],
 "praise_zh":"一句具體的鼓勵",
 "audio_ok":true}
規則：所有中文一律用繁體中文；pronunciation 只放真的聽得出來的發音問題，最多 3 個，發音清楚就給空陣列，不要為了給建議而編造；聲音太小、太吵或沒有說英文，audio_ok 給 false。`;
}

/** 打字的造句或複習答案：對不對、更自然的說法 */
export function textCheckPrompt(level: EnLevel, task: string, text: string): string {
  return `你是英語家教，學習者是台灣成人，程度：${LEVELS[level].desc}。
${task ? `題目：${task}` : "學習者寫了一句英文。"}
學習者的答案：${text}
只輸出 JSON：{"ok":true,"better":"更自然的說法（已經很自然就照原句）","why":"繁體中文一句話說明（沒錯就說好在哪裡）","praise_zh":"一句鼓勵"}
ok：文法沒有明顯錯誤、意思通順就是 true。
better 一定是學習者自己這句話的修正版（保留他想說的意思，只改文法和用字），不要換成別的例句；沒有照題目要求的話，在 why 補一句提醒就好。所有中文一律用繁體中文。`;
}

/** 點對話裡的單字：這個字在這句話裡的意思、發音、用法 */
export function wordPrompt(level: EnLevel, word: string, sentence: string): string {
  return `你是英語家教，學習者是台灣成人，程度：${LEVELS[level].desc}。
學習者在一句英文裡點了一個字，想知道意思。
句子：${sentence || "（沒有句子）"}
點的字：${word}
只輸出 JSON：{"word":"字典上的寫法（動詞用原形、名詞用單數；專有名詞照原樣）","pos":"詞性（繁體中文，例如：名詞、動詞、形容詞、片語）","zh":"在這句話裡的中文意思（10 個字以內）","ipa":"美式 IPA，含斜線","syllables":"給台灣人看的拼讀：音節用 · 隔開、重音節用大寫，例如 SID · nee","explain_zh":"兩到三句：這個字在這句話裡的意思和語氣、常見用法、台灣人常犯的錯（沒有就不提）","forms":"不規則變化或常見變形，例如 go / went / gone（沒有就空字串）","examples":[{"en":"簡短自然的例句","zh":"中文翻譯"}],"collocations":["常一起出現的搭配（最多 3 個）"]}
examples 給 2 句，用的是跟原句一樣的意思、但換個情境。點的是縮寫（I'll、that's）時 word 照原樣，explain_zh 說明是哪兩個字縮的。所有中文一律用繁體中文。`;
}
