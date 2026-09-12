import { useRef, useState } from "react";
import { useAuth } from "./lib/auth.js";
import { SessionProvider, useSessions } from "./lib/sessions.js";
import { Link, matchRoute, useRouter } from "./lib/router.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { LoginPage } from "./pages/Login.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { ChatPage } from "./pages/Chat.js";
import { DataPage, DataDetailPage } from "./pages/Data.js";
import { CollabPage } from "./pages/Collab.js";
import { MarketplacePage } from "./pages/Marketplace.js";
import { PluginDetailPage } from "./pages/PluginDetail.js";
import { BillingPage } from "./pages/Billing.js";
import { SettingsPage } from "./pages/Settings.js";
import { SessionActions } from "./components/SessionActions.js";
import type { SessionRow } from "./lib/api.js";

const NAV = [
  { to: "/", label: "대시보드", icon: "◆" },
  { to: "/chat", label: "채팅", icon: "✦" },
  { to: "/data", label: "공공통계", icon: "▤" },
  { to: "/collab", label: "협업", icon: "⇄" },
  { to: "/marketplace", label: "마켓플레이스", icon: "▣" },
  { to: "/billing", label: "결제", icon: "◷" },
  { to: "/settings", label: "설정", icon: "⚙" },
];

function Sidebar() {
  const { path } = useRouter();
  const { me, signOut } = useAuth();
  const sessions = useSessions();
  const [editing, setEditing] = useState<SessionRow | null>(null);
  const [historyOpen, setHistoryOpen] = useState(() => window.matchMedia("(min-width: 761px)").matches);
  const historyToggle = useRef<HTMLButtonElement>(null);
  const closeHistory = () => { setHistoryOpen(false); queueMicrotask(() => historyToggle.current?.focus()); };
  const isActive = (to: string) => (to === "/" ? path === "/" : path === to || path.startsWith(`${to}/`));

  return (
    <nav className="sidebar" aria-label="주요 메뉴">
      <div className="sidebar-primary">
      <div className="brand">
        AIOS
        <small>AI Operating System</small>
      </div>
      <div className="nav-links">{NAV.map((item) => (
        <Link
          key={item.to}
          to={item.to}
          className={`nav-item${isActive(item.to) ? " active" : ""}`}
          // 색만으로 현재 위치를 표시하면 스크린리더 사용자는 알 수 없다.
          ariaCurrent={isActive(item.to) && !(item.to === "/chat" && path !== "/chat") ? "page" : undefined}
        >
          <span aria-hidden>{item.icon}</span>
          {item.label}
        </Link>
      ))}</div>
      </div>
      <div className="sidebar-chat-heading">
        <button ref={historyToggle} className="history-toggle" aria-expanded={historyOpen} aria-controls="sidebar-conversations" onClick={() => setHistoryOpen((open) => !open)}>
          대화 내역 <span aria-hidden>{historyOpen ? "⌃" : "⌄"}</span>
        </button>
        <button className="sidebar-new" disabled={sessions.busy} onClick={sessions.newChat}>+ 새 대화</button>
      </div>
      <section className={`sidebar-history${historyOpen ? " open" : ""}`} id="sidebar-conversations" aria-label="대화 목록" onKeyDown={(event) => {
        if (event.key === "Escape" && historyOpen && window.matchMedia("(max-width: 760px)").matches) { event.preventDefault(); closeHistory(); }
      }}>
        <h2>{sessions.trash ? "휴지통" : "최근 대화"}</h2>
        <div className="history-controls"><input type="search" aria-label="대화 검색" placeholder="제목·본문 검색" maxLength={200} value={sessions.search} onChange={(e) => sessions.setSearch(e.target.value)} />
          <button aria-pressed={sessions.trash} onClick={() => sessions.setTrash(!sessions.trash)}>{sessions.trash ? "최근 대화 보기" : "휴지통"}</button></div>
        {sessions.search && <div className="sr-only" role="status" aria-live="polite">{sessions.loading ? "대화를 검색하는 중" : `검색 결과 ${sessions.rows.length}개${sessions.hasMore ? " 이상" : ""}`}</div>}
        <div className="session-list" onClick={(event) => {
          if (event.target instanceof Element && event.target.closest("a") && window.matchMedia("(max-width: 760px)").matches) closeHistory();
        }}>
          {sessions.rows.map((session) => (
            <div className="session-row" key={session.id}>
            {session.deleted_at ? <button className="session-item" onClick={() => setEditing(session)}>{session.title ?? "제목 없음"}</button> : <Link to={`/chat/${session.id}`} title={session.title ?? "제목 없음"}
              className={`session-item${path === `/chat/${session.id}` ? " active" : ""}`}
              ariaCurrent={path === `/chat/${session.id}` ? "page" : undefined}>
              {session.title ?? "제목 없음"}
              {session.project_name && <small className="session-project">{session.project_name}</small>}
            </Link>}
            <button className="session-menu" aria-label={`${session.title ?? "제목 없음"} 대화 관리`} disabled={sessions.busy} onClick={() => setEditing(session)}>⋯</button>
            </div>
          ))}
          {sessions.loading && <div className="small muted">대화를 불러오는 중…</div>}
          {sessions.error && <div className="small alert" role="alert">{sessions.error}<button onClick={sessions.refresh}>다시 불러오기</button></div>}
          {!sessions.loading && !sessions.error && sessions.rows.length === 0 && <p className="small muted">{sessions.search ? "검색 결과가 없습니다." : sessions.trash ? "휴지통이 비어 있습니다." : "첫 대화를 시작해 보세요."}</p>}
          {sessions.hasMore && <button className="history-more" disabled={sessions.loading} onClick={sessions.loadMore}>이전 대화 더 보기</button>}
        </div>
      </section>
      {editing && <SessionActions session={editing} onClose={() => setEditing(null)} />}
      <div className="small muted" style={{ padding: "0 10px 8px" }}>
        <div>{me?.role}</div>
        <div className="mono" style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
          {me?.orgId.slice(0, 8)}…
        </div>
      </div>
      {me?.via === "local" ? <div className="small muted" style={{ padding: 10 }}>내 컴퓨터 전용</div> : <button onClick={() => void signOut()} style={{ margin: "0 6px" }}>
        로그아웃
      </button>}
    </nav>
  );
}

