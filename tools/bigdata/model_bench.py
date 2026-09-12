#!/usr/bin/env python3
"""
로컬 모델 비교 벤치마크.

"한국어가 더 낫다"는 인상이 아니라 **측정**으로 판단하기 위한 도구다.
qwen2.5:7b가 한국어 답변에 중국어를 섞는 것을 눈으로 봤지만, 그것이
얼마나 자주 일어나는지, 다른 모델은 어떤지는 재보지 않으면 모른다.

측정 항목 — 이 제품에서 실제로 중요한 순서대로:
 1) 도구 호출 정확도  : 도구를 못 부르면 1.4억 행이 무용지물이다. 가장 중요하다.
 2) 언어 순수성       : 한국어 질문에 중국어·일본어 문자가 섞이는 비율.
 3) 지시 준수         : "숫자만", "한 문장" 같은 제약을 지키는가.
 4) 속도             : tok/s. 대화형으로 쓸 수 있는가.

각 항목을 여러 번 반복해 평균을 낸다. LLM은 같은 프롬프트에도 다르게 답하므로
1회 측정으로 모델을 비교하면 운을 재는 것이 된다.
"""
import argparse
import json
import re
import statistics
import sys
import time
import urllib.error
import urllib.request

OLLAMA = "http://127.0.0.1:11434"

# 한중일 문자 구분.
#  - 한글: AC00-D7A3 (음절), 1100-11FF (자모)
#  - 한자: 4E00-9FFF  ← 중국어 누출의 신호
#  - 가나: 3040-30FF  ← 일본어 누출
HANGUL = re.compile(r"[가-힣ᄀ-ᇿ]")
HANJA = re.compile(r"[一-鿿]")
KANA = re.compile(r"[぀-ヿ]")

SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "bigdata_search",
        "description": "한국 공공통계 카탈로그에서 통계표를 검색한다",
        "parameters": {
            "type": "object",
            "properties": {"keyword": {"type": "string", "description": "검색어"}},
            "required": ["keyword"],
        },
    },
}

SERIES_TOOL = {
    "type": "function",
    "function": {
        "name": "bigdata_series",
        "description": "특정 통계표(series_id)의 시계열을 조회한다",
        "parameters": {
            "type": "object",
            "properties": {
                "series_id": {"type": "integer"},
                "period_prefix": {"type": "string", "description": "시점 접두사 (예: 2024)"},
            },
            "required": ["series_id"],
        },
    },
}

# (프롬프트, 도구목록, 기대 도구, 기대 인자 검사)
TOOL_CASES = [
    ("전세가격 관련 통계표를 찾아줘.", [SEARCH_TOOL], "bigdata_search",
     lambda a: "전세" in str(a.get("keyword", ""))),
    ("실업률 통계가 있는지 검색해줘.", [SEARCH_TOOL], "bigdata_search",
     lambda a: "실업" in str(a.get("keyword", ""))),
    ("series_id 1978의 2024년 시계열을 보여줘.", [SERIES_TOOL], "bigdata_series",
     lambda a: str(a.get("series_id")) == "1978" and "2024" in str(a.get("period_prefix", ""))),
    ("인구 관련 통계표를 찾아줘.", [SEARCH_TOOL], "bigdata_search",
     lambda a: "인구" in str(a.get("keyword", ""))),
]

# (프롬프트, 검증 함수, 설명)
INSTRUCTION_CASES = [
    ("1+1은? 숫자만 답해. 다른 말은 하지 마.",
     lambda t: t.strip().rstrip(".") == "2", "숫자만"),
    ("대한민국의 수도는? 한 단어로만 답해.",
     lambda t: "서울" in t and len(t.strip()) <= 12, "한 단어"),
    ("KOSIS가 무엇인지 한 문장으로 설명해줘.",
     lambda t: t.count(".") + t.count("다") >= 1 and len(t) < 300, "한 문장"),
]

# 도구 결과를 받은 뒤 한국어로 요약하는 2번째 턴.
# 실제 제품에서 사용자가 보는 것은 도구 호출 자체가 아니라 **이 답변**이다.
# 1턴만 재면 "도구는 잘 부르는데 결과 설명에서 중국어가 섞이는" 경우를 놓친다.
TOOL_FOLLOWUP = [
    {"role": "user", "content": "전세가격 통계를 찾아줘."},
    {"role": "assistant", "content": "", "tool_calls": [{
        "id": "call_1", "type": "function",
        "function": {"name": "bigdata_search", "arguments": '{"keyword":"전세가격"}'},
    }]},
    {"role": "tool", "tool_call_id": "call_1", "content":
        "series_id\tseries_name\tunit\tperiod_min\tperiod_max\trow_count\n"
        "1978\t유형별 전세가격지수\t2021.6=100.0\t2003-12\t2025-03\t110632\n"
        "1957\t규모별 전세가격지수\t2021.6=100.0\t2012-01\t2025-03\t78052"},
]

