export interface ActiveChatState {
  conversationId: string | null;
  runId: string | null;
}

const ACTIVE_CHAT_KEY = "vulture.chat.active";
const RUN_SEQ_PREFIX = "vulture.run.lastSeq.";

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function readActiveChatState(): ActiveChatState {
  const s = storage();
  if (!s) return { conversationId: null, runId: null };
  try {
    const raw = s.getItem(ACTIVE_CHAT_KEY);
    if (!raw) return { conversationId: null, runId: null };
    const parsed = JSON.parse(raw) as Partial<ActiveChatState>;
    return {
      conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : null,
      runId: typeof parsed.runId === "string" ? parsed.runId : null,
    };
  } catch {
    return { conversationId: null, runId: null };
  }
}

export function writeActiveChatState(state: ActiveChatState): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(ACTIVE_CHAT_KEY, JSON.stringify(state));
  } catch {
    // localStorage can be unavailable/quota-limited; recovery is best-effort.
  }
}

export function clearActiveRunId(): void {
  const current = readActiveChatState();
  writeActiveChatState({ ...current, runId: null });
}

function runSeqKey(runId: string): string {
  return `${RUN_SEQ_PREFIX}${runId}`;
}

export function readRunLastSeq(runId: string): number {
  const s = storage();
  if (!s) return -1;
  const raw = s.getItem(runSeqKey(runId));
  if (!raw) return -1;
  const seq = Number.parseInt(raw, 10);
  return Number.isFinite(seq) ? seq : -1;
}

export function writeRunLastSeq(runId: string, seq: number): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(runSeqKey(runId), String(seq));
  } catch {
    // best-effort recovery cache
  }
}

export function clearRunLastSeq(runId: string): void {
  const s = storage();
  if (!s) return;
  try {
    s.removeItem(runSeqKey(runId));
  } catch {
    // best-effort recovery cache
  }
}
