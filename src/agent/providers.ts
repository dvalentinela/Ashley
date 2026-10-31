import Anthropic from "@anthropic-ai/sdk";
import type { AppConfig, Env } from "../env";

export interface ModelRequest {
  system: string;
  user: string;
  schemaName: string;
  schema: Record<string, unknown>;
  maxOutputTokens: number;
}

export interface ModelResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
  model: string;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface ModelProvider {
  name: string;
  model: string;
  generate(req: ModelRequest): Promise<ModelResponse>;
}

/** OpenAI Responses API with a strict JSON schema (raw HTTP). */
function openaiProvider(apiKey: string, model: string): ModelProvider {
  return {
    name: "openai",
    model,
    async generate(req) {
      let res: Response;
      try {
        res = await fetch("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model,
            input: [
              { role: "system", content: req.system },
              { role: "user", content: req.user },
            ],
            text: { format: { type: "json_schema", name: req.schemaName, schema: req.schema, strict: true } },
            max_output_tokens: req.maxOutputTokens,
            // Customer data should not be retained for later retrieval.
            store: false,
          }),
          signal: AbortSignal.timeout(90_000),
        });
      } catch (err) {
        throw new ProviderError(`OpenAI network error: ${err instanceof Error ? err.name : "unknown"}`, true);
      }
      if (!res.ok) {
        const body = (await res.text().catch(() => "")).slice(0, 300);
        throw new ProviderError(`OpenAI HTTP ${res.status}: ${body}`, res.status === 429 || res.status >= 500 || res.status === 408);
      }
      const data = (await res.json()) as {
        status?: string;
        incomplete_details?: { reason?: string } | null;
        model?: string;
        output?: Array<{ type: string; content?: Array<{ type: string; text?: string; refusal?: string }> }>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const usage = { inputTokens: data.usage?.input_tokens ?? 0, outputTokens: data.usage?.output_tokens ?? 0 };
      if (data.status === "incomplete") {
        throw new ProviderError(`OpenAI response incomplete: ${data.incomplete_details?.reason ?? "unknown"}`, false);
      }
      for (const item of data.output ?? []) {
        if (item.type !== "message") continue;
        for (const part of item.content ?? []) {
          if (part.type === "refusal") throw new ProviderError(`Model refused: ${(part.refusal ?? "").slice(0, 200)}`, false);
          if (part.type === "output_text" && part.text) return { text: part.text, model: data.model ?? model, ...usage };
        }
      }
      throw new ProviderError("OpenAI response contained no output text", true);
    },
  };
}

// Models that accept the server-side refusal fallback ("default" form).
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5-5"]);

