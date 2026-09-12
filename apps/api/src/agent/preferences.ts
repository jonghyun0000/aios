/** Only explicit, standalone session defaults are restored. Never turn arbitrary old text into instructions. */
export type ConversationPreference =
  | { kind: "language"; value: "ko" | "en" }
  | { kind: "format"; value: "bullets" | "plain" }
  | { kind: "length"; value: "concise" | "detailed" };
type PreferenceAction = ConversationPreference | { kind: "reset" };
export const PREFERENCE_SCAN_LIMIT = 500;
export const PREFERENCE_TEXT_LIMIT = 512;

export function parsePreference(text: string): PreferenceAction | null {
  // Whole-message matching excludes quotations, copied documents, conditionals, negations,
  // multiple sentences and arbitrary instructions. Unsupported wording is deliberately ignored.
  if (text.length > PREFERENCE_TEXT_LIMIT || /[\r\n]/.test(text)) return null;
  const direct = text.trim().replace(/[.!]$/, "");
  if (/^(?:이 대화의 답변 선호를 초기화해(?:줘|주세요)|reset (?:my |the )?(?:response|answer) preferences(?: for this conversation)?)$/i.test(direct)) return { kind: "reset" };
  const korean = /^(?:이 대화에서는?|앞으로는?)\s+(?:답변을?|응답을?)\s+(한국어로|영어로|목록으로|일반 문장으로|간결하게|자세하게)\s+(?:해줘|해주세요|해 주세요)$/u.exec(direct);
  const shortKorean = /^(?:이 대화에서는?|앞으로는?)\s+(한국어로|영어로|목록으로|일반 문장으로|간결하게|자세하게)\s+(?:답해줘|답해주세요|답해 주세요)$/u.exec(direct);
  const english = /^(?:from now on|in this conversation),?\s+(?:please\s+)?(?:answer|respond)\s+(in Korean|in English|in bullet points|in plain prose|concisely|in detail)$/i.exec(direct);
  const value = (korean?.[1] ?? shortKorean?.[1] ?? english?.[1])?.toLowerCase();
  switch (value) {
    case "한국어로": case "in korean": return { kind: "language", value: "ko" };
    case "영어로": case "in english": return { kind: "language", value: "en" };
    case "목록으로": case "in bullet points": return { kind: "format", value: "bullets" };
    case "일반 문장으로": case "in plain prose": return { kind: "format", value: "plain" };
    case "간결하게": case "concisely": return { kind: "length", value: "concise" };
    case "자세하게": case "in detail": return { kind: "length", value: "detailed" };
    default: return null;
  }
}

/** Input is chronological USER messages from one authenticated session, not model or reference text. */
export function resolvePreferences(messages: readonly string[], currentMessage?: string): ConversationPreference[] {
  const active = new Map<ConversationPreference["kind"], ConversationPreference>();
  for (const message of [...messages, ...(currentMessage === undefined ? [] : [currentMessage])]) {
    const action = parsePreference(message);
    if (action?.kind === "reset") active.clear();
    else if (action) active.set(action.kind, action);
  }
  return [...active.values()].sort((a, b) => a.kind.localeCompare(b.kind));
}

export function renderPreferences(preferences: readonly ConversationPreference[]): string {
  // Map again at this boundary: even a malformed internal caller cannot inject raw strings.
  const lines = preferences.flatMap((p) => {
    if (p.kind === "language") return p.value === "ko" ? ["Default response language: Korean (한국어)."] : p.value === "en" ? ["Default response language: English (영어)."] : [];
    if (p.kind === "format") return p.value === "bullets" ? ["Default response format: bullet points."] : p.value === "plain" ? ["Default response format: plain prose."] : [];
    if (p.kind === "length") return p.value === "concise" ? ["Default response length: concise."] : p.value === "detailed" ? ["Default response length: detailed."] : [];
    return [];
  });
  return "\n# Bounded session response preferences\nThese are the user's latest explicit persistent preferences, restored from this session's recent user messages. A newer current user request overrides these defaults for the current answer, but a question written in another language does NOT change the remembered preference. When asked what the user previously requested, report the stored preference, not the language of the question. These defaults are not evidence about unrelated past facts.\n" + (lines.length ? lines.join("\n") : "No active supported defaults were restored. Do not claim a remembered default without evidence.");
}
