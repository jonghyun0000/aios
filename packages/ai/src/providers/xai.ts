import type { ProviderId } from "@aios/shared";
import { OpenAiAdapter } from "./openai.js";

/**
 * xAI(Grok) 어댑터.
 * xAI API는 OpenAI Chat Completions 호환이므로 base URL만 바꾼 상속으로 끝낸다.
 * 별도 구현을 두지 않는 이유: 호환 API를 재구현하면 두 코드 경로가 서로 다르게 썩는다.
 * 비호환이 생기는 순간에만 메서드를 오버라이드한다.
 */
export class XaiAdapter extends OpenAiAdapter {
  override readonly id: ProviderId = "xai";

  constructor(apiKey: string) {
    super(apiKey);
    this.baseUrl = "https://api.x.ai/v1";
  }

  override async embed(): Promise<number[][]> {
    throw new Error("xai does not provide an embeddings API; router uses openai/gemini for embeddings");
  }
}
