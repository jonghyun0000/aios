import assert from "node:assert/strict";
import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const expectedLicense = `MIT License

Copyright (c) 2026 JongHyun (jonghyun0000)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

async function packageManifests() {
  const files = [join(root, "package.json")];
  for (const parent of ["apps", "packages", "extensions", "plugins"]) {
    for (const entry of await readdir(join(root, parent), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith("._")) continue;
      const manifest = join(root, parent, entry.name, "package.json");
      try { await access(manifest); files.push(manifest); } catch { /* manifest가 없는 예제 폴더 */ }
    }
  }
  return files.sort();
}

test("루트 LICENSE는 선택한 저작권자를 포함한 표준 MIT 본문", async () => {
  assert.equal(await readFile(join(root, "LICENSE"), "utf8"), expectedLicense);
});

test("루트와 모든 workspace package가 SPDX MIT를 명시", async () => {
  const manifests = await packageManifests();
  assert.equal(manifests.length, 15);
  for (const path of manifests) {
    const manifest = JSON.parse(await readFile(path, "utf8"));
    assert.equal(manifest.license, "MIT", path.slice(root.length + 1));
  }
});

test("공개 진입 문서는 MIT 재사용 조건과 루트 LICENSE를 연결", async () => {
  const readme = await readFile(join(root, "README.md"), "utf8");
  const contributing = await readFile(join(root, "CONTRIBUTING.md"), "utf8");
  assert.match(readme, /\[MIT License\]\(LICENSE\)/);
  assert.match(contributing, /\[MIT License\]\(LICENSE\)/);
  assert.doesNotMatch(`${readme}\n${contributing}`, /라이선스는 미지정|라이선스 선택과 추가/);
});
