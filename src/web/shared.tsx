import type { InvoiceLineRow, InvoiceRow, PaymentRow } from "../domain/billing";
import type { JobRow } from "../domain/jobs";
import { formatMoney, formatTime, formatWindow } from "../lib/format";

export const InvoiceView = ({ invoice, lines, job, payments, tz }: { invoice: InvoiceRow; lines: InvoiceLineRow[]; job: JobRow; payments: PaymentRow[]; tz: string }) => {
  const paid = payments.reduce((s, p) => s + p.amount_cents, 0);
  const banner =
    invoice.status === "draft"
      ? "DRAFT — NOT AN INVOICE. Do not pay."
      : invoice.status === "void"
        ? `VOID — replaced by a later revision. ${invoice.void_reason ?? ""}`
        : invoice.is_test
          ? "TEST INVOICE — fictional job, not a request for payment"
          : "INVOICE";
  return (
    <section class="card">
      <p class={`banner ${invoice.status}`}>{banner}</p>
      <h1>
        {invoice.number} <small>revision {invoice.revision}</small>
      </h1>
      <dl class="kv">
        <dt>Job</dt>
        <dd>{job.ref}</dd>
        <dt>Status</dt>
        <dd>{invoice.status}</dd>
        <dt>Created</dt>
        <dd>{formatTime(invoice.created_at, tz)}</dd>
        <dt>Issued</dt>
        <dd>{invoice.issued_at ? formatTime(invoice.issued_at, tz) : "Not issued"}</dd>
      </dl>
      <h3>Lines</h3>
      <table>
        <thead>
          <tr>
            <th>Description</th>
            <th class="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr>
              <td>
                <small>{l.kind === "service" ? "Service fee" : l.kind === "reimbursement" ? "Reimbursement (not a service fee)" : "Tax"}</small>
                {l.description}
              </td>
              <td class="num">{formatMoney(l.amount_cents)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Service fee subtotal</td>
            <td class="num">{formatMoney(invoice.service_fee_cents)}</td>
          </tr>
          <tr>
            <td>Reimbursable expenses</td>
            <td class="num">{formatMoney(invoice.reimbursable_cents)}</td>
          </tr>
          <tr>
            <td>Tax ({invoice.tax_label})</td>
            <td class="num">{formatMoney(invoice.tax_cents)}</td>
          </tr>
          <tr>
            <th>Total</th>
            <th class="num">{formatMoney(invoice.total_cents)}</th>
          </tr>
        </tfoot>
      </table>
      <h3>Payment record (separate from the invoice)</h3>
      {payments.length === 0 ? (
        <p class="muted">No payment recorded. Completion of work does not mean payment.</p>
      ) : (
        <ul class="plain">
          {payments.map((p) => (
            <li>
              {formatTime(p.created_at, tz)} — {formatMoney(p.amount_cents)} by {p.method.replace("_", " ")} ({p.reference}){p.is_test ? " — TEST" : ""}
            </li>
          ))}
        </ul>
      )}
      {invoice.status === "issued" && <p>Balance: {formatMoney(invoice.total_cents - paid)}</p>}
    </section>
  );
};

export interface WorkOrderContent {
  job_ref: string;
  quote_version: number;
  customer_objective: string;
  customer_instructions: string;
  scope: string;
  authorized_steps: string[];
  pickup: string;
  destination: string;
  destination_contact: string;
  customer_contact_method: string;
  time_window: { start: number; end: number };
  expense_limit_cents: number;
  required_authority: string;
  required_materials: string;
  completion_evidence: string;
  if_blocked: string;
  terms: string;
  generated_at: number;
}

export const WorkOrderView = ({ wo, tz }: { wo: WorkOrderContent; tz: string }) => (
  <section class="card">
    <h1>
      Work order — {wo.job_ref} <small>quote v{wo.quote_version}</small>
    </h1>
    <dl class="kv">
      <dt>Objective</dt>
      <dd>{wo.customer_objective}</dd>
      <dt>Customer instructions</dt>
      <dd>{wo.customer_instructions || "—"}</dd>
      <dt>Authorized steps</dt>
      <dd>
        {wo.authorized_steps.map((s, i) => (
          <div>
            {i + 1}. {s}
          </div>
        ))}
      </dd>
      <dt>Pickup</dt>
      <dd>{wo.pickup || "—"}</dd>
      <dt>Destination</dt>
      <dd>{wo.destination || "—"}</dd>
      <dt>Destination contact</dt>
      <dd>{wo.destination_contact || "—"}</dd>
      <dt>Customer contact</dt>
      <dd>{wo.customer_contact_method}</dd>
      <dt>Time window</dt>
      <dd>{formatWindow(wo.time_window.start, wo.time_window.end, tz)}</dd>
      <dt>Spending limit</dt>
      <dd>{formatMoney(wo.expense_limit_cents)} outside expenses, receipts required</dd>
      <dt>Required materials</dt>
      <dd>{wo.required_materials || "—"}</dd>
      <dt>Customer authority</dt>
      <dd>{wo.required_authority || "—"}</dd>
      <dt>Completion evidence</dt>
      <dd>{wo.completion_evidence || "—"}</dd>
      <dt>If blocked</dt>
      <dd>{wo.if_blocked || "Stop, report the issue in the app, and do not exceed the approved scope or spending."}</dd>
      <dt>Terms</dt>
      <dd>{wo.terms}</dd>
      <dt>Generated</dt>
      <dd>{formatTime(wo.generated_at, tz)}</dd>
    </dl>
  </section>
);
