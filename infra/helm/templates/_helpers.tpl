{{/* 공통 이름·라벨 헬퍼 */}}

{{- define "aios.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "aios.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name (include "aios.name" .) | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{/*
이미지 참조. tag를 비워 두면 배포를 거부한다.
"latest로 알아서 되겠지"를 허용하면 어떤 커밋이 떠 있는지 알 수 없어 롤백이 불가능해진다.
*/}}
{{- define "aios.image" -}}
{{- $comp := index . 1 -}}
{{- $root := index . 0 -}}
{{- $tag := $root.Values.image.tag | default "" -}}
{{- if eq $tag "" -}}
{{- fail "image.tag is required — deploy with --set image.tag=<git-sha>. Never rely on an implicit 'latest'." -}}
{{- end -}}
{{/* CI가 ghcr.io/OWNER/REPO/{api,worker,migrate}:SHA 로 푸시하므로 같은 레이아웃을 쓴다.
     차트와 CI가 다른 규칙을 쓰면 "빌드는 됐는데 파드가 ImagePullBackOff"가 난다. */}}
{{- printf "%s/%s:%s" $root.Values.image.repository $comp $tag -}}
{{- end -}}

{{- define "aios.labels" -}}
app.kubernetes.io/name: {{ include "aios.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Values.image.tag | default .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{- end -}}

{{/*
앱 컨테이너의 공통 env.
시크릿은 값을 직접 넣지 않고 Secret 참조만 한다 — helm get values 로 비밀이 새는 것을 막는다.
*/}}
{{- define "aios.env" -}}
{{- range $k, $v := .Values.config }}
- name: {{ $k }}
  value: {{ $v | quote }}
{{- end }}
{{- range $k := list "DATABASE_URL" "REDIS_URL" "ANTHROPIC_API_KEY" "OPENAI_API_KEY" "GEMINI_API_KEY" "XAI_API_KEY" "SUPABASE_JWT_SECRET" "STRIPE_SECRET_KEY" "STRIPE_WEBHOOK_SECRET" }}
- name: {{ $k }}
  valueFrom:
    secretKeyRef:
      name: {{ $.Values.secretName }}
      key: {{ $k }}
      # 선택적 키(미설정 프로바이더)까지 필수로 두면 파드가 시작조차 못 한다.
      # DATABASE_URL/REDIS_URL 은 앱이 부팅 시 검사하므로 여기서 강제하지 않아도 안전하다.
      optional: true
{{- end }}
{{- if .Values.bigdata.enabled }}
- name: BIGDATA_DB_PATH
  value: {{ printf "%s/%s" .Values.bigdata.mountPath .Values.bigdata.fileName | quote }}
- name: BIGDATA_MEMORY_LIMIT
  value: {{ .Values.bigdata.memoryLimit | default "2GB" | quote }}
- name: BIGDATA_THREADS
  value: {{ .Values.bigdata.threads | default 4 | quote }}
{{- end }}
{{- if .Values.localLlm.enabled }}
- name: LOCAL_LLM_BASE_URL
  value: {{ required "localLlm.enabled 이면 baseUrl 이 필요하다" .Values.localLlm.baseUrl | quote }}
- name: LOCAL_LLM_MODELS
  value: {{ .Values.localLlm.models | quote }}
- name: LOCAL_EMBED_MODEL
  value: {{ .Values.localLlm.embedModel | quote }}
- name: LOCAL_EMBED_CONCURRENCY
  value: {{ .Values.localLlm.embedConcurrency | default 4 | quote }}
- name: LOCAL_CHAT_CONCURRENCY
  value: {{ .Values.localLlm.chatConcurrency | default 2 | quote }}
- name: LOCAL_LLM_CONTEXT
  value: {{ .Values.localLlm.contextWindow | quote }}
{{- end }}
- name: GIT_SHA
  value: {{ .Values.image.tag | quote }}
{{- end -}}

{{/*
데이터셋 볼륨. bigdata.enabled 가 아니면 아무것도 만들지 않는다 —
빈 볼륨을 붙이면 앱이 '데이터가 있는데 비었다'와 '데이터가 없다'를 구분하지 못한다.
readOnly 로 붙이는 이유: DuckDB 는 쓰기 연결이 파일 락을 잡아 파드가 여러 개면 서로 막는다.
*/}}
{{- define "aios.bigdataVolume" -}}
{{- if .Values.bigdata.enabled }}
- name: bigdata
  persistentVolumeClaim:
    claimName: {{ required "bigdata.enabled 이면 existingClaim 이 필요하다" .Values.bigdata.existingClaim }}
    readOnly: true
{{- end }}
{{- end -}}

{{- define "aios.bigdataMount" -}}
{{- if .Values.bigdata.enabled }}
- name: bigdata
  mountPath: {{ .Values.bigdata.mountPath }}
  readOnly: true
{{- end }}
{{- end -}}
