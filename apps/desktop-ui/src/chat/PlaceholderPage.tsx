import type { ReactNode } from "react";

export interface PlaceholderPageProps {
  title: string;
  description: string;
  icon?: ReactNode;
  children?: ReactNode;
}

export function PlaceholderPage(props: PlaceholderPageProps) {
  return (
    <div className="page">
      <header className="page-header">
        <div>
          <h1>{props.title}</h1>
          <p>{props.description}</p>
        </div>
      </header>
      {props.children ?? (
        <div className="page-card">
          <div className="placeholder">
            {props.icon}
            <span>该页面在 Phase 4 启用 — 当前为占位</span>
          </div>
        </div>
      )}
    </div>
  );
}
