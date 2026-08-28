// ddrive v4 — Transactional mailer (SMTP via nodemailer)
//
// Reads SMTP_*/MAIL_FROM from serverConfig. When SMTP_HOST is unset, the
// transport is skipped and the email body is logged to the console instead
// (dev fallback) so the password-reset flow is testable without credentials.

import nodemailer, { type Transporter } from "nodemailer";
import { serverConfig } from "@ddv4/config/server";

const cfg = serverConfig.smtp;

let cached: Transporter | null = null;

function getTransport(): Transporter | null {
  if (!cfg.host) return null;
  if (cached) return cached;
  cached = nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
  });
  return cached;
}

export async function sendPasswordResetEmail(to: string, resetLink: string): Promise<void> {
  const subject = "ddrive — reset your password";
  const text =
    "We received a request to reset your ddrive password.\n\n" +
    "Click the link below to choose a new password. This link expires in 1 hour.\n\n" +
    `${resetLink}\n\n` +
    "If you did not request this, you can safely ignore this email.";

  const transport = getTransport();
  if (!transport) {
    // Dev fallback: no SMTP configured → log the link instead of sending.
    // eslint-disable-next-line no-console
    console.log(`[mailer:dev] password reset link for ${to}:\n${resetLink}`);
    return;
  }

  await transport.sendMail({
    from: cfg.from,
    to,
    subject,
    text,
  });
}
