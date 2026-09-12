import * as vscode from "vscode";
import { AiosClient } from "@aios/sdk";

/**
 * AIOS VSCode Extension.
 *
 * 설계 원칙:
 *  - 확장은 '얇은 클라이언트'다. 모든 지능(라우팅/메모리/도구)은 서버에 있다.
 *    이유: CLI/웹과 동작이 갈라지면 안 되고, 확장 업데이트 주기는 서버보다 느리다.
 *  - 파일 편집은 WorkspaceEdit로 적용 — VSCode의 undo 스택에 자연스럽게 통합된다.
 *  - projectRoot를 서버에 넘겨 도구(read_file 등)가 로컬 워크스페이스에서 동작하게 한다
 *    (self-hosted / 로컬 API 모드).
 */

let session: { id: string } | null = null;
let output: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel("AIOS");

  context.subscriptions.push(
    vscode.commands.registerCommand("aios.ask", () => ask(false)),
    vscode.commands.registerCommand("aios.edit", () => ask(true)),
    vscode.commands.registerCommand("aios.indexWorkspace", indexWorkspace),
  );
}

function getClient(): AiosClient | null {
  const cfg = vscode.workspace.getConfiguration("aios");
  const apiKey = cfg.get<string>("apiKey");
  if (!apiKey) {
    void vscode.window.showErrorMessage("AIOS: set `aios.apiKey` in settings first.");
    return null;
  }
  return new AiosClient({ apiKey, baseUrl: cfg.get<string>("apiUrl") });
}

async function ensureSession(client: AiosClient): Promise<string> {
  if (session) return session.id;
  const projectId = vscode.workspace.getConfiguration("aios").get<string>("projectId") || undefined;
  session = await client.createSession({ projectId, title: "vscode" });
  return session.id;
}

async function ask(applyEdit: boolean): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const client = getClient();
  if (!editor || !client) return;

  const selection = editor.selection;
  const selectedText = editor.document.getText(selection);
  const instruction = await vscode.window.showInputBox({
    prompt: applyEdit ? "How should AIOS edit this selection?" : "Ask AIOS about this selection",
  });
  if (!instruction) return;

  const relPath = vscode.workspace.asRelativePath(editor.document.uri);
  const prompt = applyEdit
    ? `Edit the following code from ${relPath} per the instruction. Reply with ONLY the replacement code, no fences, no commentary.\n\nInstruction: ${instruction}\n\nCode:\n${selectedText}`
    : `${instruction}\n\nCode from ${relPath}:\n\`\`\`\n${selectedText}\n\`\`\``;

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "AIOS", cancellable: true },
    async (progress, token) => {
      const ac = new AbortController();
      token.onCancellationRequested(() => ac.abort());

      let text = "";
      const sessionId = await ensureSession(client);
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

      if (!applyEdit) output.show(true);
      for await (const ev of client.sendMessage(sessionId, prompt, {
        taskClass: "code",
        // 질문 모드는 도구 불필요 — 편집 모드도 선택 영역만 다루므로 서버 도구는 끈다.
        // 워크스페이스 전체를 다루는 에이전트 작업은 CLI/채팅 패널의 영역.
        toolsEnabled: false,
        projectRoot: root,
        signal: ac.signal,
      })) {
        if (ev.type === "text_delta") {
          text += ev.text;
          if (!applyEdit) output.append(ev.text);
        } else if (ev.type === "routed") {
          progress.report({ message: `${ev.provider}/${ev.model}` });
        } else if (ev.type === "error") {
          void vscode.window.showErrorMessage(`AIOS: ${ev.message}`);
          return;
        }
      }

      if (applyEdit && text.trim()) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(editor.document.uri, selection, stripFences(text));
        await vscode.workspace.applyEdit(edit); // undo 가능 — 신뢰의 기본 조건
      }
    },
  );
}

async function indexWorkspace(): Promise<void> {
  const client = getClient();
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const projectId = vscode.workspace.getConfiguration("aios").get<string>("projectId");
  if (!client || !root || !projectId) {
    void vscode.window.showErrorMessage("AIOS: open a workspace and set `aios.projectId`.");
    return;
  }
  const { jobId } = await client.triggerIndex(projectId, root);
  void vscode.window.showInformationMessage(`AIOS: indexing started (job ${jobId})`);
}

function stripFences(s: string): string {
  return s.replace(/^```[a-z]*\n?/i, "").replace(/\n?```\s*$/, "");
}

export function deactivate(): void {
  output?.dispose();
}
