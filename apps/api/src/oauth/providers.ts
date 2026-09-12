import { ProviderError } from "@aios/shared";

/**
 * OAuth 프로바이더 정의.
 *
 * 왜 자체 구현인가: 0001 스키마 주석은 "OAuth는 Supabase Auth가 담당"이라 적었지만,
 * Supabase 없이 배포하면 로그인 수단이 아예 없었다(온프렘/에어갭 요구를 스스로 위반).
 * authorization code + PKCE는 표준이고, 프로바이더별 차이는 URL 3개와 프로필 파싱뿐이다.
 */

export interface OAuthProfile {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
}

export interface OAuthProvider {
  name: string;
  scopes: string[];
  authorizeUrl: string;
  tokenUrl: string;
  /** PKCE를 지원하는가. 지원하면 code 가로채기 공격이 무력화된다. */
  supportsPkce: boolean;
  fetchProfile(accessToken: string): Promise<OAuthProfile>;
}

async function getJson<T>(url: string, headers: Record<string, string>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: controller.signal });
    const text = await res.text();
    if (!res.ok) {
      throw new ProviderError("oauth", `${url} -> ${res.status}: ${text.slice(0, 200)}`, { status: res.status });
    }
    return JSON.parse(text) as T;
  } finally {
    clearTimeout(timer);
  }
}

export const GITHUB_PROVIDER: OAuthProvider = {
  name: "github",
  // user:email이 필요한 이유: GitHub 프로필의 email은 공개 설정에 따라 null일 수 있고,
  // 이메일 없이는 users 테이블(email not null unique)에 넣을 수 없다.
  scopes: ["read:user", "user:email"],
  authorizeUrl: "https://github.com/login/oauth/authorize",
  tokenUrl: "https://github.com/login/oauth/access_token",
  supportsPkce: false, // GitHub OAuth App은 PKCE 미지원 (GitHub App만 지원)
  async fetchProfile(accessToken) {
    const auth = { authorization: `Bearer ${accessToken}`, "user-agent": "aios" };
    const user = await getJson<{
      id: number; login: string; name: string | null; email: string | null; avatar_url: string;
    }>("https://api.github.com/user", auth);

    let email = user.email;
    if (!email) {
      const emails = await getJson<{ email: string; primary: boolean; verified: boolean }[]>(
        "https://api.github.com/user/emails",
        auth,
      );
      // 미인증 이메일을 계정 식별자로 쓰면 계정 탈취가 가능하다 — verified만 받는다.
      email = emails.find((e) => e.primary && e.verified)?.email
        ?? emails.find((e) => e.verified)?.email
        ?? null;
    }
    if (!email) throw new ProviderError("oauth", "github account has no verified email", { status: 400 });
    return { id: String(user.id), email, name: user.name ?? user.login, avatarUrl: user.avatar_url };
  },
};

export const GOOGLE_PROVIDER: OAuthProvider = {
  name: "google",
  scopes: ["openid", "email", "profile"],
  authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  supportsPkce: true,
  async fetchProfile(accessToken) {
    const user = await getJson<{
      sub: string; email: string; email_verified: boolean; name?: string; picture?: string;
    }>("https://openidconnect.googleapis.com/v1/userinfo", { authorization: `Bearer ${accessToken}` });
    if (!user.email_verified) throw new ProviderError("oauth", "google email is not verified", { status: 400 });
    return { id: user.sub, email: user.email, name: user.name, avatarUrl: user.picture };
  },
};

export const PROVIDERS: Record<string, OAuthProvider> = {
  github: GITHUB_PROVIDER,
  google: GOOGLE_PROVIDER,
};
