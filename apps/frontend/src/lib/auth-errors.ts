// ddrive — human-friendly translation of raw GraphQL / network errors
// raised by the auth mutations (login, register, verifyEmail, …). The
// backend returns short, machine-oriented messages (e.g. "Email already
// registered", "Invalid credentials"); the UI prefers something users
// can act on without seeing internal API surface area.
//
// Any unrecognised error falls through to the supplied fallback so the
// user never sees "GraphQL error: …" or a JSON dump in the form.

interface AuthErrorMap {
  // GraphQL / API message (case-insensitive substring match) -> user copy
  matches: Array<{ needle: string; message: string }>;
  fallback: string;
}

const REGISTER_ERRORS: AuthErrorMap = {
  matches: [
    { needle: "email already registered", message: "An account with this email already exists. Try signing in instead." },
    { needle: "username already taken", message: "That username is already taken. Please choose a different one." },
    { needle: "email", message: "Please enter a valid email address." },
    { needle: "username", message: "Username must be 3–32 characters and contain only letters, numbers, underscores, or hyphens." },
    { needle: "password", message: "Password must be at least 8 characters." },
    { needle: "smtp", message: "We couldn't send the verification email. Please try again in a minute." },
    { needle: "verification email failed", message: "We couldn't send the verification email. Please try again in a minute." },
  ],
  fallback: "Sign-up failed. Please try again.",
};

const LOGIN_ERRORS: AuthErrorMap = {
  matches: [
    { needle: "invalid credentials", message: "Incorrect email/username or password." },
    { needle: "email not verified", message: "Please confirm your email first — check your inbox for the verification link." },
    { needle: "account locked", message: "This account is temporarily locked. Try again in a few minutes." },
    { needle: "rate limit", message: "Too many attempts. Please wait a minute before trying again." },
  ],
  fallback: "Sign-in failed. Please try again.",
};

const VERIFY_ERRORS: AuthErrorMap = {
  matches: [
    { needle: "invalid token", message: "This verification link is invalid. Please request a new one." },
    { needle: "expired", message: "This verification link has expired. Please request a new one." },
    { needle: "already", message: "This email is already verified. Try signing in." },
  ],
  fallback: "Verification failed. Please request a new link.",
};

const RESEND_ERRORS: AuthErrorMap = {
  matches: [
    { needle: "no pending verification", message: "No pending verification found. Try signing in." },
    { needle: "rate limit", message: "Too many requests. Please wait a minute before trying again." },
  ],
  fallback: "Could not resend the verification email. Please try again.",
};

function pick(map: AuthErrorMap, raw: string): string {
  const lower = raw.toLowerCase();
  for (const { needle, message } of map.matches) {
    if (lower.includes(needle)) return message;
  }
  return map.fallback;
}

export function humanizeAuthError(err: unknown, fallback: string): string {
  if (err instanceof Error) {
    return pick({ matches: [], fallback }, err.message || fallback) || err.message || fallback;
  }
  return fallback;
}

export function humanizeRegisterError(err: unknown): string {
  if (err instanceof Error) return pick(REGISTER_ERRORS, err.message);
  return REGISTER_ERRORS.fallback;
}

export function humanizeLoginError(err: unknown): string {
  if (err instanceof Error) return pick(LOGIN_ERRORS, err.message);
  return LOGIN_ERRORS.fallback;
}

export function humanizeVerifyError(err: unknown): string {
  if (err instanceof Error) return pick(VERIFY_ERRORS, err.message);
  return VERIFY_ERRORS.fallback;
}

export function humanizeResendError(err: unknown): string {
  if (err instanceof Error) return pick(RESEND_ERRORS, err.message);
  return RESEND_ERRORS.fallback;
}
