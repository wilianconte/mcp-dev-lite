import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import express, { type Request, type Response, Router } from "express";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import {
  InvalidGrantError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";

// Tempos de vida (segundos).
const ACCESS_TOKEN_TTL = 2 * 60 * 60; // 2h
const REFRESH_TOKEN_TTL = 30 * 24 * 60 * 60; // 30 dias
const CODE_TTL = 10 * 60; // 10 min
const PENDING_TTL = 10 * 60; // 10 min

interface StoredToken {
  clientId: string;
  scopes: string[];
  expiresAt: number; // epoch em segundos
}

/** Estado persistido em disco: clients registrados via DCR e tokens emitidos. */
interface PersistedState {
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, StoredToken>;
  refreshTokens: Record<string, StoredToken>;
}

interface PendingAuthorization {
  client: OAuthClientInformationFull;
  params: AuthorizationParams;
  expiresAt: number;
}

interface AuthorizationCode {
  clientId: string;
  codeChallenge: string;
  redirectUri: string;
  scopes: string[];
  expiresAt: number;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function newToken(): string {
  return randomBytes(32).toString("hex");
}

/** Comparacao em tempo constante (via hash, para aceitar tamanhos diferentes). */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

import { chmod, rename, writeFile } from "node:fs/promises";
import type { McpMonitor } from "./monitor.js";

/**
 * Servidor OAuth 2.1 self-hosted para o mcp-dev-agent, no formato que o
 * ChatGPT (e outros clientes MCP) esperam: Dynamic Client Registration,
 * authorization code + PKCE e refresh token.
 *
 * A aprovacao exige a senha de acesso (OAUTH_APPROVAL_PASSWORD, com fallback
 * para MCP_AUTH_TOKEN) — sem isso, o DCR permitiria a qualquer um obter tokens.
 *
 * Clients e tokens sao persistidos em data/oauth-state.json para sobreviver a
 * restarts; codigos de autorizacao e aprovacoes pendentes sao efemeros.
 */
export class DevAgentOAuthProvider implements OAuthServerProvider {
  private state: PersistedState = { clients: {}, accessTokens: {}, refreshTokens: {} };
  private readonly statePath: string;
  private readonly approvalPassword: string;
  private readonly monitor?: McpMonitor;
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly codes = new Map<string, AuthorizationCode>();
  // Limite de tentativas de senha por IP: 10 falhas / 15 min.
  private readonly failedAttempts = new Map<string, { count: number; resetAt: number }>();
  private saveChain: Promise<void> = Promise.resolve();
  private saveScheduled = false;

  constructor(dataDir: string, approvalPassword: string, monitor?: McpMonitor) {
    this.approvalPassword = approvalPassword;
    this.monitor = monitor;
    this.statePath = path.join(dataDir, "oauth-state.json");
    mkdirSync(dataDir, { recursive: true });
    try {
      this.state = JSON.parse(readFileSync(this.statePath, "utf8")) as PersistedState;
    } catch {
      // Sem estado anterior (primeira execucao) ou arquivo corrompido: comeca vazio.
    }
    this.pruneExpired();
  }

  /** Agenda persistencia assincrona coalescida para nao bloquear o event loop em chamadas concorrentes. */
  private save(): Promise<void> {
    if (this.saveScheduled) return this.saveChain;
    this.saveScheduled = true;
    this.saveChain = this.saveChain
      .then(async () => {
        this.saveScheduled = false;
        const payload = JSON.stringify(this.state);
        const tmp = `${this.statePath}.tmp`;
        await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
        await chmod(tmp, 0o600).catch(() => undefined);
        await rename(tmp, this.statePath);
      })
      .catch((err) => {
        this.saveScheduled = false;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[oauth] falha ao persistir estado: ${message}`);
      });
    return this.saveChain;
  }

  private pruneExpired(): void {
    const now = nowSec();
    let stateDirty = false;
    for (const map of [this.state.accessTokens, this.state.refreshTokens]) {
      for (const [token, info] of Object.entries(map)) {
        if (info.expiresAt <= now) {
          delete map[token];
          stateDirty = true;
        }
      }
    }
    for (const [id, p] of this.pending) if (p.expiresAt <= now) this.pending.delete(id);
    for (const [code, c] of this.codes) if (c.expiresAt <= now) this.codes.delete(code);
    for (const [ip, att] of this.failedAttempts) if (att.resetAt <= now) this.failedAttempts.delete(ip);
    if (stateDirty) void this.save();
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId: string) => this.state.clients[clientId],
      registerClient: async (client: OAuthClientInformationFull) => {
        this.state.clients[client.client_id] = client;
        await this.save();
        console.log(
          `[oauth] client registrado: ${client.client_id} (${client.client_name ?? "sem nome"}) | ` +
            `redirect_uris: ${client.redirect_uris.join(", ")}`,
        );
        this.monitor?.recordEvent({
          category: "oauth",
          event: "oauth.register",
          clientId: client.client_id,
          summary: `Client registrado: ${client.client_name ?? client.client_id}`,
          args: { client_name: client.client_name, redirect_uris: client.redirect_uris },
        });
        return client;
      },
    };
  }

  /** Mostra a pagina de aprovacao; a emissao do code acontece em /oauth/approve. */
  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    this.pruneExpired();
    const pendingId = newToken();
    this.pending.set(pendingId, { client, params, expiresAt: nowSec() + PENDING_TTL });
    res
      .status(200)
      .type("html")
      .send(this.approvalPage(pendingId, client, null));
  }

  private approvalPage(
    pendingId: string,
    client: OAuthClientInformationFull,
    error: string | null,
  ): string {
    const clientName = escapeHtml(client.client_name ?? client.client_id);
    return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Autorizar acesso — mcp-dev-agent</title>
<style>
  body { font-family: system-ui, sans-serif; background: #f4f4f5; margin: 0;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; }
  .card { background: #fff; border-radius: 12px; padding: 32px; max-width: 380px; width: 90%;
          box-shadow: 0 2px 12px rgba(0,0,0,.08); }
  h1 { font-size: 1.1rem; margin: 0 0 8px; }
  p { color: #52525b; font-size: .9rem; line-height: 1.5; }
  strong { color: #18181b; }
  input[type=password] { width: 100%; box-sizing: border-box; padding: 10px 12px; margin: 12px 0;
          border: 1px solid #d4d4d8; border-radius: 8px; font-size: 1rem; }
  button { width: 100%; padding: 10px; border: 0; border-radius: 8px; background: #18181b;
           color: #fff; font-size: 1rem; cursor: pointer; }
  .error { color: #b91c1c; font-size: .85rem; }
  .warn { background: #fef3c7; border-radius: 8px; padding: 10px 12px; font-size: .8rem; color: #78350f; }
</style>
</head>
<body>
<div class="card">
  <h1>Autorizar acesso ao mcp-dev-agent</h1>
  <p><strong>${clientName}</strong> quer acesso as ferramentas de desenvolvimento desta VM
     (executar comandos, ler e editar arquivos).</p>
  <p class="warn">Autorize apenas se foi voce quem iniciou esta conexao agora.</p>
  ${error ? `<p class="error">${escapeHtml(error)}</p>` : ""}
  <form method="post" action="/oauth/approve">
    <input type="hidden" name="pending_id" value="${pendingId}">
    <input type="password" name="password" placeholder="Senha de acesso" autofocus required autocomplete="off">
    <button type="submit">Autorizar</button>
  </form>
</div>
</body>
</html>`;
  }

  /** Router com o endpoint que recebe a senha e finaliza a autorizacao. */
  approvalRouter(): Router {
    const router = Router();
    router.post(
      "/oauth/approve",
      express.urlencoded({ extended: false }),
      (req: Request, res: Response) => {
        this.pruneExpired();
        const pendingId = String(req.body?.pending_id ?? "");
        const password = String(req.body?.password ?? "");
        const pending = this.pending.get(pendingId);
        if (!pending) {
          res
            .status(400)
            .type("html")
            .send("Solicitacao de autorizacao expirada ou invalida. Reinicie a conexao no cliente.");
          return;
        }

        const ip = req.ip ?? "?";
        const attempts = this.failedAttempts.get(ip);
        if (attempts && attempts.count >= 10 && attempts.resetAt > nowSec()) {
          res.status(429).type("html").send("Muitas tentativas. Aguarde 15 minutos.");
          return;
        }

        if (!safeEqual(password, this.approvalPassword)) {
          const current = attempts && attempts.resetAt > nowSec() ? attempts : { count: 0, resetAt: nowSec() + 15 * 60 };
          current.count += 1;
          this.failedAttempts.set(ip, current);
          console.warn(`[oauth] senha incorreta na aprovacao | ip ${ip} | tentativa ${current.count}`);
          this.monitor?.recordEvent({
            category: "oauth",
            event: "oauth.approve_failed",
            status: "error",
            clientId: pending.client.client_id,
            remoteIp: ip,
            error: `Senha incorreta na aprovacao OAuth (tentativa ${current.count})`,
          });
          res.status(401).type("html").send(this.approvalPage(pendingId, pending.client, "Senha incorreta."));
          return;
        }

        this.failedAttempts.delete(ip);
        this.pending.delete(pendingId);
        const code = newToken();
        this.codes.set(code, {
          clientId: pending.client.client_id,
          codeChallenge: pending.params.codeChallenge,
          redirectUri: pending.params.redirectUri,
          scopes: pending.params.scopes ?? [],
          expiresAt: nowSec() + CODE_TTL,
        });
        const redirect = new URL(pending.params.redirectUri);
        redirect.searchParams.set("code", code);
        if (pending.params.state) redirect.searchParams.set("state", pending.params.state);
        console.log(`[oauth] autorizacao aprovada para client ${pending.client.client_id}`);
        this.monitor?.recordEvent({
          category: "oauth",
          event: "oauth.approve",
          clientId: pending.client.client_id,
          remoteIp: ip,
          summary: `Autorizacao aprovada para ${pending.client.client_name ?? pending.client.client_id}`,
        });
        res.redirect(302, redirect.href);
      },
    );
    return router;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id || code.expiresAt <= nowSec()) {
      throw new InvalidGrantError("Codigo de autorizacao invalido ou expirado.");
    }
    return code.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
  ): Promise<OAuthTokens> {
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id || code.expiresAt <= nowSec()) {
      throw new InvalidGrantError("Codigo de autorizacao invalido ou expirado.");
    }
    if (redirectUri && redirectUri !== code.redirectUri) {
      throw new InvalidGrantError("redirect_uri diferente do usado na autorizacao.");
    }
    this.codes.delete(authorizationCode); // uso unico
    return this.issueTokens(client.client_id, code.scopes, "authorization_code");
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
  ): Promise<OAuthTokens> {
    this.pruneExpired();
    const stored = this.state.refreshTokens[refreshToken];
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt <= nowSec()) {
      throw new InvalidGrantError("Refresh token invalido ou expirado.");
    }
    // Rotacao: o refresh token antigo deixa de valer.
    delete this.state.refreshTokens[refreshToken];
    return this.issueTokens(client.client_id, scopes?.length ? scopes : stored.scopes, "refresh_token");
  }

  private async issueTokens(
    clientId: string,
    scopes: string[],
    grantType: "authorization_code" | "refresh_token",
  ): Promise<OAuthTokens> {
    const accessToken = newToken();
    const refreshToken = newToken();
    const now = nowSec();
    this.state.accessTokens[accessToken] = { clientId, scopes, expiresAt: now + ACCESS_TOKEN_TTL };
    this.state.refreshTokens[refreshToken] = { clientId, scopes, expiresAt: now + REFRESH_TOKEN_TTL };
    await this.save();
    this.monitor?.recordEvent({
      category: "oauth",
      event: grantType === "refresh_token" ? "oauth.refresh" : "oauth.token",
      clientId,
      summary: `Tokens emitidos via ${grantType}`,
    });
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: ACCESS_TOKEN_TTL,
      refresh_token: refreshToken,
      scope: scopes.join(" ") || undefined,
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const stored = this.state.accessTokens[token];
    if (!stored || stored.expiresAt <= nowSec()) {
      throw new InvalidTokenError("Access token invalido ou expirado.");
    }
    return {
      token,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const { token } = request;
    for (const map of [this.state.accessTokens, this.state.refreshTokens]) {
      if (map[token]?.clientId === client.client_id) delete map[token];
    }
    await this.save();
    this.monitor?.recordEvent({
      category: "oauth",
      event: "oauth.revoke",
      clientId: client.client_id,
      summary: `Token revogado para ${client.client_id}`,
    });
  }
}
