import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_HARNESS_BUNDLE_REQUIRED_FILES } from "./contracts";
import { DEFAULT_HARNESS_ARTIFACT_DIRS } from "../shared";

export interface HarnessBundleManifestFile {
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  sha256: string;
}

export interface HarnessBundleRequiredFile {
  path: string;
  status: "present" | "missing";
}

export interface HarnessBundleManifest {
  schemaVersion: 1;
  generatedAt: string;
  artifactRoot: string;
  fileCount: number;
  totalBytes: number;
  requiredFiles: HarnessBundleRequiredFile[];
  files: HarnessBundleManifestFile[];
}

export function buildHarnessBundleManifest(options: {
  artifactRoot: string;
  generatedAt?: string;
  artifactDirNames?: readonly string[];
  requiredFiles?: readonly string[];
}): HarnessBundleManifest {
  const artifactRoot = resolve(options.artifactRoot);
  const artifactDirNames = options.artifactDirNames ?? DEFAULT_HARNESS_ARTIFACT_DIRS;
  const requiredFilePaths = options.requiredFiles ?? DEFAULT_HARNESS_BUNDLE_REQUIRED_FILES;
  const files = artifactDirNames
    .flatMap((dirName) => listHarnessBundleFiles(artifactRoot, dirName))
    .sort((left, right) => left.path.localeCompare(right.path, "en"));
  return {
    schemaVersion: 1,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    artifactRoot,
    fileCount: files.length,
    totalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
    requiredFiles: requiredFilePaths.map((path) => ({
      path,
      status: existsSync(join(artifactRoot, path)) ? "present" : "missing",
    })),
    files,
  };
}

export function writeHarnessBundleManifestReport(
  artifactDir: string,
  manifest: HarnessBundleManifest,
): { jsonPath: string; markdownPath: string } {
  mkdirSync(artifactDir, { recursive: true });
  const jsonPath = join(artifactDir, "bundle-manifest.json");
  const markdownPath = join(artifactDir, "bundle-manifest.md");
  const finalManifest: HarnessBundleManifest = {
    ...manifest,
    requiredFiles: manifest.requiredFiles.map((file) =>
      file.path === "harness-report/bundle-manifest.json"
        ? { ...file, status: "present" }
        : file,
    ),
  };
  writeFileSync(jsonPath, `${JSON.stringify(finalManifest, null, 2)}\n`);
  writeFileSync(markdownPath, renderHarnessBundleManifestMarkdown(finalManifest));
  return { jsonPath, markdownPath };
}

function listHarnessBundleFiles(artifactRoot: string, dirName: string): HarnessBundleManifestFile[] {
  const dir = join(artifactRoot, dirName);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return listFilesRecursive(dir)
    .filter((path) => {
      const relative = relativeArtifactPath(artifactRoot, path);
      return relative !== "harness-report/bundle-manifest.json" &&
        relative !== "harness-report/bundle-manifest.md";
    })
    .map((path) => {
      const stat = statSync(path);
      return {
        path: relativeArtifactPath(artifactRoot, path),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        sha256: sha256File(path),
      };
    });
}

function listFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function relativeArtifactPath(root: string, path: string): string {
  const normalizedRoot = resolve(root);
  const normalizedPath = resolve(path);
  const prefix = `${normalizedRoot}/`;
  return normalizedPath.startsWith(prefix)
    ? normalizedPath.slice(prefix.length)
    : normalizedPath;
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function renderHarnessBundleManifestMarkdown(manifest: HarnessBundleManifest): string {
  const missing = manifest.requiredFiles.filter((file) => file.status === "missing");
  const lines = [
    "# Harness Bundle Manifest",
    "",
    `Generated: ${manifest.generatedAt}`,
    `Artifact root: ${manifest.artifactRoot}`,
    `Files: ${manifest.fileCount}`,
    `Bytes: ${manifest.totalBytes}`,
    `Missing required files: ${missing.length}`,
    "",
    "## Required Files",
    "",
  ];
  for (const file of manifest.requiredFiles) {
    lines.push(`- ${file.status.toUpperCase()} ${file.path}`);
  }
  lines.push("", "## Files", "");
  if (manifest.files.length === 0) {
    lines.push("- None");
  } else {
    for (const file of manifest.files) {
      lines.push(`- ${file.path} (${file.sizeBytes} bytes, sha256 ${file.sha256})`);
    }
  }
  return `${lines.join("\n")}\n`;
}
