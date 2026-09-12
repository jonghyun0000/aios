import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CollabProvider, type CollabPeer, type ConnectionStatus } from "../lib/collab.js";
import { wsTokenParam } from "../lib/api.js";
import { useAuth } from "../lib/auth.js";
import { applyDiff, diffText, transformCaret } from "../lib/textarea-binding.js";
import { useRouter } from "../lib/router.js";

/** 사용자 색은 ID에서 결정적으로 뽑는다 — 새로고침해도 같은 사람은 같은 색이어야 알아볼 수 있다. */
function colorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return `hsl(${hash % 360} 70% 55%)`;
}

const STATUS_LABEL: Record<ConnectionStatus, { text: string; cls: string }> = {
  connecting: { text: "연결 중", cls: "warn" },
  connected: { text: "연결됨", cls: "ok" },
  disconnected: { text: "끊김 — 재연결 시도 중", cls: "err" },
};

export function CollabPage({ docName }: { docName: string | null }) {
  const { navigate } = useRouter();
  const [draft, setDraft] = useState("demo");

  if (!docName) {
    return (
      <div className="main-narrow" style={{ maxWidth: 560 }}>
        <h1>실시간 협업</h1>
        <p className="page-sub">
          문서 이름을 정하면 그 이름을 아는 같은 조직 구성원과 실시간으로 함께 편집합니다.
        </p>
        <form className="card" onSubmit={(event) => { event.preventDefault(); if (draft.trim()) navigate(`/collab/${encodeURIComponent(draft.trim())}`); }}>
          <div className="field">
            <label htmlFor="doc">문서 이름</label>
            <input id="doc" value={draft} onChange={(e) => setDraft(e.target.value)} className="mono" />
          </div>
          <button
            className="primary"
            type="submit"
            disabled={!draft.trim()}
          >
            문서 열기
          </button>
          <p className="small muted" style={{ marginBottom: 0, marginTop: 12 }}>
            문서는 조직 단위로 격리됩니다. 다른 조직이 같은 이름을 써도 서로 보이지 않습니다.
          </p>
        </form>
      </div>
    );
  }
  return <CollabEditor docName={docName} />;
}

function CollabEditor({ docName }: { docName: string }) {
  const { me } = useAuth();
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [peers, setPeers] = useState<CollabPeer[]>([]);
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const providerRef = useRef<CollabProvider | null>(null);
  /** 로컬 입력으로 발생한 Y.Text 변경인지 구분한다 — 자기 변경으로 커서를 옮기면 안 된다. */
  const localEditRef = useRef(false);

  const identity = useMemo(
    () => ({
      name: me?.userId ? `사용자 ${me.userId.slice(0, 6)}` : `게스트 ${Math.random().toString(36).slice(2, 6)}`,
      color: colorFor(me?.userId ?? String(Math.random())),
    }),
    [me?.userId],
  );

  useEffect(() => {
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    const url = `${proto}://${window.location.host}/v1/collab?doc=${encodeURIComponent(docName)}${wsTokenParam()}`;
    const provider = new CollabProvider(url, {
      identity,
      onStatus: setStatus,
      onPeers: setPeers,
    });
    providerRef.current = provider;

    const ytext = provider.text;
    setValue(ytext.toJSON());

    const onChange = () => {
      const next = ytext.toJSON();
      setValue((prev) => {
        if (prev === next) return prev;
        // 원격 변경이면 커서를 보정한다. 로컬 입력이면 브라우저가 이미 올바른 위치에 두었다.
        if (!localEditRef.current) {
          const el = textareaRef.current;
          const d = diffText(prev, next);
          if (el && d && document.activeElement === el) {
            const start = transformCaret(el.selectionStart, d);
            const end = transformCaret(el.selectionEnd, d);
            // 값 교체 후에 selection을 복원해야 한다 — React가 DOM을 갱신한 뒤여야 하므로
            // 마이크로태스크로 미룬다.
            queueMicrotask(() => el.setSelectionRange(start, end));
          }
        }
        return next;
      });
    };

    ytext.observe(onChange);
    return () => {
      ytext.unobserve(onChange);
      provider.destroy();
      providerRef.current = null;
    };
  }, [docName, identity]);

  const onInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const provider = providerRef.current;
    if (!provider) return;
    const next = e.target.value;
    const d = diffText(provider.text.toJSON(), next);
    if (!d) return;
    localEditRef.current = true;
    try {
      applyDiff(provider.text, d);
    } finally {
      localEditRef.current = false;
    }
    setValue(next);
  }, []);

  const onSelect = useCallback((e: React.SyntheticEvent<HTMLTextAreaElement>) => {
    providerRef.current?.setCursor(e.currentTarget.selectionStart);
  }, []);

  const label = STATUS_LABEL[status];
  const others = peers.filter((p) => p.clientId !== providerRef.current?.doc.clientID);

  return (
    <div className="main-narrow" style={{ maxWidth: 1000 }}>
      <div className="row-between">
        <div>
          <h1 className="mono">{docName}</h1>
          <p className="page-sub">
            연결 중에는 편집을 참여자에게 전파합니다. 서버 저장은 지연될 수 있으므로 연결 상태를 확인하세요.
          </p>
        </div>
        {/* 연결이 끊겼는지 낭독되지 않으면 편집이 사라지는 줄 모른다 */}
        <span className={`badge ${label.cls}`} role="status" aria-live="polite">{label.text}</span>
      </div>

      <div className="row wrap" style={{ marginBottom: 12 }}>
        <span className="peer-dot" title="나">
          <i style={{ background: identity.color }} />
          {identity.name} (나)
        </span>
        {others.map((p) => (
          <span className="peer-dot" key={p.clientId}>
            <i style={{ background: p.color }} />
            {p.name}
          </span>
        ))}
        {others.length === 0 && (
          <span className="small muted">
            다른 참여자가 없습니다. 이 주소를 새 탭에서 열면 동기화를 확인할 수 있습니다.
          </span>
        )}
      </div>

      {status === "disconnected" && (
        <div className="alert" role="alert">
          서버와 연결이 끊겼습니다. 편집은 이 탭의 메모리에만 남습니다. 재연결되면 병합하지만, 그 전에 새로고침하거나 탭을 닫으면 잃을 수 있습니다. 필요한 내용은 복사해 보관하세요.
        </div>
      )}

      <textarea
        aria-label={`${docName} 협업 문서 내용`}
        aria-describedby="collab-editor-help"
        ref={textareaRef}
        className="editor card"
        value={value}
        onChange={onInput}
        onSelect={onSelect}
        onBlur={() => providerRef.current?.setCursor(null)}
        spellCheck={false}
        placeholder="여기에 입력하세요…"
      />
      <p className="small muted" id="collab-editor-help">
        {value.length.toLocaleString()}자 · 참여자 {others.length + 1}명
      </p>
    </div>
  );
}
