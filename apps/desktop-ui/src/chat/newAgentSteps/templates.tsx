/**
 * Template registry for the new-agent wizard. Each template seeds the
 * draft's `instructions` and pre-fills `description` if the user hasn't
 * typed their own. Icons are inline SVG so the wizard ships with no
 * additional asset round-trips.
 */

export type TemplateKey = "blank" | "writer" | "reviewer" | "shell";

export interface Template {
  key: TemplateKey;
  label: string;
  desc: string;
  instructions: string;
  Icon: () => JSX.Element;
}

export const TEMPLATES: ReadonlyArray<Template> = [
  { key: "blank",    label: "空白",     desc: "从零开始构建",                       instructions: "",                                                       Icon: BlankIcon },
  { key: "writer",   label: "写作助手", desc: "适合长文写作 + 编辑润色",            instructions: "你是一名细致的中文写作助手。",                          Icon: WriterIcon },
  { key: "reviewer", label: "代码审阅", desc: "审 PR、读代码、定位 bug",            instructions: "你是一名严谨的代码审阅者。",                            Icon: ReviewerIcon },
  { key: "shell",    label: "本地工具", desc: "读写文件、运行命令、检索网页",       instructions: "你是一名本地工作助手，可以使用文件、终端、网页和会话工具。", Icon: ShellIcon },
];

const ICON_PROPS = {
  viewBox: "0 0 24 24",
  width: 22,
  height: 22,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

function BlankIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="5" y="3.5" width="14" height="17" rx="2.5" />
      <path d="M9 8.5h6M9 12.5h6M9 16.5h4" />
    </svg>
  );
}

function WriterIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M4 19l3-1 11-11-2-2L5 16l-1 3z" />
      <path d="M14 6l2 2" />
    </svg>
  );
}

function ReviewerIcon() {
  return (
    <svg {...ICON_PROPS}>
      <path d="M9 4l-5 6 5 6" />
      <path d="M15 4l5 6-5 6" />
      <path d="M13 3l-2 18" />
    </svg>
  );
}

function ShellIcon() {
  return (
    <svg {...ICON_PROPS}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 10l3 2-3 2" />
      <path d="M12 14h5" />
    </svg>
  );
}
