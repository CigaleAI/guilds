export function oauthCallbackHtml(options: {
  success: boolean;
  title: string;
  message: string;
}): string {
  const color = options.success ? "#10b981" : "#ef4444";
  const bgTint = options.success ? "rgba(16, 185, 129, 0.12)" : "rgba(239, 68, 68, 0.12)";
  const borderTint = options.success ? "rgba(16, 185, 129, 0.3)" : "rgba(239, 68, 68, 0.3)";
  const iconSvg = options.success
    ? '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>'
    : '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${options.title} · guilds.run</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #090714;
      color: #f1f5f9;
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      padding: 24px;
    }
    .card {
      background: #131022;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 36px 32px;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65);
    }
    .icon-wrap {
      width: 58px;
      height: 58px;
      margin: 0 auto 20px;
      border-radius: 50%;
      background: ${bgTint};
      border: 1px solid ${borderTint};
      display: flex;
      align-items: center;
      justify-content: center;
      color: ${color};
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      margin-bottom: 8px;
      color: #ffffff;
    }
    p {
      color: #94a3b8;
      font-size: 14px;
      line-height: 1.5;
      margin-bottom: 24px;
    }
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      padding: 10px 22px;
      background: #a855f7;
      color: #ffffff;
      border: none;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: background 0.15s ease;
    }
    .btn:hover {
      background: #9333ea;
    }
    .status-hint {
      margin-top: 14px;
      font-size: 12px;
      color: #64748b;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon-wrap">${iconSvg}</div>
    <h1>${options.title}</h1>
    <p>${options.message}</p>
    <button class="btn" onclick="tryClose()">Close tab</button>
    <div class="status-hint">You can safely close this window and return to guilds.run.</div>
  </div>
  <script>
    function tryClose() {
      window.close();
      setTimeout(() => {
        if (!window.closed) window.location.href = "/";
      }, 300);
    }
    if (window.opener) {
      try {
        window.opener.postMessage({ type: "oauth_complete", success: ${options.success ? "true" : "false"} }, "*");
      } catch(e) {}
      setTimeout(tryClose, 1600);
    }
  </script>
</body>
</html>`;
}

export function githubInstallationPickerHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Pick a GitHub account · guilds.run</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      background: #090714;
      color: #f1f5f9;
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      padding: 24px;
    }
    .card {
      background: #131022;
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 28px 24px;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.65);
    }
    h1 { font-size: 20px; font-weight: 700; color: #ffffff; margin-bottom: 8px; }
    .lead { color: #94a3b8; font-size: 14px; line-height: 1.5; margin-bottom: 18px; }
    .list { border: 1px solid rgba(255, 255, 255, 0.08); border-radius: 10px; overflow: hidden; margin-bottom: 14px; }
    .row {
      display: flex; align-items: center; justify-content: space-between; gap: 10px;
      width: 100%; padding: 12px 14px; background: transparent; border: 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06);
      color: #f1f5f9; font: inherit; font-size: 14px; font-weight: 600; text-align: left; cursor: pointer;
    }
    .row:last-child { border-bottom: 0; }
    .row:hover { background: rgba(168, 85, 247, 0.12); }
    .empty, .error { color: #94a3b8; font-size: 13px; padding: 14px 12px; }
    .error { color: #fca5a5; }
    .btn {
      display: inline-flex; align-items: center; justify-content: center;
      padding: 9px 16px; border-radius: 8px; border: 0; font-size: 13px; font-weight: 600; cursor: pointer;
      background: rgba(255, 255, 255, 0.06); color: #e2e8f0; text-decoration: none;
    }
    .hint { margin-top: 12px; font-size: 12px; color: #64748b; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Pick a GitHub account</h1>
    <p class="lead">The App is already installed on these accounts. Each guild then chooses its own repositories in Settings.</p>
    <div id="list" class="list"><div class="empty">Loading accounts…</div></div>
    <a class="btn" id="install" hidden href="#">Install on another account</a>
    <div id="error" class="error" hidden></div>
    <div class="hint">You can close this window after the account is saved.</div>
  </div>
  <script>
    const state = new URLSearchParams(location.search).get("state") || "";
    const listEl = document.getElementById("list");
    const errorEl = document.getElementById("error");
    const installEl = document.getElementById("install");

    function showError(message) {
      errorEl.hidden = !message;
      errorEl.textContent = message || "";
    }

    function finish() {
      if (window.opener) {
        try { window.opener.postMessage({ type: "oauth_complete", success: true }, "*"); } catch (e) {}
      }
      window.close();
      setTimeout(() => { if (!window.closed) window.location.href = "/"; }, 300);
    }

    async function pick(installation_id) {
      showError("");
      const response = await fetch("/api/mcp/oauth/github-installation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, installation_id }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        showError(typeof data.detail === "string" ? data.detail : "Could not use that account");
        return;
      }
      finish();
    }

    async function load() {
      showError("");
      const response = await fetch("/api/mcp/oauth/github-installations?state=" + encodeURIComponent(state));
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        listEl.innerHTML = "";
        showError(typeof data.detail === "string" ? data.detail : "Could not list GitHub accounts");
        return;
      }
      const installations = Array.isArray(data.installations) ? data.installations : [];
      if (typeof data.install_url === "string" && data.install_url) {
        installEl.hidden = false;
        installEl.href = data.install_url;
      }
      listEl.innerHTML = "";
      if (!installations.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No installations of this App yet";
        listEl.appendChild(empty);
        return;
      }
      for (const installation of installations) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "row";
        button.textContent = installation.account || "GitHub";
        button.addEventListener("click", () => pick(installation.id));
        listEl.appendChild(button);
      }
    }

    load();
  </script>
</body>
</html>`;
}
