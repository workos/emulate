export interface LoginPageOptions {
  title: string;
  subtitle?: string;
  emailHint?: string;
  formAction: string;
  hiddenFields: Record<string, string>;
  /**
   * Accounts to offer beneath the email field, collapsed behind a disclosure. Every user the
   * emulator holds, not only the seeded ones: a user created through the API mid-session appears
   * here too, which is what makes the list useful for testing a sign-up.
   *
   * Collapsed by default, so the page an unknown address or a sign-up arrives at is the page it
   * has always been. Flat rather than grouped by organization, because the emulator asks which
   * organization in its own later step and grouping here would imply a choice this page does not
   * make. Each account is a submit button in a second form, so picking one is a single click and
   * `<details>` does the expanding, which leaves the page with no JavaScript. The list scrolls
   * rather than growing the card, so a large store stays usable. Omitted or empty renders the
   * page exactly as before.
   */
  users?: LoginPageUser[];
}

/** A seeded account offered on the sign-in page, so a developer picks rather than remembers. */
export interface LoginPageUser {
  email: string;
  name?: string | null;
}

/** One organization a user may finish signing in to. */
export interface SelectableOrganization {
  id: string;
  name: string;
}

export interface OrganizationSelectPageOptions {
  /** Who is signing in, so it is obvious whose organizations these are. */
  email: string;
  organizations: SelectableOrganization[];
  formAction: string;
  hiddenFields: Record<string, string>;
}

export interface DeviceVerifyPageOptions {
  title: string;
  message: string;
}

