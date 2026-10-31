import { betterAuth } from "better-auth";
import { magicLink } from "better-auth/plugins";
import { config, type Env } from "./env";
import { sendEmail } from "./notify/email";

export type Role = "customer" | "operator" | "partner";

export interface Actor {
  userId: string;
  email: string;
  name: string;
  role: Role;
  partnerId: string | null;
}

const THIRTY_DAYS = 60 * 60 * 24 * 30;

export function createAuth(env: Env) {
  const cfg = config(env);
  return betterAuth({
    appName: "Operator",
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: cfg.appUrl,
    basePath: "/api/auth",
    trustedOrigins: [cfg.origin],
    telemetry: { enabled: false },
    user: {
      additionalFields: {
        // input:false — clients can never set these; only server code can.
        role: { type: "string", required: false, defaultValue: "customer", input: false },
        partnerId: { type: "string", required: false, input: false },
      },
    },
    session: { expiresIn: THIRTY_DAYS, updateAge: 60 * 60 * 24 },
    rateLimit: {
      enabled: cfg.env !== "test",
      storage: "database",
      window: 60,
      max: 60,
      customRules: { "/sign-in/magic-link": { window: 600, max: 5 } },
    },
    advanced: {
      useSecureCookies: cfg.appUrl.startsWith("https://"),
      // Cloudflare sets cf-connecting-ip at the edge (clients cannot spoof it).
      // Without this, rate limiting finds no client IP in production.
      ipAddress: { ipAddressHeaders: ["cf-connecting-ip"] },
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            // Partner access is granted by the operator in advance by email.
            const partner = await env.DB.prepare("SELECT id FROM partners WHERE login_email = ?")
              .bind(String(user.email).toLowerCase())
              .first<{ id: string }>();
            return {
              data: { ...user, role: partner ? "partner" : "customer", partnerId: partner?.id ?? null },
            };
          },
        },
      },
    },
    plugins: [
      magicLink({
        expiresIn: 15 * 60,
        sendMagicLink: async ({ email, url }) => {
          // Sent directly (not via the outbox) and never persisted outside the
          // dev mailbox: the link is a credential.
          await sendEmail(env, cfg, {
            to: email,
            subject: "Your Operator sign-in link",
            text: `Use this link within 15 minutes to sign in to Operator:\n\n${url}\n\nIf you did not request it, ignore this email.`,
            idempotencyKey: `signin:${crypto.randomUUID()}`,
          });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

/**
 * The operator role comes from OPERATOR_EMAILS (deployment configuration),
 * so it cannot be granted through the database or the UI. Partner access
 * requires a partner record linked by the operator.
 */
export function resolveActor(
  env: Env,
  user: { id: string; email: string; name: string; role?: string | null; partnerId?: string | null },
): Actor {
  const cfg = config(env);
  const email = user.email.toLowerCase();
  let role: Role = "customer";
  if (cfg.operatorEmails.includes(email)) role = "operator";
  else if (user.role === "partner" && user.partnerId) role = "partner";
  return {
    userId: user.id,
    email,
    name: user.name,
    role,
    partnerId: role === "partner" ? (user.partnerId ?? null) : null,
  };
}
