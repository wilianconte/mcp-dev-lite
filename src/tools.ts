import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  DEFAULT_OUTPUT_PAGE_CHARS,
  readTextArtifact,
  storeTextArtifact,
} from "./output-store.js";

const MAX_PREVIEW_CHARS = DEFAULT_OUTPUT_PAGE_CHARS;
const PREVIEW_EDGE_CHARS = 14_000;
const DEFAULT_DIRECTORY_LIMIT = 200;
const MAX_DIRECTORY_LIMIT = 1_000;
const DEFAULT_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const DEFAULT_COMMAND_MAX_BUFFER_BYTES = 50 * 1024 * 1024;

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

interface CommandExecution {
  exitCode: number | string | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  maxBufferExceeded: boolean;
  errorMessage?: string;
}

function configuredPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} deve ser um numero positivo.`);
  return value;
}

function killProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform !== "win32") process.kill(-pid, signal);
    else process.kill(pid, signal);
  } catch {
    // O processo/grupo pode ja ter encerrado entre a verificacao e o sinal.
  }
}

function executeCommand(command: string, cwd: string, timeoutMs: number): Promise<CommandExecution> {
  return new Promise((resolve) => {
    let timedOut = false;
    let maxBufferExceeded = false;
    let spawnError: string | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    const maxBuffer = configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES);
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let capturedBytes = 0;

    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const terminateGroup = (): void => {
      killProcessGroup(child.pid, "SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => killProcessGroup(child.pid, "SIGKILL"), 1_000);
        killTimer.unref();
      }
    };

    const capture = (chunks: Buffer[], chunk: Buffer): void => {
      if (maxBufferExceeded) return;
      const remaining = maxBuffer - capturedBytes;
      if (remaining <= 0) {
        maxBufferExceeded = true;
        terminateGroup();
        return;
      }
      if (chunk.length <= remaining) {
        chunks.push(chunk);
        capturedBytes += chunk.length;
        return;
      }
      chunks.push(chunk.subarray(0, remaining));
      capturedBytes += remaining;
      maxBufferExceeded = true;
      terminateGroup();
    };

    child.stdout.on("data", (chunk: Buffer) => capture(stdoutChunks, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderrChunks, chunk));
    child.on("error", (err) => {
      spawnError = err.message;
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminateGroup();
    }, timeoutMs);
    timeoutTimer.unref();

    child.on("close", (code, signal) => {
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (timedOut || maxBufferExceeded) killProcessGroup(child.pid, "SIGKILL");
      const errorMessage = spawnError ?? (signal && !timedOut && !maxBufferExceeded ? `Processo encerrado por sinal ${signal}.` : undefined);
      resolve({
        exitCode: timedOut ? "timeout" : maxBufferExceeded ? "output_limit" : code ?? "desconhecido",
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
        timedOut,
        maxBufferExceeded,
        errorMessage,
      });
    });
  });
}

function previewText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_PREVIEW_CHARS) return { text, truncated: false };
  const omitted = text.length - PREVIEW_EDGE_CHARS * 2;
  return {
    text:
      `${text.slice(0, PREVIEW_EDGE_CHARS)}\n\n` +
      `[... ${omitted} caracteres omitidos nesta visualizacao ...]\n\n` +
      text.slice(-PREVIEW_EDGE_CHARS),
    truncated: true,
  };
}

/** Resolve ~ e caminhos relativos para um caminho absoluto. */
function resolvePath(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

async function commandResult(fullOutput: string): Promise<CallToolResult> {
  if (fullOutput.length <= MAX_PREVIEW_CHARS) return textResult(fullOutput);
  const artifact = await storeTextArtifact(fullOutput);
  const preview = previewText(fullOutput).text;
  return textResult(
    `${preview}\n\n` +
      `[saida completa preservada]\n` +
      `artifact_id: ${artifact.id}\n` +
      `total_chars: ${artifact.chars}\n` +
      `total_bytes: ${artifact.bytes}\n` +
      `Use read_command_output com artifact_id e offset para ler qualquer trecho sem perda.`,
  );
}

interface ImageInfo {
  mimeType: string;
  width?: number;
  height?: number;
}

function detectImage(buffer: Buffer): ImageInfo | null {
  if (
    buffer.length >= 24 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return {
      mimeType: "image/png",
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { mimeType: "image/jpeg" };
  }
  if (buffer.length >= 6 && ["GIF87a", "GIF89a"].includes(buffer.toString("ascii", 0, 6))) {
    return buffer.length >= 10
      ? { mimeType: "image/gif", width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) }
      : { mimeType: "image/gif" };
  }
  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return { mimeType: "image/webp" };
  }
  return null;
}

/** Definicao de uma ferramenta MCP: schema de entrada + resultado MCP multimodal. */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
}

export const tools: ToolDef[] = [
  {
    name: "run_command",
    title: "Executar comando",
    description:
      "Executa um comando de shell arbitrario na VM (bash). Use para node, npm, npx, gh, git, " +
      "instalacao de dependencias, build, testes, etc. Retorna stdout/stderr/exit code. Saidas acima de " +
      `${MAX_PREVIEW_CHARS} caracteres sao preservadas como artefato temporario e podem ser lidas integralmente com read_command_output.`,
    schema: {
      command: z.string().describe("Comando de shell completo a executar, ex: 'npm test' ou 'gh pr list'."),
      cwd: z
        .string()
        .optional()
        .describe("Diretorio de trabalho para o comando. Padrao: diretorio home do usuario."),
      timeout_ms: z
        .number()
        .int()
        .positive()
        .max(600_000)
        .optional()
        .describe("Timeout em milissegundos (max 600000). Padrao: 120000."),
    },
    handler: async (args) => {
      const command = args.command as string;
      const cwd = args.cwd ? resolvePath(args.cwd as string) : os.homedir();
      const timeout = (args.timeout_ms as number | undefined) ?? 120_000;
      const execution = await executeCommand(command, cwd, timeout);
      const parts = [
        `exit_code: ${execution.exitCode}${execution.timedOut ? " (timeout; grupo de processos encerrado)" : ""}`,
        execution.maxBufferExceeded
          ? `output_limit_exceeded: true (MCP_COMMAND_MAX_BUFFER_BYTES=${configuredPositiveNumber("MCP_COMMAND_MAX_BUFFER_BYTES", DEFAULT_COMMAND_MAX_BUFFER_BYTES)})`
          : "",
        execution.stdout ? `stdout:\n${execution.stdout}` : "stdout: (vazio)",
        execution.stderr ? `stderr:\n${execution.stderr}` : "",
        execution.errorMessage ? `error_message:\n${execution.errorMessage}` : "",
      ].filter(Boolean);
      return commandResult(parts.join("\n"));
    },
  },

  {
    name: "read_command_output",
    title: "Ler saida completa de comando",
    description:
      "Le uma pagina de uma saida grande preservada por run_command. Use artifact_id retornado pelo comando e avance pelo next_offset ate has_more=false.",
    schema: {
      artifact_id: z.string().uuid().describe("ID retornado por run_command quando a saida foi maior que o limite de visualizacao."),
      offset: z.number().int().nonnegative().optional().describe("Offset em caracteres. Padrao: 0."),
      limit: z
        .number()
        .int()
        .positive()
        .max(DEFAULT_OUTPUT_PAGE_CHARS)
        .optional()
        .describe(`Quantidade maxima de caracteres. Padrao/maximo: ${DEFAULT_OUTPUT_PAGE_CHARS}.`),
    },
    handler: async (args) => {
      const artifactId = args.artifact_id as string;
      const page = await readTextArtifact(
        artifactId,
        (args.offset as number | undefined) ?? 0,
        (args.limit as number | undefined) ?? DEFAULT_OUTPUT_PAGE_CHARS,
      );
      const header = [
        `artifact_id: ${artifactId}`,
        `offset: ${page.offset}`,
        `returned_chars: ${page.text.length}`,
        `total_chars: ${page.totalChars}`,
        `total_bytes: ${page.totalBytes}`,
        `has_more: ${page.nextOffset !== null}`,
        `next_offset: ${page.nextOffset ?? "null"}`,
      ].join("\n");
      return textResult(`${header}\n\n${page.text}`);
    },
  },

  {
    name: "read_file",
    title: "Ler arquivo",
    description:
      "Le arquivo de texto com metadata e paginacao. offset/limit operam por linhas; char_offset/char_limit operam por caracteres e sao uteis para arquivos minificados ou linhas muito longas.",
    schema: {
      path: z.string().describe("Caminho do arquivo a ler (absoluto, relativo ou com ~)."),
      offset: z.number().int().nonnegative().optional().describe("Linha inicial (base 1; 0 tambem equivale ao inicio por compatibilidade)."),
      limit: z.number().int().positive().optional().describe("Quantidade de linhas a partir de offset."),
      char_offset: z.number().int().nonnegative().optional().describe("Offset em caracteres, base 0."),
      char_limit: z
        .number()
        .int()
        .positive()
        .max(MAX_PREVIEW_CHARS)
        .optional()
        .describe(`Quantidade maxima de caracteres, ate ${MAX_PREVIEW_CHARS}.`),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const content = await fs.readFile(target, "utf8");
      const totalChars = content.length;
      const totalBytes = Buffer.byteLength(content, "utf8");
      const totalLines = content.split("\n").length;
      const hasLineMode = args.offset !== undefined || args.limit !== undefined;
      const hasCharMode = args.char_offset !== undefined || args.char_limit !== undefined;
      if (hasLineMode && hasCharMode) {
        throw new Error("Use paginacao por linhas (offset/limit) OU por caracteres (char_offset/char_limit), nao ambas na mesma chamada.");
      }

      if (hasLineMode) {
        const lines = content.split("\n");
        const startLine = Math.max(1, (args.offset as number | undefined) ?? 1);
        const requestedLimit = (args.limit as number | undefined) ?? lines.length;
        const start = Math.min(startLine - 1, lines.length);
        const end = Math.min(lines.length, start + requestedLimit);
        const selected = lines.slice(start, end).join("\n");
        const preview = previewText(selected);
        const header = [
          `path: ${target}`,
          `mode: lines`,
          `lines: ${start + 1}-${end} of ${totalLines}`,
          `total_chars: ${totalChars}`,
          `total_bytes: ${totalBytes}`,
          `selected_chars: ${selected.length}`,
          `content_truncated: ${preview.truncated}`,
          `has_more_lines: ${end < lines.length}`,
          `next_line_offset: ${end < lines.length ? end + 1 : "null"}`,
          preview.truncated ? "hint: a faixa selecionada excedeu o limite; use char_offset/char_limit para navegar sem perda." : "",
        ]
          .filter(Boolean)
          .join("\n");
        return textResult(`${header}\n\n${preview.text}`);
      }

      const charOffset = Math.min((args.char_offset as number | undefined) ?? 0, totalChars);
      const charLimit = (args.char_limit as number | undefined) ?? MAX_PREVIEW_CHARS;
      const end = Math.min(totalChars, charOffset + charLimit);
      const selected = content.slice(charOffset, end);
      const header = [
        `path: ${target}`,
        `mode: chars`,
        `char_offset: ${charOffset}`,
        `returned_chars: ${selected.length}`,
        `total_chars: ${totalChars}`,
        `total_lines: ${totalLines}`,
        `total_bytes: ${totalBytes}`,
        `has_more: ${end < totalChars}`,
        `next_char_offset: ${end < totalChars ? end : "null"}`,
      ].join("\n");
      return textResult(`${header}\n\n${selected}`);
    },
  },

  {
    name: "read_image",
    title: "Ler imagem",
    description:
      "Le PNG, JPEG, GIF ou WebP da VM e devolve a imagem como ImageContent nativo do MCP, junto com path, MIME, tamanho, dimensoes quando disponiveis e SHA-256. Ideal para screenshots e analise de UX.",
    schema: {
      path: z.string().describe("Caminho da imagem (absoluto, relativo ou com ~)."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const stat = await fs.stat(target);
      if (!stat.isFile()) throw new Error(`O caminho nao e um arquivo: ${target}`);
      const maxImageBytes = Number(process.env.MCP_MAX_IMAGE_BYTES ?? DEFAULT_MAX_IMAGE_BYTES);
      if (!Number.isFinite(maxImageBytes) || maxImageBytes <= 0) {
        throw new Error("MCP_MAX_IMAGE_BYTES deve ser um numero positivo.");
      }
      if (stat.size > maxImageBytes) {
        throw new Error(
          `Imagem muito grande: ${stat.size} bytes. Limite atual: ${maxImageBytes} bytes (MCP_MAX_IMAGE_BYTES).`,
        );
      }
      const buffer = await fs.readFile(target);
      const info = detectImage(buffer);
      if (!info) throw new Error(`Formato de imagem nao suportado ou arquivo invalido: ${target}`);
      const sha256 = createHash("sha256").update(buffer).digest("hex");
      const dimensions = info.width && info.height ? `${info.width}x${info.height}` : "nao detectadas";
      return {
        content: [
          {
            type: "text",
            text: [
              `path: ${target}`,
              `mime_type: ${info.mimeType}`,
              `bytes: ${buffer.length}`,
              `dimensions: ${dimensions}`,
              `sha256: ${sha256}`,
            ].join("\n"),
          },
          {
            type: "image",
            data: buffer.toString("base64"),
            mimeType: info.mimeType,
          },
        ],
      };
    },
  },

  {
    name: "write_file",
    title: "Escrever arquivo",
    description: "Cria ou sobrescreve um arquivo com o conteudo fornecido. Cria os diretorios pais se necessario.",
    schema: {
      path: z.string().describe("Caminho do arquivo a escrever."),
      content: z.string().describe("Conteudo completo a gravar no arquivo."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, args.content as string, "utf8");
      return textResult(`Arquivo gravado: ${target} (${(args.content as string).length} caracteres).`);
    },
  },

  {
    name: "edit_file",
    title: "Editar arquivo",
    description:
      "Substitui texto exato dentro de um arquivo. old_string deve ser unico no arquivo, a menos que replace_all seja true. Use para alteracoes cirurgicas sem reescrever o arquivo inteiro.",
    schema: {
      path: z.string().describe("Caminho do arquivo a editar."),
      old_string: z.string().describe("Texto exato a ser substituido (incluindo indentacao)."),
      new_string: z.string().describe("Texto que substituira old_string."),
      replace_all: z.boolean().optional().describe("Substituir todas as ocorrencias. Padrao: false."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const oldStr = args.old_string as string;
      const newStr = args.new_string as string;
      const replaceAll = (args.replace_all as boolean | undefined) ?? false;
      const content = await fs.readFile(target, "utf8");
      const occurrences = content.split(oldStr).length - 1;
      if (occurrences === 0) throw new Error(`old_string nao encontrado em ${target}.`);
      if (occurrences > 1 && !replaceAll) {
        throw new Error(`old_string aparece ${occurrences} vezes em ${target}. Torne-o unico ou use replace_all=true.`);
      }
      const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
      await fs.writeFile(target, updated, "utf8");
      return textResult(`Arquivo editado: ${target} (${replaceAll ? occurrences : 1} substituicao(oes)).`);
    },
  },

  {
    name: "list_directory",
    title: "Listar diretorio",
    description:
      "Lista arquivos e subdiretorios com paginacao. Retorna total, offset, has_more e next_offset para evitar respostas enormes.",
    schema: {
      path: z.string().optional().describe("Diretorio a listar. Padrao: diretorio home."),
      offset: z.number().int().nonnegative().optional().describe("Indice inicial, base 0. Padrao: 0."),
      limit: z
        .number()
        .int()
        .positive()
        .max(MAX_DIRECTORY_LIMIT)
        .optional()
        .describe(`Quantidade maxima de entradas. Padrao: ${DEFAULT_DIRECTORY_LIMIT}; maximo: ${MAX_DIRECTORY_LIMIT}.`),
    },
    handler: async (args) => {
      const target = args.path ? resolvePath(args.path as string) : os.homedir();
      const entries = (await fs.readdir(target, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
      const offset = Math.min((args.offset as number | undefined) ?? 0, entries.length);
      const limit = (args.limit as number | undefined) ?? DEFAULT_DIRECTORY_LIMIT;
      const end = Math.min(entries.length, offset + limit);
      const page = entries.slice(offset, end);
      const lines = page.map(
        (e) => `${e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file"}  ${e.name}`,
      );
      const header = [
        `path: ${target}`,
        `total: ${entries.length}`,
        `offset: ${offset}`,
        `returned: ${page.length}`,
        `has_more: ${end < entries.length}`,
        `next_offset: ${end < entries.length ? end : "null"}`,
      ].join("\n");
      return textResult(`${header}${lines.length ? `\n\n${lines.join("\n")}` : "\n\n(diretorio vazio ou pagina sem entradas)"}`);
    },
  },

  {
    name: "move_file",
    title: "Mover/renomear",
    description: "Move ou renomeia um arquivo ou diretorio. Cria o diretorio de destino se necessario.",
    schema: {
      source: z.string().describe("Caminho de origem."),
      destination: z.string().describe("Caminho de destino."),
    },
    handler: async (args) => {
      const src = resolvePath(args.source as string);
      const dest = resolvePath(args.destination as string);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.rename(src, dest);
      return textResult(`Movido: ${src} -> ${dest}.`);
    },
  },

  {
    name: "make_directory",
    title: "Criar diretorio",
    description: "Cria um diretorio, incluindo diretorios pais (mkdir -p).",
    schema: {
      path: z.string().describe("Caminho do diretorio a criar."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      await fs.mkdir(target, { recursive: true });
      return textResult(`Diretorio criado: ${target}.`);
    },
  },

  {
    name: "delete_path",
    title: "Excluir arquivo/diretorio",
    description: "Exclui um arquivo ou diretorio. Para diretorios, use recursive=true. Operacao irreversivel.",
    schema: {
      path: z.string().describe("Caminho a excluir."),
      recursive: z.boolean().optional().describe("Excluir diretorio e todo o conteudo. Padrao: false."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const recursive = (args.recursive as boolean | undefined) ?? false;
      await fs.rm(target, { recursive, force: false });
      return textResult(`Excluido: ${target}.`);
    },
  },
];