KOREAN_PROMPTS = [
    "한국의 전세 제도가 무엇인지 두 문장으로 설명해줘.",
    "통계청이 하는 일을 세 가지만 알려줘.",
    "소비자물가지수가 오르면 생활에 어떤 영향이 있는지 설명해줘.",
]


# 사고(thinking) 모델에 추가로 주는 출력 예산.
#
# max_tokens 는 '사고 + 응답'을 함께 제한한다. 사고가 예산을 다 쓰면
# **가시 응답이 0자**가 되고, 그것을 "한국어를 못 한다"로 오독하게 된다.
# 실제로 qwen3:8b 를 max_tokens=120 으로 재고 0%를 매길 뻔했다
# (실측: content 0자 / reasoning 639자 / finish=length).
#
# 이 저장소는 같은 문제를 이미 한 번 겪었다 — router.ts 의 THINKING_HEADROOM 이 그것이다.
# 계측기가 같은 함정에 빠지면 멀쩡한 모델을 잘못 탈락시킨다.
THINKING_HEADROOM = 700


def chat(model: str, messages: list[dict], tools: list[dict] | None = None,
         max_tokens: int = 120, timeout: int = 300, thinks: bool = False) -> dict:
    if thinks:
        max_tokens += THINKING_HEADROOM
    body = {"model": model, "messages": messages, "max_tokens": max_tokens, "stream": False}
    if tools:
        body["tools"] = tools
    req = urllib.request.Request(
        f"{OLLAMA}/v1/chat/completions",
        data=json.dumps(body).encode(),
        headers={"content-type": "application/json"},
    )
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = json.loads(resp.read())
    data["_elapsed"] = time.time() - t0
    return data


def capabilities(model: str) -> list[str]:
    """
    Ollama가 알려주는 모델 능력.

    도구 호출 지원 여부를 요청을 던져 보고 400으로 알아내면, 실패가 '모델이 도구를
    못 부른다'인지 '내 요청이 틀렸다'인지 구분되지 않는다.
    실제로 exaone3.5:7.8b 는 capabilities=['completion'] 으로 tools가 아예 없다.
    """
    req = urllib.request.Request(
        f"{OLLAMA}/api/show",
        data=json.dumps({"model": model}).encode(),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read()).get("capabilities") or []
    except Exception:
        return []


