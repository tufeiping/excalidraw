/**
 * Client for the deployment's LLM relay (`/api/llm/*`).
 *
 * The relay sits on the same origin as this app, so authentication is the
 * ordinary session cookie — nothing secret is handed to the browser. It also
 * hands out the CSRF token the relay requires on POSTs, plus the models the
 * signed-in account may use.
 */

import { getNeBaseUrl } from "../aiConfig";

import { AgentRequestError } from "./errors";

export type NeUser = {
  sub: string;
  name?: string;
};

/** Mirrors the gateway account object, already camelCased by the relay. */
export type NeBalance = {
  remaining: number;
  totalIncome?: number;
  totalExpense?: number;
  totalWriteOff?: number;
  purchased?: number;
  gift?: number;
  migration?: number;
  debt?: number;
  updatedAt?: string | null;
};

export type NeUsage = {
  calls: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  byModel?: { model: string; calls: number; totalTokens: number }[];
};

export type NeFailureReason =
  | "not_logged_in"
  | "ne_not_linked"
  | "reauth_required"
  | "unavailable"
  | "no_llm_access";

export type NeSession =
  | {
      ok: true;
      user: NeUser;
      models: string[];
      defaultModel: string;
      csrfToken: string;
      /** unix seconds */
      expiresAt?: number;
      balance?: NeBalance | null;
      usage?: NeUsage | null;
    }
  | {
      ok: false;
      /**
       * `not_logged_in`    — no FlyLaTeX session at all
       * `ne_not_linked`    — session is fine, but this account never signed in
       *                      through NE, so no NE token exists for it
       * `reauth_required`  — the NE token is dead, sign in through NE again
       * `no_llm_access`    — the NE account itself is not allowed to use LLM
       */
      reason: NeFailureReason;
    };

/** How long a successful session probe is reused before asking again. */
const SESSION_TTL_MS = 60_000;

let cache: { at: number; value: NeSession } | null = null;

export const invalidateNeSession = () => {
  cache = null;
};

const KNOWN_REASONS = [
  "not_logged_in",
  "ne_not_linked",
  "reauth_required",
  "no_llm_access",
] as const;

const parseReason = (payload: any): NeSession & { ok: false } =>
  ({
    ok: false,
    reason: (KNOWN_REASONS as readonly string[]).includes(payload?.reason)
      ? payload.reason
      : "unavailable",
  } as NeSession & { ok: false });

const parseSession = (payload: any): NeSession => {
  if (!payload || payload.ok !== true || !payload.user?.sub) {
    return parseReason(payload);
  }
  return {
    ok: true,
    user: {
      sub: String(payload.user.sub),
      name: payload.user.name ? String(payload.user.name) : undefined,
    },
    models: Array.isArray(payload.models)
      ? payload.models.filter((id: unknown) => typeof id === "string")
      : [],
    defaultModel:
      typeof payload.defaultModel === "string" ? payload.defaultModel : "",
    csrfToken: typeof payload.csrfToken === "string" ? payload.csrfToken : "",
    expiresAt:
      typeof payload.expiresAt === "number" ? payload.expiresAt : undefined,
    balance: payload.balance ?? null,
    usage: payload.usage ?? null,
  };
};

/**
 * Probing is deliberately quiet: it never throws for the expected states
 * (signed out, relay missing), because the settings dialog and the agent panel
 * both show those as hints rather than errors.
 */
export const getNeSession = async ({
  force = false,
}: { force?: boolean } = {}): Promise<NeSession> => {
  if (!force && cache && Date.now() - cache.at < SESSION_TTL_MS) {
    return cache.value;
  }
  let value: NeSession;
  try {
    const response = await fetch(`${getNeBaseUrl()}/session`, {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    });
    if (response.status === 401) {
      // the relay separates "no session" from "session without an NE token";
      // both are 401 but they need different advice
      value = parseReason(await response.json().catch(() => null));
    } else if (response.status === 403) {
      // the relay only uses 403 for "this account has no LLM access"; anything
      // else (a CSRF rejection, a proxy in between) is not actionable
      const body: any = await response.json().catch(() => null);
      value = {
        ok: false,
        reason:
          body?.reason === "no_llm_access" ? "no_llm_access" : "unavailable",
      };
    } else if (!response.ok) {
      value = { ok: false, reason: "unavailable" };
    } else {
      value = parseSession(await response.json());
    }
  } catch {
    value = { ok: false, reason: "unavailable" };
  }
  cache = { at: Date.now(), value };
  return value;
};

export type NeTarget = {
  url: string;
  headers: Record<string, string>;
  model: string;
};

/**
 * Resolves everything a request needs from the relay. Throws an
 * `AgentRequestError` with status 401 when the user has to sign in first, so
 * the agent surfaces the same "unauthorized" path it already handles.
 */
export const resolveNeTarget = async (
  model: string,
  messageFor: (reason: NeFailureReason) => string,
): Promise<NeTarget> => {
  const session = await getNeSession();
  if (!session.ok) {
    throw new AgentRequestError(messageFor(session.reason), 401);
  }
  return {
    url: `${getNeBaseUrl()}/v1/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": session.csrfToken,
    },
    model: model || session.defaultModel,
  };
};
