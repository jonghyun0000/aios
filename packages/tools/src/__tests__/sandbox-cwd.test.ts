import { describe, it, expect } from "vitest";
import { sandboxWorkdir } from "../builtin/shell.js";

const root = "/Volumes/T7/my project";
describe("샌드박스 작업 폴더", () => {
  it("상대·호스트 절대·컨테이너 경로가 같은 폴더를 가리킨다", () => {
    for (const cwd of [".", root, "/workspace"]) expect(sandboxWorkdir(root, cwd)).toBe("/workspace");
    for (const cwd of ["src", `${root}/src`, "/workspace/src"]) expect(sandboxWorkdir(root, cwd)).toBe("/workspace/src");
  });
  it("부모 폴더와 다른 절대경로는 거부한다", () => {
    for (const cwd of ["..", "../../etc", "/etc", "/workspace/../../etc", `${root}-other`]) {
      expect(() => sandboxWorkdir(root, cwd)).toThrow("inside the project");
    }
  });
});
