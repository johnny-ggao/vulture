import type { AgentCoreFile } from "../../api/agents";

export interface CoreTabProps {
  files: AgentCoreFile[];
  selectedFile: string;
  onSelectFile: (name: string) => void;
  fileContent: string;
  onChangeFileContent: (next: string) => void;
  fileBusy: boolean;
  fileStatus: string;
  corePath: string;
  onSave: () => void;
}

/**
 * Two-pane file editor for the agent's "core" markdown bundle (typically
 * AGENTS.md + companions). State is owned by the modal shell — this tab
 * is purely presentational so the loading effects can sit alongside the
 * other modal lifecycle effects.
 *
 * Round 14:
 *   - File picker buttons surface size + "missing" state inline so the
 *     user knows which files exist and roughly how big they are
 *     before clicking.
 *   - Tab key in the editor inserts two spaces instead of moving focus
 *     out of the textarea — matching expectations for a code-shaped
 *     editor without trapping keyboard navigation entirely (Esc / the
 *     close button still escape).
 */
export function CoreTab(props: CoreTabProps) {
  return (
    <div className="agent-config-panel" role="tabpanel">
      <section className="agent-core">
        <div className="agent-core-head">
          <div>
            <h3 className="agent-core-title">Agent Core</h3>
            <div className="agent-core-path">{props.corePath || "未加载"}</div>
          </div>
          <button
            type="button"
            className="btn-primary"
            disabled={!props.selectedFile || props.fileBusy}
            onClick={props.onSave}
          >
            {props.fileBusy ? "处理中..." : "保存文件"}
          </button>
        </div>

        <div className="agent-core-body">
          <div className="agent-core-files">
            {props.files.map((file) => {
              const active = file.name === props.selectedFile;
              return (
                <button
                  key={file.name}
                  type="button"
                  className="agent-core-file"
                  data-active={active ? "true" : undefined}
                  data-missing={file.missing ? "true" : undefined}
                  onClick={() => props.onSelectFile(file.name)}
                  aria-pressed={active}
                  title={file.missing ? "文件未创建" : file.path}
                >
                  <span className="agent-core-file-name">{file.name}</span>
                  <span
                    className="agent-core-file-meta"
                    aria-hidden="true"
                  >
                    {file.missing ? "未创建" : formatFileSize(file.size)}
                  </span>
                </button>
              );
            })}
          </div>
          <textarea
            aria-label="Agent Core 文件内容"
            className="agent-core-editor"
            value={props.fileContent}
            onChange={(e) => props.onChangeFileContent(e.target.value)}
            onKeyDown={(event) => {
              // Tab key inserts two spaces instead of focusing-out.
              // Shift+Tab still escapes (so keyboard users aren't
              // trapped); the editor is reachable from elsewhere by
              // role/label, so this is a pure ergonomic add.
              if (event.key === "Tab" && !event.shiftKey) {
                event.preventDefault();
                insertAtCursor(event.currentTarget, "  ", props.onChangeFileContent);
              }
            }}
            rows={14}
            disabled={!props.selectedFile || props.fileBusy}
          />
        </div>
        {props.fileStatus ? (
          <div className="agent-core-status">{props.fileStatus}</div>
        ) : null}
      </section>
    </div>
  );
}

/**
 * Pretty-print a file size in B / KB / MB. Mirrors the formatBytes
 * helper used by chat attachments so users see the same digits in
 * every surface. Returns "—" for unknown size (server omitted it).
 */
function formatFileSize(size: number | undefined): string {
  if (typeof size !== "number" || size < 0) return "—";
  if (size === 0) return "0 B";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Insert `insertion` at the textarea's current selection without
 * losing the caret position. We update via the controlled-value
 * callback because React owns the state; setSelectionRange after the
 * fact restores the caret to the end of the inserted run.
 */
function insertAtCursor(
  textarea: HTMLTextAreaElement,
  insertion: string,
  onChange: (next: string) => void,
) {
  const { selectionStart, selectionEnd, value } = textarea;
  const next =
    value.slice(0, selectionStart) +
    insertion +
    value.slice(selectionEnd);
  onChange(next);
  // Defer the selection restore to after React commits the new value.
  requestAnimationFrame(() => {
    textarea.selectionStart = selectionStart + insertion.length;
    textarea.selectionEnd = selectionStart + insertion.length;
  });
}
