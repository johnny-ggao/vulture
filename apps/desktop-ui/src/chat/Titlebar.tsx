/**
 * 32px absolute overlay above the sidebar + content panel.
 *
 * Tauri 2 recognizes drag regions via the `data-tauri-drag-region` attribute
 * (not the older `-webkit-app-region: drag` CSS, which our renderer ignores).
 * macOS native traffic lights are positioned automatically by Tauri's
 * `titleBarStyle: "Overlay"` (set in tauri.conf.json).
 */
export function Titlebar() {
  return (
    <div className="titlebar" aria-hidden="true">
      <div className="titlebar-sidebar-chrome" data-tauri-drag-region>
        {/* native traffic lights live here in the macOS overlay */}
      </div>
      <div className="titlebar-content-chrome" data-tauri-drag-region />
    </div>
  );
}