/** 경로 → 화면. 순서가 중요하다: 더 구체적인 패턴을 먼저 본다. */
function Screen() {
  const { path } = useRouter();
  const { draftKey } = useSessions();

  const pluginDetail = matchRoute("/marketplace/:slug", path);
  if (pluginDetail) return <PluginDetailPage slug={pluginDetail.slug!} />;

  const dataDetail = matchRoute("/data/:id", path);
  if (dataDetail) return <DataDetailPage seriesId={dataDetail.id!} />;

  const collabDoc = matchRoute("/collab/:doc", path);
  if (collabDoc) return <CollabPage docName={collabDoc.doc!} />;

  const chatSession = matchRoute("/chat/:id", path);
  if (chatSession) return <ChatPage key={draftKey} sessionId={chatSession.id!} />;

  switch (path) {
    case "/": return <DashboardPage />;
    case "/chat": return <ChatPage key={draftKey} sessionId={null} />;
    case "/data": return <DataPage />;
    case "/collab": return <CollabPage docName={null} />;
    case "/marketplace": return <MarketplacePage />;
    case "/billing": return <BillingPage />;
    case "/settings": return <SettingsPage />;
    default:
      return (
        <div className="main-narrow">
          <h1>404</h1>
          <p className="page-sub">
            <code>{path}</code> 경로는 없습니다. <Link to="/">대시보드로</Link>
          </p>
        </div>
      );
  }
}

export function App() {
  const { status } = useAuth();
  const { path } = useRouter();

  if (status === "loading") {
    return (
      <div className="login-wrap">
        <div className="muted">불러오는 중…</div>
      </div>
    );
  }
  if (status === "anonymous") return <LoginPage />;

  return (
    <SessionProvider><div className="shell">
      {/*
        본문 바로가기. 내비 항목이 6개라 매 페이지마다 Tab 을 6번 눌러야 본문에 닿는다.
        평소에는 화면 밖에 있다가 포커스를 받으면 나타난다.
        해시 라우터를 쓰므로 href="#main" 은 라우팅을 건드린다 — 그래서 클릭을 가로채
        직접 포커스를 옮긴다.
      */}
      <a
        className="skip-link"
        href="#main-content"
        onClick={(e) => {
          e.preventDefault();
          const el = document.getElementById("main-content");
          el?.focus();
          el?.scrollIntoView();
        }}
      >
        본문으로 건너뛰기
      </a>
      <Sidebar />
      {/* tabIndex={-1} 이 있어야 프로그램적으로 포커스를 받을 수 있다 */}
      <main className={`main${path === "/chat" || path.startsWith("/chat/") ? " main-chat" : ""}`} id="main-content" tabIndex={-1}>
        {/* 경계를 사이드바 바깥이 아니라 콘텐츠에만 둔다 —
            한 화면이 죽어도 다른 메뉴로 이동할 수 있어야 한다. */}
        <ErrorBoundary resetKey={path}>
          <Screen />
        </ErrorBoundary>
      </main>
    </div></SessionProvider>
  );
}