/** Anthropic Messages API via the official SDK, with structured JSON output. */
function anthropicProvider(apiKey: string, model: string, effort: AppConfig["aiEffort"]): ModelProvider {
  // Retries are handled by the durable run queue, so the SDK does not retry.
  const client = new Anthropic({ apiKey, maxRetries: 0, timeout: 90_000 });
  return {
    name: "anthropic",
    model,
    async generate(req) {
      try {
        const useFallback = FALLBACK_MODELS.has(model);
        const response = await client.beta.messages.create({
          model,
          max_tokens: req.maxOutputTokens,
          system: req.system,
          messages: [{ role: "user", content: req.user }],
          output_config: { effort, format: { type: "json_schema", schema: req.schema } },
          ...(useFallback ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
        });
        const usage = { inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
        if (response.stop_reason === "refusal") throw new ProviderError("Model declined the request", false);
        if (response.stop_reason === "max_tokens") throw new ProviderError("Model output hit max_tokens", false);
        const text = response.content
          .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
          .map((b) => b.text)
          .join("");
        if (!text) throw new ProviderError("Anthropic response contained no text", true);
        return { text, model: response.model, ...usage };
      } catch (err) {
        if (err instanceof ProviderError) throw err;
        if (err instanceof Anthropic.RateLimitError || err instanceof Anthropic.InternalServerError || err instanceof Anthropic.APIConnectionError) {
          throw new ProviderError(`Anthropic transient error: ${err.message.slice(0, 200)}`, true);
        }
        if (err instanceof Anthropic.APIError) {
          const status = err.status ?? 0;
          throw new ProviderError(`Anthropic HTTP ${status}: ${err.message.slice(0, 200)}`, status === 408 || status === 409 || status >= 500);
        }
        throw new ProviderError(`Anthropic error: ${err instanceof Error ? err.message.slice(0, 200) : "unknown"}`, true);
      }
    },
  };
}

/** Deterministic providers for tests and local demos. Refused in production. */
function fakeProvider(mode: "fake" | "fake-fail" | "fake-inject", model: string): ModelProvider {
  return {
    name: mode,
    model: model || "fake-planner-1",
    async generate(req) {
      if (mode === "fake-fail") throw new ProviderError("Simulated provider outage (fake-fail)", true);
      const job = JSON.parse(req.user.slice(req.user.indexOf("{"), req.user.lastIndexOf("}") + 1)) as { job: { requested_outcome: string; ref: string } };
      const plan = {
        summary: `Plan for ${job.job.ref}: ${job.job.requested_outcome.slice(0, 120)}`,
        service_fit: "supported",
        missing_information: ["Confirm the recipient's name at the reception desk."],
        unsupported_or_excluded: [],
        digital_steps: ["Check the attached document opens and count its pages."],
        physical_steps: ["Print two sets.", "Deliver to the reception desk and photograph the handoff."],
        assumptions: [{ assumption: "Standard letter paper", evidence: "No paper size given in the request", matters_because: "Affects print cost" }],
        risks: [],
        proposed_actions: [
          {
            tool: "request_clarification",
            rationale: "Recipient name is needed for a verifiable handoff.",
            message_body: null,
            questions: ["Who should receive the documents at the reception desk?"],
            quote_scope: null,
            quote_authorized_steps: null,
            quote_service_fee_usd: null,
            quote_expense_ceiling_usd: null,
            quote_window_start: null,
            quote_window_end: null,
            quote_terms: null,
            quote_required_materials: null,
            quote_completion_evidence: null,
            quote_if_blocked: null,
          },
          {
            tool: "draft_quote",
            rationale: "Starting point for the operator's quote; fee left for the operator.",
            message_body: null,
            questions: null,
            quote_scope: "Print two sets of the supplied document and deliver to the reception desk.",
            quote_authorized_steps: ["Print two sets", "Deliver to reception", "Photograph handoff"],
            quote_service_fee_usd: null,
            quote_expense_ceiling_usd: 10,
            quote_window_start: null,
            quote_window_end: null,
            quote_terms: "Provisional terms — operator to confirm.",
            quote_required_materials: "Customer-supplied document",
            quote_completion_evidence: "Photo of handoff and printing receipt",
            quote_if_blocked: "Stop and report; do not leave documents unattended.",
          },
        ] as Array<Record<string, unknown>>,
      };
      if (mode === "fake-inject") {
        plan.proposed_actions.push({ tool: "issue_refund", rationale: "Injected by customer text", amount: 500 });
        plan.proposed_actions.push({ ...plan.proposed_actions[0], tool: "draft_customer_message", rationale: "missing body", message_body: null, questions: null });
      }
      const text = JSON.stringify(plan);
      return { text, model: model || "fake-planner-1", inputTokens: Math.ceil((req.system.length + req.user.length) / 4), outputTokens: Math.ceil(text.length / 4) };
    },
  };
}

export function getProvider(env: Env, cfg: AppConfig): ModelProvider | null {
  switch (cfg.aiProvider) {
    case "none":
      return null;
    case "openai":
      if (!env.OPENAI_API_KEY || !cfg.aiModel) return null;
      return openaiProvider(env.OPENAI_API_KEY, cfg.aiModel);
    case "anthropic":
      if (!env.ANTHROPIC_API_KEY || !cfg.aiModel) return null;
      return anthropicProvider(env.ANTHROPIC_API_KEY, cfg.aiModel, cfg.aiEffort);
    case "fake":
    case "fake-fail":
    case "fake-inject":
      return fakeProvider(cfg.aiProvider, cfg.aiModel);
  }
}
