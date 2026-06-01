export interface LoginPageOptions {
  title: string;
  subtitle?: string;
  emailHint?: string;
  formAction: string;
  hiddenFields: Record<string, string>;
}

export function renderLoginPage(options: LoginPageOptions): string {
  const { title, subtitle, emailHint, formAction, hiddenFields } = options;

  const hiddenInputs = Object.entries(hiddenFields)
    .filter(([, v]) => v != null)
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join('\n        ');

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
    </form>
  </div>
</body>
</html>`;
}

function esc(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
