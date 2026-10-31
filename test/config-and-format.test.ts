import { describe, expect, it } from "vitest";
import { config, ConfigError, type Env } from "../src/env";
import { formatMoney, localToUtc, parseMoney, utcToLocalInput } from "../src/lib/format";

const base = {
  APP_ENV: "production",
  APP_URL: "https://operator.example",
  APP_TIMEZONE: "America/Los_Angeles",
  LIVE_MODE: "false",
  BETTER_AUTH_SECRET: "x".repeat(40),
  OPERATOR_EMAILS: "jack@example.com",
  EMAIL_PROVIDER: "resend",
  EMAIL_FROM: "Operator <ops@example.com>",
  RESEND_API_KEY: "re_x",
  AI_PROVIDER: "none",
  AI_MODEL: "",
} as unknown as Env;

describe("configuration safety", () => {
  it("accepts a sane production config", () => {
    expect(config({ ...base }).env).toBe("production");
  });
  it("refuses the dev mailbox on any non-local URL, even outside production", () => {
    const dev = { ...base, APP_ENV: "development", EMAIL_PROVIDER: "dev" } as Env;
    expect(() => config({ ...dev, APP_URL: "https://operator-service.example.workers.dev" } as Env)).toThrow("only allowed when APP_URL is localhost");
    expect(config({ ...dev, APP_URL: "http://localhost:8787" } as Env).emailProvider).toBe("dev");
  });
  it.each([
    [{ EMAIL_PROVIDER: "dev" }, "EMAIL_PROVIDER=dev"],
    [{ AI_PROVIDER: "fake" }, "Fake AI"],
    [{ APP_URL: "http://operator.example" }, "https"],
    [{ BETTER_AUTH_SECRET: "short" }, "BETTER_AUTH_SECRET"],
    [{ RESEND_API_KEY: undefined }, "RESEND_API_KEY"],
    [{ LIVE_MODE: "true" }, "LIVE_MODE"],
  ])("refuses unsafe production setting %o", (patch, msg) => {
    expect(() => config({ ...base, ...patch } as Env)).toThrow(ConfigError);
    expect(() => config({ ...base, ...patch } as Env)).toThrow(msg);
  });
});

describe("money and time", () => {
  it("parses and formats money exactly", () => {
    expect(parseMoney("45", "f")).toBe(4500);
    expect(parseMoney("$6.50", "f")).toBe(650);
    expect(parseMoney("1,045.5", "f")).toBe(104550);
    expect(() => parseMoney("6.505", "f")).toThrow();
    expect(() => parseMoney("-1", "f")).toThrow();
    expect(formatMoney(5150)).toBe("$51.50");
    expect(formatMoney(-900)).toBe("-$9.00");
  });
  it("converts Los Angeles local time across DST", () => {
    // 2026-11-01 01:30 happens twice in LA; 2026-11-02 09:00 is PST (UTC-8).
    expect(new Date(localToUtc("2026-11-02T09:00", "America/Los_Angeles", "t")).toISOString()).toBe("2026-11-02T17:00:00.000Z");
    expect(new Date(localToUtc("2026-10-30T09:00", "America/Los_Angeles", "t")).toISOString()).toBe("2026-10-30T16:00:00.000Z");
    expect(utcToLocalInput(Date.parse("2026-11-02T17:00:00Z"), "America/Los_Angeles")).toBe("2026-11-02T09:00");
  });
});
