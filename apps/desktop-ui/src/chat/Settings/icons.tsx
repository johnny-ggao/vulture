interface IconProps {
  size?: number;
}

const baseProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function GeneralIcon({ size = 14 }: IconProps = {}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...baseProps}>
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1.5v2M8 12.5v2M14.5 8h-2M3.5 8h-2M12.6 3.4l-1.4 1.4M4.8 11.2l-1.4 1.4M12.6 12.6l-1.4-1.4M4.8 4.8L3.4 3.4" />
    </svg>
  );
}

export function ModelIcon({ size = 14 }: IconProps = {}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...baseProps}>
      <path d="M8 2a3 3 0 0 0-3 3v.6a2.5 2.5 0 0 0-1.5 2.3v0a2.5 2.5 0 0 0 1.5 2.3v.4a2.5 2.5 0 0 0 3 2.4 2.5 2.5 0 0 0 3-2.4v-.4a2.5 2.5 0 0 0 1.5-2.3v0A2.5 2.5 0 0 0 11 5.6V5a3 3 0 0 0-3-3z" />
      <path d="M8 5v6" />
    </svg>
  );
}

export function MemoryIcon({ size = 14 }: IconProps = {}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...baseProps}>
      <ellipse cx="8" cy="3.5" rx="5" ry="1.8" />
      <path d="M3 3.5v9c0 1 2.2 1.8 5 1.8s5-.8 5-1.8v-9" />
      <path d="M3 8c0 1 2.2 1.8 5 1.8s5-.8 5-1.8" />
    </svg>
  );
}

export function PluginIcon({ size = 14 }: IconProps = {}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...baseProps}>
      <path d="M5.5 1.5v3M10.5 1.5v3" />
      <path d="M3.5 4.5h9v3a4.5 4.5 0 0 1-9 0v-3z" />
      <path d="M8 12v2.5" />
    </svg>
  );
}

export function BrowserIcon({ size = 14 }: IconProps = {}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...baseProps}>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M1.8 8h12.4" />
      <path d="M8 1.8c1.8 2 2.8 4.1 2.8 6.2 0 2.1-1 4.2-2.8 6.2" />
      <path d="M8 1.8c-1.8 2-2.8 4.1-2.8 6.2 0 2.1 1 4.2 2.8 6.2" />
    </svg>
  );
}

export function DiagnosticsIcon({ size = 14 }: IconProps = {}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...baseProps}>
      <path d="M3 3.5h10M3 8h10M3 12.5h7" />
      <path d="M2 3.5h.01M2 8h.01M2 12.5h.01" />
    </svg>
  );
}

export function ChannelIcon({ size = 14 }: IconProps = {}) {
  return (
    <svg viewBox="0 0 16 16" width={size} height={size} {...baseProps}>
      <path d="M2.5 3.5h11a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H6L3.5 14v-2.5h-1a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1z" />
    </svg>
  );
}
