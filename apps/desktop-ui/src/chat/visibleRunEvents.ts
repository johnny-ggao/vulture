import type { AnyRunEvent, RunStreamStatus } from "../hooks/useRunStream";

const TERMINAL_STATUSES = new Set<RunStreamStatus>(["succeeded", "failed", "cancelled"]);

export function retainedRunEventsForTerminalRun(
  events: ReadonlyArray<AnyRunEvent>,
): AnyRunEvent[] {
  return events.filter((event) => event.type.startsWith("tool."));
}

export function visibleRunEventsForChat(opts: {
  activeRunId: string | null;
  activeConversationId: string | null;
  streamStatus: RunStreamStatus;
  streamEvents: ReadonlyArray<AnyRunEvent>;
  retained: ReadonlyArray<AnyRunEvent>;
  retainedConversationId: string | null;
}): ReadonlyArray<AnyRunEvent> {
  if (opts.activeRunId) {
    return TERMINAL_STATUSES.has(opts.streamStatus)
      ? retainedRunEventsForTerminalRun(opts.streamEvents)
      : opts.streamEvents;
  }
  if (
    opts.activeConversationId &&
    opts.retainedConversationId === opts.activeConversationId
  ) {
    return opts.retained;
  }
  return [];
}
