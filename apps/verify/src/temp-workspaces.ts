import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 검증용 작업공간의 생성과 정리를 한곳에서 책임진다.
 *
 * macOS의 tmpdir은 `/tmp`·`/var`처럼 실제 `/private/...`를 가리키는 별칭일 수 있다.
 * 그 문자열을 projectRoot로 넘기면 제품의 심볼릭 링크 감옥이 올바르게 거부하므로,
 * 감옥을 느슨하게 하지 않고 하네스가 먼저 실제 부모 경로를 사용한다.
 */
export class TempWorkspaceRegistry {
  readonly #directories: string[] = [];

  async create(prefix: string, parent = tmpdir()): Promise<string> {
    const canonicalParent = await realpath(parent);
    const created = await mkdtemp(join(canonicalParent, prefix));
    const canonicalCreated = await realpath(created);
    this.#directories.push(canonicalCreated);
    return canonicalCreated;
  }

  /** 이 인스턴스가 직접 만든 정확한 경로만 역순으로 정리한다. */
  async cleanup(): Promise<void> {
    for (const directory of this.#directories.splice(0).reverse()) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}