def bench(model: str, repeats: int) -> dict:
    print(f"\n{'='*66}\n{model}\n{'='*66}")
    caps = capabilities(model)
    supports_tools = "tools" in caps
    thinks = "thinking" in caps
    print(f"  능력        : {', '.join(caps) or '알 수 없음'}"
          + (f"  (사고 예산 +{THINKING_HEADROOM} 토큰)" if thinks else ""))
    if not supports_tools:
        # 도구를 못 부르면 이 제품에서는 쓸 수 없다. 나머지를 재도 의미가 없으므로
        # 명확히 표시하고 언어·속도만 참고용으로 잰다.
        print("  ** 도구 호출 미지원 — 이 제품에서는 사용 불가 **")

    # --- 1) 도구 호출 ---
    tool_ok = tool_args_ok = tool_total = 0
    for prompt, tools, want, check in (TOOL_CASES if supports_tools else []):
        for _ in range(repeats):
            tool_total += 1
            try:
                d = chat(model, [{"role": "user", "content": prompt}], tools, thinks=thinks)
                msg = d["choices"][0]["message"]
                calls = msg.get("tool_calls") or []
                if calls and calls[0]["function"]["name"] == want:
                    tool_ok += 1
                    try:
                        args = json.loads(calls[0]["function"]["arguments"])
                    except Exception:
                        args = {}
                    if check(args):
                        tool_args_ok += 1
            except Exception as e:
                print(f"    도구 호출 실패: {str(e)[:70]}")
    if tool_total:
        print(f"  도구 호출   : {tool_ok}/{tool_total} 정확한 도구 "
              f"({100*tool_ok/tool_total:.0f}%), 인자까지 정확 {tool_args_ok}/{tool_total} "
              f"({100*tool_args_ok/tool_total:.0f}%)")
    else:
        print("  도구 호출   : 미지원 (측정하지 않음)")

    # --- 2) 언어 순수성 + 속도 ---
    hanja_hits = kana_hits = empty_hits = lang_total = 0
    tps: list[float] = []
    samples: list[str] = []
    for prompt in KOREAN_PROMPTS:
        for _ in range(repeats):
            lang_total += 1
            try:
                d = chat(model, [{"role": "user", "content": prompt}], thinks=thinks)
                text = d["choices"][0]["message"].get("content") or ""
                usage = d.get("usage") or {}
                out_tok = usage.get("completion_tokens") or 0
                if out_tok and d["_elapsed"] > 0:
                    tps.append(out_tok / d["_elapsed"])
                # 한글이 있는데 한자/가나가 섞이면 누출이다.
                # 한글이 아예 없으면(영어로만 답) 그것도 실패로 센다.
                if not text.strip():
                    # 빈 응답은 언어 문제가 아니다. 예산 부족이나 생성 실패다.
                    empty_hits += 1
                    samples.append(f"[빈 응답] finish={d['choices'][0].get('finish_reason')}")
                elif not HANGUL.search(text):
                    hanja_hits += 1
                    samples.append(f"[한국어 아님] {text[:60]}")
                elif HANJA.search(text):
                    hanja_hits += 1
                    samples.append(f"[한자] {''.join(HANJA.findall(text))[:20]} … {text[:50]}")
                elif KANA.search(text):
                    kana_hits += 1
                    samples.append(f"[가나] {text[:60]}")
            except Exception as e:
                print(f"    생성 실패: {str(e)[:70]}")
    # 도구 결과 요약(2턴)에서도 언어 순수성을 잰다.
    if supports_tools:
        for _ in range(repeats):
            lang_total += 1
            try:
                d = chat(model, TOOL_FOLLOWUP, [SEARCH_TOOL], thinks=thinks)
                text = d["choices"][0]["message"].get("content") or ""
                if not HANGUL.search(text):
                    hanja_hits += 1
                    samples.append(f"[도구요약/한국어아님] {text[:60]}")
                elif HANJA.search(text):
                    hanja_hits += 1
                    samples.append(f"[도구요약/한자] {''.join(HANJA.findall(text))[:20]} … {text[:50]}")
                elif KANA.search(text):
                    kana_hits += 1
                    samples.append(f"[도구요약/가나] {text[:60]}")
            except Exception as e:
                print(f"    도구 요약 실패: {str(e)[:70]}")

    leak = hanja_hits + kana_hits + empty_hits
    if empty_hits:
        print(f"  ** 빈 응답 {empty_hits}건 — 사고 예산 부족일 수 있다 (THINKING_HEADROOM 확인) **")
    print(f"  언어 순수성 : {lang_total-leak}/{lang_total} 정상 "
          f"({100*(lang_total-leak)/lang_total:.0f}%), 누출 {leak}건")
    for s in samples[:3]:
        print(f"      {s}")

    # --- 3) 지시 준수 ---
    inst_ok = inst_total = 0
    for prompt, check, label in INSTRUCTION_CASES:
        hits = 0
        for _ in range(repeats):
            inst_total += 1
            try:
                d = chat(model, [{"role": "user", "content": prompt}], max_tokens=200, thinks=thinks)
                text = d["choices"][0]["message"].get("content") or ""
                if check(text):
                    inst_ok += 1
                    hits += 1
            except Exception:
                pass
        print(f"  지시 '{label}' : {hits}/{repeats}")
    print(f"  지시 준수   : {inst_ok}/{inst_total} ({100*inst_ok/inst_total:.0f}%)")

    # 표에는 비율만 남는다. 무엇이 어떻게 깨졌는지는 파일로 남겨야
    # 나중에 "왜 이 모델을 탈락시켰나"를 근거로 설명할 수 있다.
    if samples:
        path = f"/Volumes/T7/bigdata/logs/leaks-{model.replace(':', '_').replace('/', '_')}.txt"
        with open(path, "w", encoding="utf-8") as fh:
            fh.write("\n".join(samples))
        print(f"  누출 샘플   : {path}")

    speed = statistics.median(tps) if tps else 0.0
    print(f"  속도        : {speed:.1f} tok/s (중앙값, n={len(tps)})")

    return {
        "model": model,
        "supports_tools": supports_tools,
        "tool_call_pct": (100 * tool_ok / tool_total) if tool_total else -1.0,
        "tool_args_pct": (100 * tool_args_ok / tool_total) if tool_total else -1.0,
        "lang_pure_pct": 100 * (lang_total - leak) / lang_total,
        "instruction_pct": 100 * inst_ok / inst_total,
        "tok_per_s": speed,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("models", nargs="+")
    ap.add_argument("--repeats", type=int, default=3,
                    help="항목당 반복 횟수 (LLM은 비결정적이라 1회로는 비교할 수 없다)")
    args = ap.parse_args()

    results = [bench(m, args.repeats) for m in args.models]

    print(f"\n{'='*78}\n{'모델':<24} {'도구':>7} {'인자':>7} {'한국어':>7} {'지시':>7} {'tok/s':>8}")
    print("-" * 78)
    for r in results:
        tool = "  미지원" if not r["supports_tools"] else f"{r['tool_call_pct']:>6.0f}%"
        args = "      -" if not r["supports_tools"] else f"{r['tool_args_pct']:>6.0f}%"
        print(f"{r['model']:<24} {tool} {args} "
              f"{r['lang_pure_pct']:>6.0f}% {r['instruction_pct']:>6.0f}% {r['tok_per_s']:>8.1f}")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
