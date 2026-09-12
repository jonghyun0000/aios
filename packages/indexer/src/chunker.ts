/**
 * 코드 청커 — 함수/클래스 경계 휴리스틱 기반.
 *
 * tree-sitter를 1차 버전에서 쓰지 않는 이유:
 *  - 네이티브 바인딩이 배포 표면(플랫폼별 빌드)을 키운다.
 *  - RAG 품질에서 청크 '경계'의 정밀도보다 임베딩 모델과 하이브리드 검색의 기여가 훨씬 크다.
 *  - 인터페이스(chunk())가 고정이므로 실측 후 tree-sitter로 교체 가능 — 경계는 지금, 정밀도는 나중.
 *
 * 전략: 선언부 시작 패턴에서 우선 분할, 없으면 고정 창(120줄, 20% 오버랩).
 */

export interface Chunk {
  startLine: number; // 1-based
  endLine: number;
  symbol?: string;
  content: string;
}

const MAX_LINES = 120;
const OVERLAP = 24;
const MAX_CHARS = 6_000;

// 주요 언어의 최상위 선언 시작 패턴 (들여쓰기 없는 라인 기준)
const DECL = /^(export\s+)?(async\s+)?(function|class|interface|type|const|def|fn|func|impl|struct|enum|public|private|package)\b/;
const SYMBOL = /(?:function|class|interface|def|fn|func|struct|enum|type)\s+([A-Za-z_$][\w$]*)/;

export function chunkCode(source: string): Chunk[] {
  const lines = source.split("\n");
  if (lines.length === 0) return [];

  // 1) 선언 경계 수집
  const boundaries: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.length > 0 && !/^\s/.test(line) && DECL.test(line)) boundaries.push(i);
  }
  boundaries.push(lines.length);

  // 2) 경계 구간을 순회하며 크기 상한으로 재분할
  const chunks: Chunk[] = [];
  for (let b = 0; b < boundaries.length - 1; b++) {
    const from = boundaries[b]!;
    const to = boundaries[b + 1]!;
    let cursor = from;
    while (cursor < to) {
      const end = Math.min(cursor + MAX_LINES, to);
      const slice = lines.slice(cursor, end);
      const content = clip(slice.join("\n"), MAX_CHARS);
      if (content.trim().length > 0) {
        chunks.push({
          startLine: cursor + 1,
          endLine: end,
          symbol: slice.map((l) => l.match(SYMBOL)?.[1]).find(Boolean),
          content,
        });
      }
      if (end >= to) break;
      cursor = end - OVERLAP; // 오버랩: 경계에 걸친 코드가 검색에서 유실되지 않도록
    }
  }
  return chunks;
}

function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

const LANG_BY_EXT: Record<string, string> = {
  ".ts": "typescript", ".tsx": "typescript", ".js": "javascript", ".jsx": "javascript",
  ".py": "python", ".go": "go", ".rs": "rust", ".java": "java", ".kt": "kotlin",
  ".rb": "ruby", ".php": "php", ".cs": "csharp", ".c": "c", ".h": "c",
  ".cpp": "cpp", ".hpp": "cpp", ".swift": "swift", ".sql": "sql", ".sh": "shell",
  ".md": "markdown", ".json": "json", ".yaml": "yaml", ".yml": "yaml", ".toml": "toml",
};

export function detectLang(path: string): string | null {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return null;
  return LANG_BY_EXT[path.slice(dot)] ?? null;
}

export function isIndexable(path: string, sizeBytes: number): boolean {
  if (sizeBytes > 1_000_000) return false; // 1MB+ 는 생성물/데이터일 확률이 높다
  return detectLang(path) !== null;
}
