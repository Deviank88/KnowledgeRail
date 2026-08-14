import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as nodePath from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { DOCX_COLORS } from "./constants.js";
import type { DiagramRenderer, RenderedDiagramImage } from "./diagram-renderer.js";

const execFileAsync = promisify(execFile);
const MERMAID_PACKAGE = "@mermaid-js/mermaid-cli";
const MERMAID_CONFIG_VERSION = "2";
const MAX_SOURCE_CHARS = 50_000;
const MAX_CACHE_ENTRIES = 16;
const MAX_PARALLEL_RENDERS = 2;
const RENDER_TIMEOUT_MS = 60_000;
let cachedInstallation: MermaidCliInstallation | undefined;

export interface MermaidCliInstallation {
  cliPath: string;
  version: string;
}

interface MermaidPackageManifest {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
}

function mermaidBinPath(manifest: MermaidPackageManifest): string | undefined {
  if (typeof manifest.bin === "string") return manifest.bin;
  return manifest.bin?.mmdc;
}

/** Resolve mmdc from KnowledgeRail's dependency graph, never from the user's cwd. */
export function resolveMermaidCliInstallation(): MermaidCliInstallation {
  if (cachedInstallation) return cachedInstallation;

  const entryPath = fileURLToPath(import.meta.resolve(MERMAID_PACKAGE));
  let candidateDir = nodePath.dirname(entryPath);

  while (true) {
    const manifestPath = nodePath.join(candidateDir, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as MermaidPackageManifest;
      if (manifest.name === MERMAID_PACKAGE) {
        const binPath = mermaidBinPath(manifest);
        if (!binPath) {
          throw new Error(`La dipendenza ${MERMAID_PACKAGE} non dichiara il binario mmdc.`);
        }

        const cliPath = nodePath.resolve(candidateDir, binPath);
        if (!existsSync(cliPath)) {
          throw new Error(`Binario mmdc non trovato nel package installato: ${cliPath}`);
        }

        cachedInstallation = { cliPath, version: manifest.version ?? "unknown" };
        return cachedInstallation;
      }
    }

    const parentDir = nodePath.dirname(candidateDir);
    if (parentDir === candidateDir) break;
    candidateDir = parentDir;
  }

  throw new Error(`Impossibile individuare il package ${MERMAID_PACKAGE} a partire da ${entryPath}.`);
}

function pngDimensions(data: Buffer): { width: number; height: number } {
  const isPng =
    data.length >= 24 &&
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47;

  if (!isPng) {
    throw new Error("Mermaid ha prodotto un file non PNG.");
  }

  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
  };
}

function imageTransform(data: Buffer): { width: number; height: number } {
  const dimensions = pngDimensions(data);
  if (dimensions.width <= 0 || dimensions.height <= 0) {
    throw new Error("Mermaid ha prodotto un PNG con dimensioni non valide.");
  }

  const maxWidth = 602;
  const maxHeight = 760;
  const scale = Math.min(maxWidth / dimensions.width, maxHeight / dimensions.height);
  return {
    width: Math.max(1, Math.round(dimensions.width * scale)),
    height: Math.max(1, Math.round(dimensions.height * scale)),
  };
}

export function createMermaidRenderConfig(): Record<string, unknown> {
  return {
    theme: "base",
    look: "neo",
    securityLevel: "strict",
    secure: [
      "secure",
      "securityLevel",
      "startOnLoad",
      "maxTextSize",
      "maxEdges",
      "suppressErrorRendering",
      "theme",
      "look",
    ],
    maxTextSize: MAX_SOURCE_CHARS,
    maxEdges: 500,
    deterministicIds: true,
    deterministicIDSeed: "knowledge-rail-docx",
    suppressErrorRendering: true,
    htmlLabels: true,
    markdownAutoWrap: true,
    fontFamily: "Arial, Helvetica, sans-serif",
    fontSize: 16,
    themeVariables: {
      primaryColor: "#EAF2F8",
      primaryTextColor: `#${DOCX_COLORS.darkBlue}`,
      primaryBorderColor: `#${DOCX_COLORS.mediumBlue}`,
      lineColor: "#577590",
      secondaryColor: "#F5F7FA",
      tertiaryColor: "#FFF7E6",
      background: `#${DOCX_COLORS.white}`,
      mainBkg: "#EAF2F8",
      secondBkg: "#F5F7FA",
      clusterBkg: "#F8FAFC",
      clusterBorder: "#94A3B8",
      fontFamily: "Arial, Helvetica, sans-serif",
      fontSize: "16px",
      edgeLabelBackground: `#${DOCX_COLORS.white}`,
      nodeBorder: `#${DOCX_COLORS.mediumBlue}`,
      actorBkg: "#EAF2F8",
      actorBorder: `#${DOCX_COLORS.mediumBlue}`,
      actorTextColor: `#${DOCX_COLORS.darkBlue}`,
      signalColor: "#577590",
      signalTextColor: `#${DOCX_COLORS.body}`,
      labelBoxBkgColor: "#F8FAFC",
      labelBoxBorderColor: "#94A3B8",
      labelTextColor: `#${DOCX_COLORS.body}`,
      noteBkgColor: "#FFF7E6",
      noteBorderColor: "#D6A84B",
      noteTextColor: `#${DOCX_COLORS.body}`,
    },
    flowchart: {
      defaultRenderer: "elk",
      curve: "rounded",
      diagramPadding: 24,
      padding: 20,
      nodeSpacing: 60,
      rankSpacing: 75,
      wrappingWidth: 220,
      inheritDir: true,
    },
    elk: {
      mergeEdges: false,
      nodePlacementStrategy: "NETWORK_SIMPLEX",
      cycleBreakingStrategy: "GREEDY_MODEL_ORDER",
      considerModelOrder: "PREFER_NODES",
    },
    sequence: {
      diagramMarginX: 40,
      diagramMarginY: 24,
      actorMargin: 60,
      width: 160,
      height: 56,
      boxMargin: 12,
      boxTextMargin: 8,
      noteMargin: 14,
      messageMargin: 42,
      messageAlign: "center",
      mirrorActors: false,
      showSequenceNumbers: true,
      wrap: true,
      wrapPadding: 10,
      useMaxWidth: true,
    },
    er: {
      diagramPadding: 24,
      minEntityWidth: 120,
      minEntityHeight: 48,
      entityPadding: 12,
      nodeSpacing: 65,
      rankSpacing: 80,
      stroke: `#${DOCX_COLORS.mediumBlue}`,
      fill: "#F8FAFC",
      fontSize: 15,
      useMaxWidth: true,
    },
  };
}