// The emulator auto-approves device authorization with the first seeded user, so this page is a
// static confirmation rather than a user_code entry form. It matches the login page styling so a
// CLI that opens verification_uri in a browser lands on something that looks like WorkOS.
export function renderDeviceVerifyPage(options: DeviceVerifyPageOptions): string {
  const { title, message } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — WorkOS Emulate</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
    .card{background:#fff;border-radius:8px;padding:40px;width:400px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    .badge{display:inline-block;background:#6366f1;color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px;margin-bottom:16px;letter-spacing:.5px}
    h1{font-size:22px;font-weight:600;margin-bottom:8px}
    .sub{color:#6b7280;font-size:14px;line-height:1.5}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">WORKOS EMULATE</div>
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(message)}</p>
  </div>
</body>
</html>`;
}

export function renderLoginPage(options: LoginPageOptions): string {
  const { title, subtitle, emailHint, formAction, hiddenFields, users } = options;

  const hiddenInputs = renderHiddenInputs(hiddenFields);

  // Sorted by email, and by email rather than name because a name is optional. Store order
  // would put whatever was created most recently at the bottom, which moves the rows under
  // someone mid-session; lexical keeps a given account in the same place. Copied first, so the
  // caller's slice is not reordered underneath it.
  const accounts = [...(users ?? [])].sort((a, b) => a.email.localeCompare(b.email, 'en'));
  const picker =
    accounts.length === 0
      ? ''
      : `
    <details class="accounts">
      <summary>Pick an account (${accounts.length})</summary>
      <form method="POST" action="${esc(formAction)}">
        ${hiddenInputs}
        <div class="account-list">
${accounts
  .map(
    (u) => `          <button class="account" type="submit" name="email" value="${esc(u.email)}">
            <span class="who">${u.name ? `<span class="name">${esc(u.name)}</span>` : ''}<span class="email">${esc(u.email)}</span></span>
            <span class="chevron" aria-hidden="true">&rsaquo;</span>
          </button>`,
  )
  .join('\n')}
        </div>
      </form>
    </details>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(title)} — WorkOS Emulate</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
    .card{background:#fff;border-radius:8px;padding:40px;width:400px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    .badge{display:inline-block;background:#6366f1;color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px;margin-bottom:16px;letter-spacing:.5px}
    h1{font-size:22px;font-weight:600;margin-bottom:8px}
    .sub{color:#6b7280;font-size:14px;margin-bottom:24px}
    label{display:block;font-size:14px;font-weight:500;margin-bottom:6px}
    input[type="email"]{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;outline:none}
    input[type="email"]:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.1)}
    button{width:100%;padding:10px;background:#6366f1;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:500;cursor:pointer;margin-top:16px}
    button:hover{background:#4f46e5}
    .accounts{margin-top:24px;border-top:1px solid #e5e7eb;padding-top:16px}
    .accounts summary{cursor:pointer;font-size:13px;color:#6b7280;list-style:none}
    .accounts summary::-webkit-details-marker{display:none}
    .accounts summary::before{content:"\\203A";display:inline-block;margin-right:6px;transition:transform .15s}
    .accounts[open] summary::before{transform:rotate(90deg)}
    .accounts summary:hover{color:#111827}
    .account-list{margin-top:12px;max-height:220px;overflow-y:auto;border:1px solid #e5e7eb;border-radius:6px}
    .account{display:flex;align-items:center;justify-content:space-between;width:100%;padding:10px 14px;background:#fff;border:none;border-bottom:1px solid #e5e7eb;text-align:left;cursor:pointer;margin-top:0}
    .account:last-child{border-bottom:none}
    .account:hover{background:#f9fafb}
    .account:focus-visible{outline:2px solid #6366f1;outline-offset:-2px}
    .who{display:flex;flex-direction:column;gap:2px}
    .name{font-size:14px;font-weight:500;color:#111827}
    .email{font-size:12px;color:#6b7280}
    .chevron{color:#9ca3af;font-size:18px;line-height:1}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">WORKOS EMULATE</div>
    <h1>${esc(title)}</h1>
    <p class="sub">${esc(subtitle ?? 'Enter your email to continue.')}</p>
    <form method="POST" action="${esc(formAction)}">
        ${hiddenInputs}
        <label for="email">Email</label>
        <input type="email" id="email" name="email" value="${esc(emailHint ?? '')}" required autofocus>
        <button type="submit">Continue</button>
    </form>${picker}
  </div>
</body>
</html>`;
}

/**
 * The screen hosted AuthKit shows when a user belongs to more than one organization: a row per
 * organization, picked before anything is minted.
 *
 * Rendered during authorize rather than at the token exchange, because that is where production
 * asks. The code then carries the organization and the client's exchange succeeds. Without this
 * step the emulator answers the exchange with `organization_selection_required`, which is an
 * API-level response a browser client has no way to act on: it surfaces mid-callback as a failed
 * exchange, and the user is simply stuck.
 *
 * Each row is a submit button carrying its own organization id, so picking is one click and the
 * page still needs no JavaScript.
 */
export function renderOrganizationSelectPage(options: OrganizationSelectPageOptions): string {
  const { email, organizations, formAction, hiddenFields } = options;

  const hiddenInputs = renderHiddenInputs(hiddenFields);

  const rows = organizations
    .map(
      (org) => `          <button class="org" type="submit" name="organization_id" value="${esc(org.id)}">
            <span>${esc(org.name)}</span><span class="chevron" aria-hidden="true">&rsaquo;</span>
          </button>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Select an organization — WorkOS Emulate</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
    .card{background:#fff;border-radius:8px;padding:40px;width:400px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    .badge{display:inline-block;background:#6366f1;color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px;margin-bottom:16px;letter-spacing:.5px}
    h1{font-size:22px;font-weight:600;margin-bottom:8px}
    .sub{color:#6b7280;font-size:14px;margin-bottom:24px}
    .orgs{border:1px solid #e5e7eb;border-radius:6px;overflow:hidden}
    .org{display:flex;align-items:center;justify-content:space-between;width:100%;padding:14px 16px;background:#fff;border:none;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;text-align:left;cursor:pointer}
    .org:last-child{border-bottom:none}
    .org:hover{background:#f9fafb}
    .org:focus-visible{outline:2px solid #6366f1;outline-offset:-2px}
    .chevron{color:#9ca3af;font-size:18px;line-height:1}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">WORKOS EMULATE</div>
    <h1>Select an organization</h1>
    <p class="sub">${esc(email)} belongs to more than one organization.</p>
    <form method="POST" action="${esc(formAction)}">
        ${hiddenInputs}
        <div class="orgs">
${rows}
        </div>
    </form>
  </div>
</body>
</html>`;
}

/** Hidden `<input>` elements for a form's carried-through fields, dropping null/undefined values. */
function renderHiddenInputs(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([, v]) => v != null)
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('\n        ');
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export interface PasswordPageOptions {
  /** Who is signing in, shown read-only so the page reads as the second step of one sign-in. */
  email: string;
  formAction: string;
  /** Carried through with `email` included, so the POST checks the password against the account the previous page resolved. */
  hiddenFields: Record<string, string>;
  /** Where "Use a different account" leads: the email page, with the same authorize parameters. */
  backHref: string;
  /** Shown above the field after a failed attempt. */
  error?: string;
}

/**
 * The screen hosted AuthKit shows a user who has a password: after the email, before any
 * organization question. Served only when the interactive password option is on, because the
 * one-step email page is what existing browser suites were written against.
 *
 * A failed attempt re-renders this page with the error inline rather than redirecting to the
 * callback with an error parameter, the way an unknown email does. A mistyped password is
 * something the user retries on the spot; the application only hears about the login once it
 * has succeeded. No JavaScript, like the other pages, so a plain form POST is the whole protocol.
 */
export function renderPasswordPage(options: PasswordPageOptions): string {
  const { email, formAction, hiddenFields, backHref, error } = options;

  const hiddenInputs = renderHiddenInputs(hiddenFields);
  const alert = error ? `\n    <p class="error" role="alert">${esc(error)}</p>` : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Enter your password — WorkOS Emulate</title>
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#f5f5f5;display:flex;justify-content:center;align-items:center;min-height:100vh}
    .card{background:#fff;border-radius:8px;padding:40px;width:400px;box-shadow:0 2px 8px rgba(0,0,0,.1)}
    .badge{display:inline-block;background:#6366f1;color:#fff;font-size:11px;font-weight:600;padding:3px 8px;border-radius:4px;margin-bottom:16px;letter-spacing:.5px}
    h1{font-size:22px;font-weight:600;margin-bottom:8px}
    .sub{color:#6b7280;font-size:14px;margin-bottom:24px}
    .sub strong{color:#111827;font-weight:500}
    .error{background:#fef2f2;border:1px solid #fecaca;color:#b91c1c;border-radius:6px;padding:10px 12px;font-size:13px;margin-bottom:16px}
    label{display:block;font-size:14px;font-weight:500;margin-bottom:6px}
    input[type="password"]{width:100%;padding:10px 12px;border:1px solid #d1d5db;border-radius:6px;font-size:14px;outline:none}
    input[type="password"]:focus{border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.1)}
    input[aria-invalid="true"]{border-color:#f87171}
    button{width:100%;padding:10px;background:#6366f1;color:#fff;border:none;border-radius:6px;font-size:14px;font-weight:500;cursor:pointer;margin-top:16px}
    button:hover{background:#4f46e5}
    .switch{display:block;margin-top:20px;font-size:13px;color:#6b7280;text-align:center;text-decoration:none}
    .switch:hover{color:#111827;text-decoration:underline}
  </style>
</head>
<body>
  <div class="card">
    <div class="badge">WORKOS EMULATE</div>
    <h1>Enter your password</h1>
    <p class="sub">Signing in as <strong>${esc(email)}</strong>.</p>${alert}
    <form method="POST" action="${esc(formAction)}">
        ${hiddenInputs}
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required autofocus autocomplete="current-password"${error ? ' aria-invalid="true"' : ''}>
        <button type="submit">Continue</button>
    </form>
    <a class="switch" href="${esc(backHref)}">Use a different account</a>
  </div>
</body>
</html>`;
}
