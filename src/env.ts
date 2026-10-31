export interface Env {
  DB: D1Database;
  FILES: R2Bucket;

  APP_ENV: string; // development | test | production
  APP_URL: string;
  APP_TIMEZONE: string;
  LIVE_MODE: string;

  BETTER_AUTH_SECRET: string;
  OPERATOR_EMAILS: string;

  EMAIL_PROVIDER: string; // dev | resend | disabled
  EMAIL_FROM: string;
  RESEND_API_KEY?: string;

  AI_PROVIDER: string; // none | openai | anthropic | fake | fake-fail | fake-inject
  AI_MODEL: string;
  AI_EFFORT?: string;
  AI_PRICE_INPUT_USD_PER_MTOK?: string;
  AI_PRICE_OUTPUT_USD_PER_MTOK?: string;
  AI_MONTHLY_BUDGET_USD?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  AGENT_SPEC_ID?: string;

  DISPATCH_IMMEDIATE?: string;
  MAX_UPLOAD_BYTES?: string;
}

export interface AppConfig {
  env: "development" | "test" | "production";
  appUrl: string;
  origin: string;
  timezone: string;
  liveMode: boolean;
  operatorEmails: string[];
  emailProvider: "dev" | "resend" | "disabled";
  emailFrom: string;
  aiProvider: "none" | "openai" | "anthropic" | "fake" | "fake-fail" | "fake-inject";
  aiModel: string;
  aiEffort: "low" | "medium" | "high" | "xhigh" | "max";
  aiPriceInPerMTok: number | null;
  aiPriceOutPerMTok: number | null;
  aiMonthlyBudgetUsd: number;
  agentSpecId: string;
  dispatchImmediate: boolean;
  maxUploadBytes: number;
}

export class ConfigError extends Error {}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

const cache = new WeakMap<object, AppConfig>();

/**
 * Parses and validates configuration. Refuses unsafe combinations in
 * production (dev mailbox, fake AI, weak secret, non-HTTPS URL, live mode
 * before tax/payment rules exist).
 */
export function config(env: Env): AppConfig {
  const hit = cache.get(env);
  if (hit) return hit;
  const appEnv = env.APP_ENV;
  if (appEnv !== "development" && appEnv !== "test" && appEnv !== "production") {
    throw new ConfigError("APP_ENV must be development, test or production");
  }
  const emailProvider = env.EMAIL_PROVIDER;
  if (emailProvider !== "dev" && emailProvider !== "resend" && emailProvider !== "disabled") {
    throw new ConfigError("EMAIL_PROVIDER must be dev, resend or disabled");
  }
  const aiProvider = env.AI_PROVIDER || "none";
  const allowedAi = ["none", "openai", "anthropic", "fake", "fake-fail", "fake-inject"];
  if (!allowedAi.includes(aiProvider)) throw new ConfigError(`AI_PROVIDER must be one of ${allowedAi.join(", ")}`);
  const effort = env.AI_EFFORT || "medium";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new ConfigError("AI_EFFORT is invalid");
  let url: URL;
  try {
    url = new URL(env.APP_URL);
  } catch {
    throw new ConfigError("APP_URL must be an absolute URL");
  }
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new ConfigError("BETTER_AUTH_SECRET must be set (at least 32 characters)");
  }
  // The dev mailbox shows sign-in links to anyone who can reach the site, so
  // it may only run on a local address — even if APP_ENV was left at
  // "development" by mistake in a deployment.
  const localHost = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (emailProvider === "dev" && !localHost) {
    throw new ConfigError("EMAIL_PROVIDER=dev is only allowed when APP_URL is localhost");
  }
  const liveMode = env.LIVE_MODE === "true";
  if (appEnv === "production") {
    if (url.protocol !== "https:") throw new ConfigError("APP_URL must use https in production");
    if (emailProvider === "dev") throw new ConfigError("EMAIL_PROVIDER=dev is not allowed in production");
    if (aiProvider.startsWith("fake")) throw new ConfigError("Fake AI providers are not allowed in production");
    if (emailProvider === "resend" && !env.RESEND_API_KEY) throw new ConfigError("RESEND_API_KEY is required");
  }
  if (liveMode) {
    // Live operation needs explicit tax configuration and payment rules that
    // have not been decided. Refuse until those decisions are implemented.
    throw new ConfigError("LIVE_MODE=true is not supported yet: tax and payment rules are unresolved");
  }
  const operatorEmails = (env.OPERATOR_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  const cfg: AppConfig = {
    env: appEnv,
    appUrl: env.APP_URL.replace(/\/$/, ""),
    origin: url.origin,
    timezone: env.APP_TIMEZONE || "America/Los_Angeles",
    liveMode,
    operatorEmails,
    emailProvider,
    emailFrom: env.EMAIL_FROM || "Operator <onboarding@resend.dev>",
    aiProvider: aiProvider as AppConfig["aiProvider"],
    aiModel: env.AI_MODEL || "",
    aiEffort: effort as AppConfig["aiEffort"],
    aiPriceInPerMTok: num(env.AI_PRICE_INPUT_USD_PER_MTOK),
    aiPriceOutPerMTok: num(env.AI_PRICE_OUTPUT_USD_PER_MTOK),
    aiMonthlyBudgetUsd: num(env.AI_MONTHLY_BUDGET_USD) ?? 0,
    agentSpecId: env.AGENT_SPEC_ID || "provisional-0.1",
    dispatchImmediate: env.DISPATCH_IMMEDIATE !== "false",
    maxUploadBytes: num(env.MAX_UPLOAD_BYTES) ?? 10 * 1024 * 1024,
  };
  cache.set(env, cfg);
  return cfg;
}
