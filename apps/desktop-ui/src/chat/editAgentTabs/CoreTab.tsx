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
            {props.files.map((file) => (
              <button
                key={file.name}
                type="button"
                className="agent-core-file"
                data-active={file.name === props.selectedFile ? "true" : undefined}
                onClick={() => props.onSelectFile(file.name)}
                aria-pressed={file.name === props.selectedFile}
              >
                {file.name}
              </button>
            ))}
          </div>
          <textarea
            aria-label="Agent Core 文件内容"
            className="agent-core-editor"
            value={props.fileContent}
            onChange={(e) => props.onChangeFileContent(e.target.value)}
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
