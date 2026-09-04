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

// Inline-styled HTML (works in Gmail / Outlook / Apple Mail). No external
// images so it renders even with images blocked; the CTA is a real link.
function buildResetHtml(to: string, resetLink: string): string {
  const appName = "ddrive";
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset your password</title>
</head>
<body style="margin:0;padding:0;background-color:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f1115;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;width:100%;background-color:#171a21;border:1px solid #262b36;border-radius:12px;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 8px 32px;background-color:#171a21;">
              <span style="font-size:20px;font-weight:700;color:#ffffff;letter-spacing:-0.2px;">${appName}</span>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0 32px;">
              <h1 style="margin:0;font-size:22px;font-weight:600;color:#ffffff;line-height:1.3;">Reset your password</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 0 32px;">
              <p style="margin:0;font-size:15px;line-height:1.6;color:#b9c0cc;">
                We received a request to reset the password for <strong style="color:#e6e9ef;">${to}</strong>.
                Click the button below to choose a new password. This link expires in <strong style="color:#e6e9ef;">1 hour</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px 32px;" align="center">
              <a href="${resetLink}" target="_blank" rel="noopener"
                 style="display:inline-block;background-color:#3b82f6;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 28px;border-radius:8px;">
                Reset password
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0 32px;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:#8b93a1;">
                Or paste this link into your browser:<br />
                <a href="${resetLink}" target="_blank" rel="noopener" style="color:#6aa6ff;word-break:break-all;">${resetLink}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 0 32px;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:#8b93a1;">
                If you didn't request this, you can safely ignore this email — your password won't change.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 28px 32px;border-top:1px solid #262b36;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;">
                &copy; ${year} ${appName} &middot; ${cfg.from}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildResetText(to: string, resetLink: string): string {
  return [
    `We received a request to reset the password for ${to}.`,
    "",
    "Click the link below to choose a new password. This link expires in 1 hour.",
    "",
    resetLink,
    "",
    "If you did not request this, you can safely ignore this email — your password won't change.",
  ].join("\n");
}

export async function sendPasswordResetEmail(to: string, resetLink: string): Promise<void> {
  const subject = "ddrive — reset your password";
  const text = buildResetText(to, resetLink);
  const html = buildResetHtml(to, resetLink);

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
    html,
    headers: {
      "List-Id": "ddrive <ddrive.cikowice.pl>",
      "List-Unsubscribe": `<mailto:${cfg.from}?subject=unsubscribe>`,
    },
  });
}