function sandboxDisabled(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.KNOWLEDGE_RAIL_MERMAID_NO_SANDBOX?.trim() ?? "");
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async run<T>(operation: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await operation();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) {
      this.active++;
      next();
    }
  }
}

export interface MermaidCliRendererOptions {
  maxSourceChars?: number;
  maxCacheEntries?: number;
  timeoutMs?: number;
}

export class MermaidCliRenderer implements DiagramRenderer {
  readonly name = "mermaid-cli";
  private readonly cache = new Map<string, Promise<RenderedDiagramImage>>();
  private readonly semaphore = new Semaphore(MAX_PARALLEL_RENDERS);
  private readonly maxSourceChars: number;
  private readonly maxCacheEntries: number;
  private readonly timeoutMs: number;

  constructor(options: MermaidCliRendererOptions = {}) {
    this.maxSourceChars = options.maxSourceChars ?? MAX_SOURCE_CHARS;
    this.maxCacheEntries = options.maxCacheEntries ?? MAX_CACHE_ENTRIES;
    this.timeoutMs = options.timeoutMs ?? RENDER_TIMEOUT_MS;
  }

  async renderPng(source: string): Promise<RenderedDiagramImage> {
    if (source.trim() === "") {
      throw new Error("Il diagramma Mermaid è vuoto.");
    }
    if (source.length > this.maxSourceChars) {
      throw new Error(
        `Il diagramma Mermaid supera il limite di ${this.maxSourceChars} caratteri (${source.length}).`
      );
    }

    let installation: MermaidCliInstallation;
    try {
      installation = resolveMermaidCliInstallation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Dipendenza Mermaid CLI non disponibile. Reinstallare le dipendenze runtime di KnowledgeRail con npm install; ` +
        `non è richiesta un'installazione globale di mmdc. Dettaglio: ${message}`
      );
    }
    const key = createHash("sha256")
      .update(MERMAID_CONFIG_VERSION)
      .update("\0")
      .update(installation.version)
      .update("\0")
      .update(source)
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      this.cache.delete(key);
      this.cache.set(key, cached);
      return cached;
    }

    const rendered = this.semaphore.run(() => this.renderUncached(source, installation));
    this.cache.set(key, rendered);
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (!oldest) break;
      this.cache.delete(oldest);
    }

    try {
      return await rendered;
    } catch (error) {
      this.cache.delete(key);
      throw error;
    }
  }

  private async renderUncached(
    source: string,
    installation: MermaidCliInstallation
  ): Promise<RenderedDiagramImage> {
    const dir = await mkdtemp(nodePath.join(tmpdir(), "knowledge-rail-mermaid-"));
    const inputPath = nodePath.join(dir, "diagram.mmd");
    const outputPath = nodePath.join(dir, "diagram.png");
    const configPath = nodePath.join(dir, "mermaid-config.json");
    const puppeteerConfigPath = nodePath.join(dir, "puppeteer-config.json");

    try {
      await writeFile(inputPath, source, "utf8");
      await writeFile(configPath, JSON.stringify(createMermaidRenderConfig()), "utf8");

      const args = [
        installation.cliPath,
        "-i", inputPath,
        "-o", outputPath,
        "-c", configPath,
        "-b", "transparent",
        "-w", "1600",
        "-H", "1200",
        "-s", "1.5",
        "-q",
      ];

      if (sandboxDisabled()) {
        await writeFile(
          puppeteerConfigPath,
          JSON.stringify({ args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"] }),
          "utf8"
        );
        args.push("-p", puppeteerConfigPath);
      }

      await execFileAsync(process.execPath, args, {
        cwd: dir,
        timeout: this.timeoutMs,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
      });

      const data = await readFile(outputPath);
      return { data, ...imageTransform(data) };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Rendering Mermaid fallito con ${MERMAID_PACKAGE} ${installation.version}. ` +
        `Verificare la sintassi; se Chromium non è stato scaricato durante npm install, eseguire ` +
        `\`npx puppeteer browsers install chrome-headless-shell\`. Dettaglio: ${message}`
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

export const defaultDiagramRenderer: DiagramRenderer = new MermaidCliRenderer();

export async function renderMermaidPng(source: string): Promise<RenderedDiagramImage> {
  return defaultDiagramRenderer.renderPng(source);
}
