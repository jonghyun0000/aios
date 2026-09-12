import { configDefaults, type UserConfig } from "vitest/config";

/**
 * 모든 워크스페이스가 공유하는 vitest 기본값.
 *
 * `**\/._*` 를 제외하는 이유: macOS가 exFAT/SMB 볼륨에 남기는 AppleDouble
 * 리소스 포크(._foo.test.ts)가 테스트 파일로 수집되어 "Unexpected \x00" 으로
 * 스위트를 실패시킨다. 이 저장소가 외장 드라이브에 있어 실제로 발생했고,
 * 파일을 지워도 파일 접근 때마다 재생성되므로 설정으로 막는 것이 유일한 해법이다.
 */
export const sharedTestConfig: UserConfig["test"] = {
  exclude: [...configDefaults.exclude, "**/._*"],
};