function buildVerificationHtml(verifyLink: string): string {
  const appName = "ddrive";
  const year = new Date().getFullYear();
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Confirm your email</title>
</head>
<body style="margin:0;padding:0;background-color:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f1115;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#161a22;border-radius:12px;border:1px solid #262b36;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 8px 32px;">
              <h1 style="margin:0;font-size:22px;font-weight:700;color:#e6e9ef;">Confirm your email</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0 32px;">
              <p style="margin:0;font-size:15px;line-height:1.6;color:#c4c8d0;">
                Thanks for signing up to <strong style="color:#e6e9ef;">${appName}</strong>. Click the button below to confirm your email and activate your account. This link expires in <strong style="color:#e6e9ef;">24 hours</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px 32px;" align="center">
              <a href="${verifyLink}" target="_blank" rel="noopener"
                 style="display:inline-block;background-color:#6366f1;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 28px;border-radius:8px;">
                Confirm email
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0 32px;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:#8b93a1;">
                Or paste this link into your browser:<br />
                <a href="${verifyLink}" target="_blank" rel="noopener" style="color:#6aa6ff;word-break:break-all;">${verifyLink}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 0 32px;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:#8b93a1;">
                If you didn't sign up, you can safely ignore this email — the account will not be activated.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 28px 32px;border-top:1px solid #262b36;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;">
                &copy; ${year} ${appName} &middot; ${cfg.from}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildVerificationText(verifyLink: string): string {
  return [
    "Thanks for signing up to ddrive.",
    "",
    "Click the link below to confirm your email and activate your account. This link expires in 24 hours.",
    "",
    verifyLink,
    "",
    "If you did not sign up, you can safely ignore this email — the account will not be activated.",
  ].join("\n");
}

export async function sendVerificationEmail(to: string, verifyLink: string): Promise<void> {
  const subject = "ddrive — confirm your email";
  const text = buildVerificationText(verifyLink);
  const html = buildVerificationHtml(verifyLink);

  const transport = getTransport();
  if (!transport) {
    // Dev fallback: no SMTP configured → log the link instead of sending.
    // eslint-disable-next-line no-console
    console.log(`[mailer:dev] verification link for ${to}:\n${verifyLink}`);
    return;
  }

  await transport.sendMail({
    from: cfg.from,
    to,
    subject,
    text,
    html,
    headers: {
      "List-Id": "ddrive <ddrive.cikowice.pl>",
      "List-Unsubscribe": `<mailto:${cfg.from}?subject=unsubscribe>`,
    },
  });
}

function buildDeletionHtml(username: string | null, confirmLink: string): string {
  const appName = "ddrive";
  const year = new Date().getFullYear();
  const greeting = username ? `Hi ${username},` : "Hi,";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Confirm account deletion</title>
</head>
<body style="margin:0;padding:0;background-color:#0f1115;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#0f1115;padding:24px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#161a22;border-radius:12px;border:1px solid #262b36;overflow:hidden;">
          <tr>
            <td style="padding:28px 32px 8px 32px;">
              <h1 style="margin:0;font-size:22px;font-weight:700;color:#e6e9ef;">Are you sure?</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0 32px;">
              <p style="margin:0;font-size:15px;line-height:1.6;color:#c4c8d0;">
                ${greeting} we got a request to permanently delete your ${appName} account and everything in it &mdash; files, folders, share links, sessions, and API keys. This can't be undone.
              </p>
              <p style="margin:16px 0 0 0;font-size:15px;line-height:1.6;color:#c4c8d0;">
                If that's really what you want, click the button below. This link expires in <strong style="color:#e6e9ef;">1 hour</strong>.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 8px 32px;" align="center">
              <a href="${confirmLink}" target="_blank" rel="noopener"
                 style="display:inline-block;background-color:#dc2626;color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;padding:13px 28px;border-radius:8px;">
                Yes, permanently delete my account
              </a>
            </td>
          </tr>
          <tr>
            <td style="padding:8px 32px 0 32px;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:#8b93a1;">
                Or paste this link into your browser:<br />
                <a href="${confirmLink}" target="_blank" rel="noopener" style="color:#6aa6ff;word-break:break-all;">${confirmLink}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 0 32px;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:#8b93a1;">
                Didn't ask for this? Ignore this email and your account stays exactly as it is &mdash; nothing happens unless you click the link.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:20px 32px 0 32px;">
              <p style="margin:0;font-size:13px;line-height:1.6;color:#8b93a1;">
                If you do go through with it &mdash; we'll miss you. Thanks for trying ${appName}.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding:24px 32px 28px 32px;border-top:1px solid #262b36;">
              <p style="margin:0;font-size:12px;line-height:1.5;color:#6b7280;">
                &copy; ${year} ${appName} &middot; ${cfg.from}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function buildDeletionText(username: string | null, confirmLink: string): string {
  const greeting = username ? `Hi ${username},` : "Hi,";
  return [
    `${greeting} we got a request to permanently delete your ddrive account and everything in it — files, folders, share links, sessions, and API keys. This can't be undone.`,
    "",
    "If that's really what you want, click the link below. This link expires in 1 hour.",
    "",
    confirmLink,
    "",
    "Didn't ask for this? Ignore this email and your account stays exactly as it is — nothing happens unless you click the link.",
    "",
    "If you do go through with it — we'll miss you. Thanks for trying ddrive.",
  ].join("\n");
}

export async function sendAccountDeletionEmail(to: string, username: string | null, confirmLink: string): Promise<void> {
  const subject = "ddrive — confirm account deletion";
  const text = buildDeletionText(username, confirmLink);
  const html = buildDeletionHtml(username, confirmLink);

  const transport = getTransport();
  if (!transport) {
    // Dev fallback: no SMTP configured → log the link instead of sending.
    // eslint-disable-next-line no-console
    console.log(`[mailer:dev] account deletion confirm link for ${to}:\n${confirmLink}`);
    return;
  }

  await transport.sendMail({
    from: cfg.from,
    to,
    subject,
    text,
    html,
    headers: {
      "List-Id": "ddrive <ddrive.cikowice.pl>",
      "List-Unsubscribe": `<mailto:${cfg.from}?subject=unsubscribe>`,
    },
  });
}
