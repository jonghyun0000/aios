#!/usr/bin/env node
// 배포 워크플로가 `vercel deploy --prebuilt` 직전에 실행한다. 업로드할 바이트가 감사한 빌드와 같아야 한다.
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkPrebuiltOutput } from "./public-demo-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await checkPrebuiltOutput(root);
console.log(`PASS 업로드 대상 ${result.files}개 파일이 감사한 데모 빌드와 일치 (JS gzip ${result.javascriptGzipBytes} bytes)`);
