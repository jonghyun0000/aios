import { describe, expect, it } from "vitest";
import { jailPath } from "../builtin/fs.js";

describe("jailPath (path traversal 방어)", () => {
  const root = "/srv/project";

  it("allows paths inside the project root", () => {
    expect(jailPath(root, "src/index.ts")).toBe("/srv/project/src/index.ts");
    expect(jailPath(root, "./a/../b.ts")).toBe("/srv/project/b.ts");
  });

  it("rejects escapes — the prompt-injection classics", () => {
    expect(() => jailPath(root, "../secrets.env")).toThrow(/escapes/);
    expect(() => jailPath(root, "../../etc/passwd")).toThrow(/escapes/);
    expect(() => jailPath(root, "/etc/passwd")).toThrow(/escapes/);
    expect(() => jailPath(root, "a/../../outside")).toThrow(/escapes/);
  });
});

describe("jailPath — .git 보호", () => {
  const root = "/project";

  it("이전에는 .git 쓰기가 허용됐다 — 이제 막는다", () => {
    // 이 제품은 git 체크포인트를 안전망으로 삼는다.
    // 에이전트가 .git 을 덮어쓰면 그 안전망이 사라지고, 저장소는 복구 불가가 된다.
    expect(() => jailPath(root, ".git/config")).toThrow(/off limits/);
    expect(() => jailPath(root, ".git/HEAD")).toThrow(/off limits/);
    expect(() => jailPath(root, ".git")).toThrow(/off limits/);
  });

  it("중첩 저장소도 막는다", () => {
    // vendor/lib/.git 도 같은 이유로 위험하다.
    expect(() => jailPath(root, "vendor/lib/.git/config")).toThrow(/off limits/);
  });

  it("경로를 우회해도 막힌다", () => {
    expect(() => jailPath(root, "src/../.git/config")).toThrow(/off limits/);
  });

  it("이름이 비슷할 뿐인 정상 경로는 막지 않는다", () => {
    // .gitignore 나 .github 는 평범한 파일이다. 과잉 차단은 도구를 쓸 수 없게 만든다.
    expect(() => jailPath(root, ".gitignore")).not.toThrow();
    expect(() => jailPath(root, ".github/workflows/ci.yml")).not.toThrow();
    expect(() => jailPath(root, "src/git/index.ts")).not.toThrow();
  });

  it("프로젝트 루트 자체는 여전히 허용된다 — list_dir(\".\") 가 동작해야 한다", () => {
    expect(() => jailPath(root, ".")).not.toThrow();
  });
});
