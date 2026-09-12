# 도구 실행 샌드박스 이미지 (run_command 도구가 `docker run` 으로 사용)
# 원칙: 최소 권한 — 비루트 유저, 네트워크는 실행 시 --network=none 으로 차단.
FROM ubuntu:24.04
RUN apt-get update && apt-get install -y --no-install-recommends \
      git curl ca-certificates build-essential python3 python3-pip \
      ripgrep jq \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y nodejs \
    && useradd -m -u 10001 sandbox
USER sandbox
WORKDIR /workspace
