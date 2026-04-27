/**
 * 32px absolute overlay above the sidebar + content panel.
 *
 * macOS native traffic lights are positioned automatically by Tauri's
 * `titleBarStyle: "Overlay"` (configured in tauri.conf.json). We only need
 * to reserve their space and provide a drag region for the rest of the bar.
 */
export function Titlebar() {
  return (
    <div className="titlebar" aria-hidden="true">
      <div className="titlebar-sidebar-chrome">
        {/* native traffic lights live here in the macOS overlay */}
      </div>
      <div className="titlebar-content-chrome" />
    </div>
  );
}
