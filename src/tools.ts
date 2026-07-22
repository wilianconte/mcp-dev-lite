import { exec } from "node:child_process";
import { promisify } from "node:util";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { z } from "zod";

const execAsync = promisify(exec);

/** Limite de saida devolvido ao agente para nao estourar a janela de contexto. */
const MAX_OUTPUT_CHARS = 30_000;

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  const head = text.slice(0, MAX_OUTPUT_CHARS);
  return `${head}\n\n[... saida truncada em ${MAX_OUTPUT_CHARS} caracteres de ${text.length} ...]`;
}

/** Resolve ~ e caminhos relativos para um caminho absoluto. */
function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(os.homedir(), p.slice(1));
  }
  return path.resolve(p);
}

/**
 * Definicao de uma ferramenta MCP: schema de entrada + handler.
 * O handler devolve texto que sera empacotado como conteudo da resposta MCP.
 */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  schema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<string>;
}

export const tools: ToolDef[] = [
  {
    name: "run_command",
    title: "Executar comando",
    description:
      "Executa um comando de shell arbitrario na VM (bash). Use para node, npm, npx, gh, git, " +
      "instalacao de dependencias, build, testes, etc. Retorna stdout, stderr e o codigo de saida. " +
      "O comando roda de forma nao-interativa; nao inicie processos que ficam em foreground sem timeout.",
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
      try {
        const { stdout, stderr } = await execAsync(command, {
          cwd,
          timeout,
          maxBuffer: 10 * 1024 * 1024,
          shell: "/bin/bash",
        });
        const out = [
          `exit_code: 0`,
          stdout ? `stdout:\n${stdout}` : "stdout: (vazio)",
          stderr ? `stderr:\n${stderr}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        return truncate(out);
      } catch (err) {
        const e = err as { code?: number; stdout?: string; stderr?: string; message?: string; killed?: boolean };
        const parts = [
          `exit_code: ${e.code ?? "desconhecido"}${e.killed ? " (processo morto por timeout)" : ""}`,
          e.stdout ? `stdout:\n${e.stdout}` : "",
          e.stderr ? `stderr:\n${e.stderr}` : "",
          !e.stdout && !e.stderr && e.message ? `erro:\n${e.message}` : "",
        ].filter(Boolean);
        return truncate(parts.join("\n"));
      }
    },
  },

  {
    name: "read_file",
    title: "Ler arquivo",
    description: "Le o conteudo de um arquivo de texto. Retorna o conteudo, opcionalmente uma faixa de linhas.",
    schema: {
      path: z.string().describe("Caminho do arquivo a ler (absoluto, relativo ou com ~)."),
      offset: z.number().int().nonnegative().optional().describe("Linha inicial (base 1) para leitura parcial."),
      limit: z.number().int().positive().optional().describe("Quantidade de linhas a ler a partir de offset."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const content = await fs.readFile(target, "utf8");
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      if (offset === undefined && limit === undefined) return truncate(content);
      const lines = content.split("\n");
      const start = offset ? offset - 1 : 0;
      const end = limit ? start + limit : lines.length;
      return truncate(lines.slice(start, end).join("\n"));
    },
  },

  {
    name: "write_file",
    title: "Escrever arquivo",
    description:
      "Cria ou sobrescreve um arquivo com o conteudo fornecido. Cria os diretorios pais se necessario.",
    schema: {
      path: z.string().describe("Caminho do arquivo a escrever."),
      content: z.string().describe("Conteudo completo a gravar no arquivo."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, args.content as string, "utf8");
      return `Arquivo gravado: ${target} (${(args.content as string).length} caracteres).`;
    },
  },

  {
    name: "edit_file",
    title: "Editar arquivo",
    description:
      "Substitui texto exato dentro de um arquivo. old_string deve ser unico no arquivo, a menos que " +
      "replace_all seja true. Use para alteracoes cirurgicas sem reescrever o arquivo inteiro.",
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
      if (occurrences === 0) {
        throw new Error(`old_string nao encontrado em ${target}.`);
      }
      if (occurrences > 1 && !replaceAll) {
        throw new Error(
          `old_string aparece ${occurrences} vezes em ${target}. Torne-o unico ou use replace_all=true.`,
        );
      }
      const updated = replaceAll ? content.split(oldStr).join(newStr) : content.replace(oldStr, newStr);
      await fs.writeFile(target, updated, "utf8");
      return `Arquivo editado: ${target} (${replaceAll ? occurrences : 1} substituicao(oes)).`;
    },
  },

  {
    name: "list_directory",
    title: "Listar diretorio",
    description: "Lista arquivos e subdiretorios de um caminho, indicando o tipo de cada entrada.",
    schema: {
      path: z.string().optional().describe("Diretorio a listar. Padrao: diretorio home."),
    },
    handler: async (args) => {
      const target = args.path ? resolvePath(args.path as string) : os.homedir();
      const entries = await fs.readdir(target, { withFileTypes: true });
      if (entries.length === 0) return `${target} esta vazio.`;
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((e) => `${e.isDirectory() ? "dir " : e.isSymbolicLink() ? "link" : "file"}  ${e.name}`);
      return `${target}:\n${lines.join("\n")}`;
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
      return `Movido: ${src} -> ${dest}.`;
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
      return `Diretorio criado: ${target}.`;
    },
  },

  {
    name: "delete_path",
    title: "Excluir arquivo/diretorio",
    description:
      "Exclui um arquivo ou diretorio. Para diretorios, use recursive=true. Operacao irreversivel.",
    schema: {
      path: z.string().describe("Caminho a excluir."),
      recursive: z.boolean().optional().describe("Excluir diretorio e todo o conteudo. Padrao: false."),
    },
    handler: async (args) => {
      const target = resolvePath(args.path as string);
      const recursive = (args.recursive as boolean | undefined) ?? false;
      await fs.rm(target, { recursive, force: false });
      return `Excluido: ${target}.`;
    },
  },
];
