(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => Array.from(document.querySelectorAll(sel));

  const money = (n) => n.toLocaleString("en-US") + " " + PRICE_LABEL;
  const robux = (n) => n === Infinity || n === Number.MAX_SAFE_INTEGER ? "∞ RBX" : n.toLocaleString("en-US") + " " + ROBUX_LABEL;
  const dayDiff = (dateStr) => Math.max(0, Math.floor((Date.now() - new Date(dateStr).getTime()) / 86400000));

  let state = {
    category: "all",
    sort: "featured",
    search: "",
    detailId: null,
    authMode: "login",
    pay: "btc"
  };

  let cart = load("sh_cart", []);
  let token = load("sh_token", "");
  let user = null;

  function load(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function save(key, val) {
    localStorage.setItem(key, JSON.stringify(val));
  }

  function toast(msg, type) {
    const t = $("#toast");
    t.textContent = msg;
    t.className = "toast show" + (type ? " " + type : "");
    clearTimeout(t._timer);
    t._timer = setTimeout(() => (t.className = "toast"), 2600);
    capyLog(`[toast] ${msg}`, type === "error" ? "err" : type === "success" ? "ok" : "info");
  }

  /* ================= DEV LOG ================= */

  const _capyLogs = [];
  const _origConsole = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };

  function capyLog(msg, cls) {
    const t = new Date().toLocaleTimeString();
    const clsStr = cls || "info";
    _capyLogs.push({ t, msg, cls: clsStr });
    if (_capyLogs.length > 400) _capyLogs.shift();
    if ($("#devConsole").classList.contains("show")) appendDevLog(_capyLogs[_capyLogs.length - 1]);
  }

  function appendDevLog(e) {
    const el = $("#devLog");
    if (!el) return;
    const row = document.createElement("div");
    row.className = `l-${e.cls}`;
    row.textContent = `${e.t}  ${e.msg}`;
    el.appendChild(row);
    el.scrollTop = el.scrollHeight;
  }

  function renderDevLogs() {
    const el = $("#devLog");
    if (!el) return;
    el.innerHTML = "";
    _capyLogs.forEach((e) => appendDevLog(e));
  }

  function toggleDevConsole() {
    const el = $("#devConsole");
    const show = !el.classList.contains("show");
    el.classList.toggle("show", show);
    if (show) renderDevLogs();
    capyLog(show ? "Dev console opened" : "Dev console closed", "info");
  }

  (function _patchConsole() {
    console.log = (...a) => { _origConsole.log(...a); capyLog(a.map((x) => typeof x === "object" ? JSON.stringify(x) : String(x)).join(" "), "info"); };
    console.warn = (...a) => { _origConsole.warn(...a); capyLog(a.map(String).join(" "), "warn"); };
    console.error = (...a) => { _origConsole.error(...a); capyLog(a.map(String).join(" "), "err"); };
    const _origFetch = window.fetch.bind(window);
    window.fetch = async function (...args) {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "";
      const method = (args[1] && args[1].method) || "GET";
      const quiet = url.indexOf("/api/message-state") !== -1 || url.indexOf("/api/maintenance-state") !== -1 || url.indexOf("/health") !== -1;
      if (!quiet) capyLog(`→ ${method} ${url}`, "net");
      const res = await _origFetch(...args);
      if (!quiet) {
        res.clone().text().then((t) => {
          const brief = t.length > 180 ? t.slice(0, 180) + "…" : t;
          capyLog(`← ${res.status} ${url}  ${brief}`, res.ok ? "ok" : "err");
        }).catch(() => {});
      }
      return res;
    };
  })();

  function ownedSet() {
    return new Set((user ? user.purchases : []).map((p) => p.script));
  }

  function currentPrice(s) {
    return Number(s.price) || 0;
  }

  /* ================= ADMIN CONSOLE ================= */

  const ADMIN_COMMANDS = [
    { id: "help", name: "help", desc: "List all commands", run: (a, p, out) => { ADMIN_COMMANDS.forEach((c) => out(`${c.name}  —  ${c.desc}${c.roles ? `  [${c.roles.join("/")}]` : (c.userOnly ? "  [USER " + c.userOnly + "]" : "")}`, "dim")); } },
    { id: "whoami", name: "whoami", desc: "Show session info and token", run: (a, p, out) => { out("user    : " + (user ? user.username + " [" + currentRole() + "]" : "not signed in"), "ok"); out("wallet  : " + (user ? "$" + (user.wallet || 0) : "-"), "ok"); out("token   : " + (token ? token.slice(0, 10) + "…" : "none"), "dim"); } },
    { id: "give-robux", name: "give-robux [user] <amount>", desc: "Add Robux to a user's linked account", roles: ["admin", "tester"], run: (a, p, out) => giveRobuxCmd(a, p, out) },
    { id: "wallet", name: "wallet <user> <amount>", desc: "Add/subtract RB$ wallet credit for a user", roles: ["admin"], run: (a, p, out) => walletCmd(a, out) },
    { id: "robux", name: "robux <user>", desc: "Show a user's Roblox balance and account info", roles: ["admin"], run: (a, p, out) => lookCmd(a, out) },
    { id: "sessions", name: "sessions", desc: "List currently signed-in users", roles: ["admin"], run: (a, p, out) => sessionsCmd(out) },
    { id: "ping", name: "ping", desc: "Measure round-trip / server time", run: (a, p, out) => pingCmd(out) },
    { id: "time", name: "time", desc: "Show server time", run: (a, p, out) => pingCmd(out, true) },
    { id: "stats", name: "stats", desc: "Server statistics (users, keys, revenue)", run: (a, p, out) => statsCmd(out) },
    { id: "keys", name: "keys", desc: "Print your license keys", run: (a, p, out) => { if (!user || !user.purchases.length) { out("No keys — your library is empty", "warn"); return; } user.purchases.forEach((x) => out(`${x.script}  =>  ${x.key}`, "ok")); } },
    { id: "token", name: "token", desc: "Generate a demo license key", run: (a, p, out) => { const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; const seg = () => Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join(""); out("SH-" + [seg(), seg(), seg()].join("-"), "ok"); } },
    { id: "ban", name: "ban <user> [reason]", desc: "Ban a user (server-enforced, real)", roles: ["admin"], run: (a, p, out) => banCmd("ban", a, out) },
    { id: "unban", name: "unban <user>", desc: "Remove a user's ban", roles: ["admin"], run: (a, p, out) => banCmd("unban", a, out) },
    { id: "announce", name: "announce <text|clear>", desc: "Broadcast a system message to everyone", roles: ["admin"], run: (a, p, out) => announceCmd(a, out) },
    { id: "theme", name: "theme <dark|neon>", desc: "Switch page theme (demo)", run: (a, p, out) => { const v = (a[0] || "").toLowerCase(); if (v === "dark") { document.documentElement.classList.remove("neon-theme"); out("theme -> dark", "ok"); } else if (v === "neon") { document.documentElement.classList.add("neon-theme"); out("theme -> neon", "ok"); } else { out("usage: theme dark|neon", "warn"); } } },
    { id: "clear", name: "clear", desc: "Clear output", run: (a, p, out) => { outInnerClear(); } },
    { id: "testdata", name: "testdata", desc: "View test data (users, keys, sales)", roles: ["admin", "tester"], run: (a, p, out) => testDataCmd(out, false) },
    { id: "export", name: "export", desc: "Download test data as JSON file", roles: ["admin", "tester"], run: (a, p, out) => testDataCmd(out, true) },
    { id: "logs", name: "logs [n]", desc: "Show server activity logs (login/logout/actions)", roles: ["admin"], run: (a, p, out) => logsCmd(a, out) },
    { id: "roll", name: "roll [dice]", desc: "Roll a dice (e.g. 1d6 or 100)", run: (a, p, out) => {
      let expr = (a[0] || "1d6").toLowerCase();
      let match = expr.match(/^(\d*)d(\d+)$/);
      if (match) {
        let count = parseInt(match[1] || "1", 10);
        let sides = parseInt(match[2], 10);
        if (count < 1 || count > 100 || sides < 2 || sides > 1000) { out("usage: roll [dice] (e.g. 1d6 or 100)", "warn"); return; }
        let rolls = [];
        let total = 0;
        for (let i = 0; i < count; i++) { let r = Math.floor(Math.random() * sides) + 1; rolls.push(r); total += r; }
        out(`🎲 Rolled ${expr}: ${total} ${count > 1 ? '(' + rolls.join(', ') + ')' : ''}`, "ok");
      } else {
        let max = parseInt(expr, 10);
        if (!Number.isFinite(max) || max < 1) max = 6;
        let r = Math.floor(Math.random() * max) + 1;
        out(`🎲 Rolled ${r} (1-${max})`, "ok");
      }
    } },
    { id: "coin", name: "coin", desc: "Flip a coin (Heads/Tails)", run: (a, p, out) => { out(`🪙 Flipped a coin: ${Math.random() < 0.5 ? "Heads" : "Tails"}`, "ok"); } },
    { id: "8ball", name: "8ball <question>", desc: "Magic 8-ball answer", run: (a, p, out) => {
      if (!a.length) { out("usage: 8ball <question>", "warn"); return; }
      const answers = ["It is certain.", "It is decidedly so.", "Without a doubt.", "Yes – definitely.", "You may rely on it.", "As I see it, yes.", "Most likely.", "Outlook good.", "Yes.", "Signs point to yes.", "Reply hazy, try again.", "Ask again later.", "Better not tell you now.", "Cannot predict now.", "Concentrate and ask again.", "Don't count on it.", "My reply is no.", "My sources say no.", "Outlook not so good.", "Very doubtful."];
      out(`🎱 Magic 8-Ball: ${answers[Math.floor(Math.random() * answers.length)]}`, "ok");
    } },
    { id: "joke", name: "joke", desc: "Tells a funny dev/Roblox joke", run: (a, p, out) => {
      const jokes = ["Why do programmers prefer dark mode? Because light attracts bugs!", "Why did the Roblox developer cross the road? To fix the hitbox on the other side.", "There are 10 types of people in the world: those who understand binary, and those who don't.", "Error 404: Joke not found. Please reboot developer.", "Why do Lua developers count from 1? Because they have feelings too!", "My code doesn't work, I have no idea why. My code works, I have no idea why.", "What is a Roblox exploiter's favorite snack? Crash chips.", "To understand recursion, you must first understand recursion.", "Why did the script break? Because someone forgot to end the function."];
      out(`😂 ${jokes[Math.floor(Math.random() * jokes.length)]}`, "ok");
    } },
    { id: "roast", name: "roast <user>", desc: "Playful roast line", run: (a, p, out) => {
      if (!a[0]) { out("usage: roast <user>", "warn"); return; }
      const target = a.join(" ");
      const roasts = [`@${target}'s code is so bad even GitHub Copilot refuses to autocomplete it.`, `@${target} still uses 'print("hello")' for all their debugging.`, `If @${target} had a dollar for every bug they wrote, they'd be richer than Roblox founders.`, `@${target}'s scripts load slower than Internet Explorer on Windows 95.`, `Even the Roblox error sound (Oof) sounds better than @${target}'s logic.`, `@${target} leaves so many console.logs in production the server logs are weeping.`, `@${target} writes spaghetti code so advanced Italian chefs are taking notes.`];
      out(`🔥 ${roasts[Math.floor(Math.random() * roasts.length)]}`, "warn");
    } },
    { id: "sysinfo", name: "sysinfo", desc: "Live server info (uptime, memory, requests)", roles: ["admin", "tester"], run: (a, p, out) => sysinfoCmd(out) },
    { id: "audit", name: "audit [user]", desc: "Security audit trail (ban/give-robux/maintenance...)", roles: ["admin"], run: (a, p, out) => auditCmd(a, out) },
    { id: "threat", name: "threat", desc: "Scan logs for brute-force / spam threats", roles: ["admin", "tester"], run: (a, p, out) => threatCmd(out) },
    { id: "maintenance", name: "maintenance <on|off>", desc: "Toggle global maintenance screen for EVERYONE", roles: ["admin"], run: (a, p, out) => maintCmd(a, out) },
    { id: "market", name: "market [ticker]", desc: "Simulated script-ticker market (paper trading)", run: (a, p, out) => marketCmd(a, out) },
    { id: "buy", name: "buy <ticker> <qty>", desc: "Buy simulated shares (paper $5000 start)", run: (a, p, out) => tradeCmd("buy", a, out) },
    { id: "sell", name: "sell <ticker> <qty>", desc: "Sell simulated shares", run: (a, p, out) => tradeCmd("sell", a, out) },
    { id: "portfolio", name: "portfolio", desc: "Your paper portfolio + net worth", run: (a, p, out) => portfolioCmd(out) },
    { id: "rank", name: "rank [user]", desc: "Show level & XP (deterministic from activity)", run: (a, p, out) => rankCmd(a, out) },
    { id: "leaderboard", name: "leaderboard", desc: "Top buyers, top scripts and your rank", run: (a, p, out) => leaderboardCmd(out) },
    { id: "donate", name: "donate <amount> [note]", desc: "Donate Robux to support CapyScripts", run: (a, p, out) => donateCmd(a, out) },
    { id: "donors", name: "donors", desc: "Donation leaderboard (admins/testers hidden)", run: (a, p, out) => donorsCmd(out) }
  ];

  function currentRole() {
    return user ? (user.role || "user") : "guest";
  }

  function canUse(cmdId) {
    const c = ADMIN_COMMANDS.find((x) => x.id === cmdId);
    if (!c) return true;
    if (c.userOnly) return !!(user && user.username.toLowerCase() === c.userOnly);
    if (!c.roles) return true;
    return c.roles.indexOf(currentRole()) !== -1;
  }

  function testDataCmd(out, asFile) {
    if (!token) { out("sign in first", "err"); return; }
    fetch("/api/test-data?token=" + encodeURIComponent(token))
      .then((r) => r.json()).then((d) => {
        if (!d.valid) { out("denied: " + (d.reason === "not_tester" ? "requires admin or tester role" : (d.reason || "unknown")), "err"); return; }
        if (asFile) {
          const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob);
          a.download = "capy-test-data.json";
          a.click();
          URL.revokeObjectURL(a.href);
          out("exported capy-test-data.json (" + d.counts.users + " users, " + d.counts.keys + " keys)", "ok");
          return;
        }
        const c = d.counts;
        out(`users : ${c.users}   keys : ${c.keys}   scripts : ${c.scripts}   sales_value : ${c.sales_value}`, "ok");
        d.users.forEach((u) => out(`${u.username.padEnd(18)} [${u.role}] robux=${u.robux}${u.infinite ? " ∞" : ""} buys=${u.purchases}`, "dim"));
      }).catch(() => out("cannot reach server", "err"));
  }

  function logsCmd(args, out) {
    if (!token) { out("sign in first", "err"); return; }
    const raw = parseInt(args[0], 10);
    const limit = Number.isFinite(raw) && raw > 0 ? raw : 30;
    fetch("/api/logs?token=" + encodeURIComponent(token))
      .then((r) => r.json()).then((d) => {
        if (!d.valid) { out("logs denied: " + (d.reason === "not_admin" ? "admin role required" : (d.reason || "unknown")), "err"); return; }
        const entries = d.logs.slice(0, limit);
        if (!entries.length) { out("no log entries yet", "warn"); return; }
        out(`${entries.length} of ${d.count} log entries (newest first):`, "ok");
        entries.forEach((e) => {
          const t = e.ts ? e.ts.slice(11, 19) : "--:--:--";
          out(`${t}  ${e.event.padEnd(12)} ${e.user.padEnd(14)} ${e.detail ? "  " + e.detail : ""}${e.ip ? "  [" + e.ip + "]" : ""}`, "dim");
        });
      }).catch(() => out("cannot reach server", "err"));
  }

  function adminPost(url, body) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ token }, body))
    }).then((r) => r.json());
  }

  function banCmd(action, args, out) {
    if (!args[0]) { out("usage: " + action + " <user> [reason]", "warn"); return; }
    const body = { username: args[0], reason: args.slice(1).join(" ") };
    adminPost("/api/" + action, body).then((d) => {
      if (d.valid) {
        out(`${action} OK → ${d.user.username}`, "ok");
        toast(action === "ban" ? `Banned: ${d.user.username}` : `Unbanned: ${d.user.username}`, action === "ban" ? "error" : "success");
      } else { out(action + " failed: " + (adminErr(d.reason) || d.reason || "unknown"), "err"); }
    }).catch(() => out("cannot reach server", "err"));
  }

  function walletCmd(args, out) {
    if (args.length < 2) { out("usage: wallet <user> <amount>  (negative = deduct)", "warn"); return; }
    const amt = parseInt(args[1], 10);
    if (!Number.isFinite(amt)) { out("amount must be a number", "err"); return; }
    adminPost("/api/wallet", { username: args[0], amount: amt }).then((d) => {
      if (d.valid) {
        out(`OK → ${d.user.username} wallet = $${d.wallet}`, "ok");
        toast(`${amt >= 0 ? "+" : ""}${amt} RB$ applied to ${d.user.username}`, "success");
      } else { out("wallet failed: " + (adminErr(d.reason) || d.reason || "unknown"), "err"); }
    }).catch(() => out("cannot reach server", "err"));
  }

  function lookCmd(args, out) {
    if (!args[0]) { out("usage: robux <user>", "warn"); return; }
    adminPost("/api/lookup", { username: args[0] }).then((d) => {
      if (d.valid) {
        const u = d.user;
        out(`${u.username} [${u.role}]${u.banned ? " ⛔BANNED — " + (u.banReason || "") : ""}`, u.banned ? "err" : "ok");
        out(`  wallet : $${u.wallet}   purchases : ${u.purchases}`, "dim");
        if (u.roblox) out(`  roblox : @${u.roblox.name} · ${u.roblox.infinite ? "∞" : robux(u.roblox.robux)} · ${u.roblox.verified ? "verified" : "unverified"}`, "dim");
        else out("  roblox : not linked", "dim");
      } else { out("lookup failed: " + (adminErr(d.reason) || d.reason || "unknown"), "err"); }
    }).catch(() => out("cannot reach server", "err"));
  }

  function sessionsCmd(out) {
    fetch("/api/sessions?token=" + encodeURIComponent(token))
      .then((r) => r.json()).then((d) => {
        if (!d.valid) { out("sessions denied: " + (d.reason || "unknown"), "err"); return; }
        out(`${d.count} active session(s):`, "ok");
        d.sessions.forEach((s) => out(`  ${s.username} [${s.role}] ×${s.count}`, "dim"));
      }).catch(() => out("cannot reach server", "err"));
  }

  function pingCmd(out, timeOnly) {
    const start = Date.now();
    fetch("/health").then((r) => r.json()).then(() => out(`pong in ${Date.now() - start}ms`, "ok")).catch(() => out("pong: server unreachable", "err"));
    if (timeOnly) {
      fetch("/health").then((r) => r.json()).then((d) => out("server time: " + (d.time ? d.time.replace("T", " ") : "?"), "dim")).catch(() => {});
    }
  }

  function statsCmd(out) {
    fetch("/api/stats").then((r) => r.json()).then((d) => {
      if (!d.valid) { out("stats failed", "err"); return; }
      const c = d.counts;
      out(`users : ${c.users}   keys : ${c.keys}   scripts : ${c.scripts}`, "ok");
      out(`purchases : ${c.purchases}   revenue : ${money(c.revenue)}`, "ok");
      out(`message : ${d.message.active ? "active" : "none"}`, d.message.active ? "warn" : "dim");
      if (d.topUsers.length) { out("top buyers: " + d.topUsers.map((u) => `${u.username}(${u.purchases})`).join(", "), "dim"); }
      if (d.byScript.length) { out("top scripts: " + d.byScript.slice(0, 4).map((s) => `${s.script}(${s.count})`).join(", "), "dim"); }
    }).catch(() => out("cannot reach server", "err"));
  }

  function fmtUptime(sec) {
    const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60;
    return d + "d " + h + "h " + m + "m " + s + "s";
  }

  function sysinfoCmd(out) {
    if (!token) { out("sign in first (admin/tester)", "err"); return; }
    fetch("/api/server-stats?token=" + encodeURIComponent(token), { cache: "no-store" })
      .then((r) => r.json()).then((d) => {
        if (!d.valid) { out("sysinfo denied: " + (adminErr(d.reason) || d.reason || "unknown"), "err"); return; }
        const s = d.server;
        out("HOST   " + s.hostname + "  ·  " + s.platform + "  ·  " + s.python + "  ·  pid " + s.pid, "dim");
        out("UPTIME " + fmtUptime(s.uptime_sec) + "  (since " + (s.started_at || "").replace("T", " ").slice(0, 19) + ")", "ok");
        out("MEM    " + (s.memory_mb != null ? s.memory_mb + " MB" : "n/a") + "   REQUESTS " + d.requests + "   SESSIONS " + d.sessions, "ok");
        const c = d.counts;
        out("USERS  " + c.users + "   KEYS " + c.keys + "   SCRIPTS " + c.scripts, "ok");
        out("FLAGS  maintenance=" + (d.maintenance.active ? "ON" : "off") + "  message=" + (d.message.active ? "ON" : "off"), d.maintenance.active ? "err" : "dim");
      }).catch(() => out("cannot reach server", "err"));
  }

  function auditCmd(args, out) {
    if (!token) { out("sign in as admin first", "err"); return; }
    const q = "/api/audit?token=" + encodeURIComponent(token) + (args[0] ? "&user=" + encodeURIComponent(args[0]) : "");
    fetch(q).then((r) => r.json()).then((d) => {
      if (!d.valid) { out("audit denied: " + (adminErr(d.reason) || d.reason || "unknown"), "err"); return; }
      if (!d.logs.length) { out("no trail" + (d.user ? " for @" + d.user : ""), "warn"); return; }
      out(`audit trail ${d.user ? "for @" + d.user : ""} — ${d.logs.length} of ${d.count} entries:`, "ok");
      d.logs.forEach((e) => {
        const t = e.ts ? e.ts.slice(11, 19) : "--:--:--";
        const danger = /ban|kick|failed|maintenance|wallet|give|deposit/i.test(e.event);
        out(`${t}  ${e.event.padEnd(14)} ${e.user.padEnd(14)} ${e.detail ? "  " + e.detail : ""}${e.ip ? "  [" + e.ip + "]" : ""}`, danger ? "err" : "dim");
      });
    }).catch(() => out("cannot reach server", "err"));
  }

  function threatCmd(out) {
    if (!token) { out("sign in first (admin/tester)", "err"); return; }
    fetch("/api/threat-scan?token=" + encodeURIComponent(token), { cache: "no-store" })
      .then((r) => r.json()).then((d) => {
        if (!d.valid) { out("threat denied: " + (adminErr(d.reason) || d.reason || "unknown"), "err"); return; }
        const sum = d.summary;
        out(`SCAN    ${d.scanned} log entries scanned`, "dim");
        out(`FAILS   ${sum.failed_logins} failed logins (${sum.login_failed_users} users)   BANNED ${sum.banned_users}   FLAGS ${sum.active_flags.length ? sum.active_flags.join(", ") : "none"}`, sum.failed_logins ? "warn" : "ok");
        if (d.safe) { out("CLEAN — no threats detected", "ok"); return; }
        d.findings.forEach((f) => out(`[${f.severity.toUpperCase()}] ${f.type} → ${f.subject} :: ${f.detail}`, f.severity === "high" ? "err" : "warn"));
      }).catch(() => out("cannot reach server", "err"));
  }

  function maintCmd(args, out) {
    if (!args[0] || !/^(on|off)$/i.test(args[0])) { out("usage: maintenance <on|off>", "warn"); return; }
    adminPost("/api/maintenance", { action: args[0].toLowerCase() }).then((d) => {
      if (d.valid) {
        out(`maintenance ${d.active ? "ENABLED — all users see the maintenance screen" : "disabled"}`, d.active ? "err" : "ok");
        toast(d.active ? "Maintenance mode ON" : "Maintenance mode OFF", d.active ? "error" : "success");
      } else { out("maintenance failed: " + (adminErr(d.reason) || d.reason || "unknown"), "err"); }
    }).catch(() => out("cannot reach server", "err"));
  }

  const TICKERS = [
    { t: "CAPY", name: "CapyScripts Group", base: 1500 },
    { t: "HYDRA", name: "Hydra Hub", base: 420 },
    { t: "BUTOC", name: "Blox Fruits RNG", base: 99 },
    { t: "FABUL", name: "Fabulous Scripts", base: 260 },
    { t: "ANON", name: "Anon Hunter", base: 310 },
    { t: "EDGY", name: "Edge+ Loader", base: 180 }
  ];

  function loadMarket() {
    let m;
    try { m = JSON.parse(localStorage.getItem("capy_market_v1") || "null"); } catch (e) {}
    if (!m || !m.prices) {
      const prices = {};
      TICKERS.forEach((x) => prices[x.t] = x.base);
      m = { prices, change: {} };
    }
    const change = {};
    const prices = Object.assign({}, m.prices);
    TICKERS.forEach((x) => {
      if (Math.random() < 0.7) {
        const drift = Math.round(prices[x.t] * (Math.random() * 0.08 - 0.04) * (Math.random() < 0.5 ? -1 : 1));
        change[x.t] = drift;
        prices[x.t] = Math.max(5, prices[x.t] + drift);
      } else { change[x.t] = 0; }
    });
    const next = { prices, change };
    try { localStorage.setItem("capy_market_v1", JSON.stringify(next)); } catch (e) {}
    return next;
  }

  function resolveTicker(q) {
    const needle = (q || "").toUpperCase();
    if (!needle) return null;
    const exact = TICKERS.find((x) => x.t === needle);
    if (exact) return exact;
    return TICKERS.find((x) => x.t.indexOf(needle) === 0 || x.name.toUpperCase().indexOf(needle) !== -1) || null;
  }

  function loadPortfolio() {
    let p;
    try { p = JSON.parse(localStorage.getItem("capy_portfolio_v1") || "null"); } catch (e) {}
    if (!p || typeof p.cash !== "number") p = { cash: 5000, holdings: {} };
    return p;
  }

  function savePortfolio(p) {
    try { localStorage.setItem("capy_portfolio_v1", JSON.stringify(p)); } catch (e) {}
  }

  function marketCmd(args, out) {
    const m = loadMarket();
    const focus = args[0] ? resolveTicker(args[0]) : null;
    if (args[0] && !focus) { out("unknown ticker: " + args[0] + " (try capy/hydra/butoc/fabul/anon/edgy)", "err"); return; }
    out("CAPY PAPER MARKET — simulated prices (demo, per browser)", "in");
    TICKERS.forEach((x) => {
      if (focus && x.t !== focus.t) return;
      const p = m.prices[x.t], ch = m.change[x.t] || 0;
      const arrow = ch > 0 ? "▲" : ch < 0 ? "▼" : "•";
      out(`${x.t.padEnd(7)} ${x.name.padEnd(24)} ${p} RBX  ${arrow} ${ch > 0 ? "+" : ""}${ch}`, ch < 0 ? "warn" : "ok");
    });
    out("trade: buy <ticker> <qty>  ·  sell <ticker> <qty>  ·  portfolio  (paper $5000 start)", "dim");
  }

  function tradeCmd(action, args, out) {
    if (args.length < 2) { out("usage: " + action + " <ticker> <qty>", "warn"); return; }
    const tk = resolveTicker(args[0]);
    if (!tk) { out("unknown ticker: " + args[0], "err"); return; }
    const qty = parseInt(args[1], 10);
    if (!Number.isFinite(qty) || qty < 1) { out("qty must be a positive number", "err"); return; }
    const m = loadMarket();
    const price = m.prices[tk.t];
    const port = loadPortfolio();
    const cost = price * qty;
    if (action === "buy") {
      if (cost > port.cash) { out(`insufficient paper cash — need ${cost} RBX, have ${Math.floor(port.cash)}`, "err"); return; }
      port.cash -= cost;
      port.holdings[tk.t] = (port.holdings[tk.t] || 0) + qty;
      savePortfolio(port);
      out(`BOUGHT ${qty}× ${tk.t} @ ${price} RBX (−${cost} RBX). cash left: ${Math.floor(port.cash)}`, "ok");
      toast(`Bought ${qty} ${tk.t} (paper)`, "success");
    } else {
      const held = port.holdings[tk.t] || 0;
      if (qty > held) { out(`you only hold ${held} ${tk.t}`, "err"); return; }
      port.holdings[tk.t] = held - qty;
      if (!port.holdings[tk.t]) delete port.holdings[tk.t];
      port.cash += cost;
      savePortfolio(port);
      out(`SOLD ${qty}× ${tk.t} @ ${price} RBX (+${cost} RBX). cash: ${Math.floor(port.cash)}`, "ok");
      toast(`Sold ${qty} ${tk.t} (paper)`, "success");
    }
  }

  function portfolioCmd(out) {
    const m = loadMarket();
    const port = loadPortfolio();
    let value = port.cash;
    out(`PAPER PORTFOLIO (${user ? "@" + user.username : "guest"})`, "in");
    const rows = [];
    Object.keys(port.holdings).forEach((t) => {
      const price = m.prices[t] || 0;
      const qty = port.holdings[t];
      const val = price * qty;
      value += val;
      rows.push([t, qty, price, val]);
    });
    if (!rows.length) out("no holdings — try market / buy", "dim");
    rows.sort((a, b) => b[3] - a[3]);
    rows.forEach((r) => out(`${r[0].padEnd(7)} ${r[1]} × ${r[2]} RBX = ${r[3]} RBX`, "dim"));
    out(`CASH   ${Math.floor(port.cash)} RBX`, "ok");
    out(`NET WORTH   ${Math.floor(value)} RBX  (${value >= 5000 ? "+" : ""}${Math.floor(value - 5000)})`, value >= 5000 ? "ok" : "warn");
  }

  function hashCode(s) {
    let h = 0;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return Math.abs(h);
  }

  function xpFor(name) {
    if (!name) return 0;
    const u = name.toLowerCase();
    let xp = hashCode(u) % 300;
    if (u === "capy") xp += 420;
    if (u === "tester") xp += 100;
    if (u === "ikiz_siken123") xp += 250;
    return xp;
  }

  function levelFor(xp) { return Math.floor(Math.sqrt(xp / 100)) + 1; }
  function xpForLevel(l) { return 100 * (l - 1) * (l - 1); }
  function nextLevelXp(xp) { return xpForLevel(levelFor(xp) + 1); }

  function rankCmd(args, out) {
    const name = args[0] || (user && user.username);
    if (!name) { out("sign in first, or use: rank <user>", "warn"); return; }
    let xp = xpFor(name);
    const me = (user && user.username.toLowerCase() === name.toLowerCase()) ? user : null;
    if (me) {
      xp += (me.purchases ? me.purchases.length : 0) * 150 + (me.wallet || 0) * 0.5;
      xp = Math.floor(xp);
    }
    const lvl = levelFor(xp);
    const floor = xpForLevel(lvl), next = nextLevelXp(xp);
    const pct = next > floor ? Math.min(100, Math.floor(((xp - floor) / (next - floor)) * 100)) : 0;
    const title = lvl >= 20 ? "Capybara Legend" : lvl >= 10 ? "★ Script Master" : lvl >= 5 ? "◆ Active Seller" : "● Member";
    out(`RANK &nbsp;&nbsp;@${name}`, "in");
    out(`LEVEL ${lvl}   XP ${Math.floor(xp)} / ${next}  (${pct}% to next)   ${title}`, "ok");
  }

  function leaderboardCmd(out) {
    out("LOADING leaderboard...", "dim");
    fetch("/api/stats").then((r) => r.json()).then((d) => {
      if (!d.valid) { out("stats failed", "err"); return; }
      out("CAPY LEADERBOARD — LIVE", "in");
      out("— TOP BUYERS (real) —", "ok");
      const tops = (d.topUsers || []).slice(0, 10);
      if (!tops.length) out("  none yet — be the first buyer!", "dim");
      tops.forEach((u, i) => { out(`${i + 1}. ${u.username.padEnd(20)} ${u.purchases} buys`, i < 3 ? "ok" : "dim"); });
      out("— TOP SCRIPTS —", "ok");
      (d.byScript || []).slice(0, 5).forEach((s, i) => out(`${i + 1}. ${s.script.padEnd(22)} ${s.count} sales`, "dim"));
      if (!tops.length) out("  no sales yet", "dim");
    }).catch(() => out("cannot reach server", "err"));
  }

  function donateCmd(args, out) {
    if (!user) { out("sign in first — donate requires an account", "err"); return; }
    const amount = parseInt(args[0], 10);
    if (!Number.isFinite(amount) || amount < 1) { out("usage: donate <amount> [note]  (amount in Robux)", "warn"); return; }
    const note = args.slice(1).join(" ").trim();
    fetch("/api/donate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, amount, note })
    }).then((r) => r.json()).then((d) => {
      if (d.valid) {
        user = d.user;
        const rem = user.roblox ? user.roblox.robux : 0;
        out(`💛 THANK YOU! Donated ${robux(amount)} — balance now ${robux(rem)} (all-time donations ${robux(d.total_all)})`, "ok");
        toast(`Donated ${amount} Robux — thank you! 💛`, "success");
      } else {
        const map = {
          role_not_allowed: "admins and testers cannot donate (leaderboard is for users)",
          roblox_not_linked: "no linked Roblox balance for this account",
          infinite_balance: "infinite balance — cannot donate",
          insufficient_robux: "not enough Robux in your balance",
          bad_amount: "amount must be between 1 and 10,000,000",
          banned: "this account is banned",
          invalid_token: "session expired — sign in again"
        };
        out("donate failed: " + (map[d.reason] || d.reason || "unknown"), "err");
      }
    }).catch(() => out("cannot reach server", "err"));
  }

  function donorsCmd(out) {
    fetch("/api/donations").then((r) => r.json()).then((d) => {
      if (!d.valid) { out("donations failed", "err"); return; }
      out("CAPY DONATION LEADERBOARD", "in");
      out(`TOTAL   ${robux(d.total)} from ${d.count} donations (admins/testers excluded)`, "ok");
      if (!d.leaderboard.length) { out("no donations yet — be the first!  (type: donate 100)", "dim"); return; }
      d.leaderboard.slice(0, 10).forEach((row, i) => { out(`${i + 1}. ${row.user.padEnd(20)} ${robux(row.total)}  ×${row.count}`, i < 3 ? "ok" : "dim"); });
      out("— RECENT —", "ok");
      d.donations.slice(0, 5).forEach((x) => { out(`  ${x.user}  +${robux(x.amount)}${x.note ? "  \"" + x.note + "\"" : ""}  (${(x.ts || "").slice(0, 19).replace("T", " ")})`, "dim"); });
    }).catch(() => out("cannot reach server", "err"));
  }

  function announceCmd(args, out) {
    if (!args.length) { out("usage: announce <message>  |  announce clear", "warn"); return; }
    const text = args.join(" ").trim();
    adminPost("/api/announce", { text }).then((d) => {
      if (d.valid) {
        out(d.active ? `📢 announced to everyone: "${d.text}"` : "announcement cleared", "ok");
        toast(d.active ? "Message sent to everyone" : "Announcement cleared", "success");
      } else { out("announce failed: " + (adminErr(d.reason) || d.reason || "unknown"), "err"); }
    }).catch(() => out("cannot reach server", "err"));
  }

  function adminErr(reason) {
    return ({
      not_admin: "admin role required",
      not_tester: "requires admin or tester role",
      target_not_found: "user doesn't exist",
      bad_amount: "bad amount",
      bad_action: "bad action",
      too_long: "message too long (max 220)"
    })[reason];
  }

  function outInnerClear() {
    const el = $("#adminOut");
    if (el) el.innerHTML = "";
  }

  async function pollMessage() {
    try {
      const res = await fetch("/api/message-state?v=" + Date.now(), { cache: "no-store" });
      const d = await res.json();
      if (!d.valid) return;
      const b = $("#announceBanner");
      const t = $("#announceText");
      if (!b || !t) return;
      if (d.text) {
        if (b.dataset.cur !== d.text + d.at) {
          b.dataset.cur = d.text + d.at;
          t.textContent = d.text;
        }
        b.classList.remove("hidden");
      } else {
        b.dataset.cur = "";
        b.classList.add("hidden");
      }
    } catch (e) {}
  }

  let _lastMaint = false;
  async function pollMaintenance() {
    try {
      const res = await fetch("/api/maintenance-state?v=" + Date.now(), { cache: "no-store" });
      const d = await res.json();
      if (d.valid && d.active !== _lastMaint) {
        _lastMaint = d.active;
        const ov = $("#maintOverlay");
        if (ov) { ov.classList.toggle("show", d.active); capyLog(d.active ? "Maintenance mode engaged" : "Maintenance mode disabled", d.active ? "err" : "ok"); }
      }
    } catch (e) {}
  }

  function giveRobuxCmd(args, p, out) {
    if (!user) { out("sign in first", "err"); return; }
    let targetUser = null;
    let amtIdx = 0;
    if (args.length >= 2 && !/^\d+$/.test(args[0] || "")) { targetUser = args[0]; amtIdx = 1; }
    const amt = parseInt(args[amtIdx], 10);
    const amount = Number.isFinite(amt) && amt > 0 ? amt : 500;
    const endpoint = targetUser ? "/api/give-robux" : "/api/robux-deposit";
    const body = targetUser ? { token, username: targetUser, amount } : { token, amount };
    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }).then((r) => r.json()).then((data) => {
      if (data.valid && data.user) {
        const rb = data.user.roblox ? data.user.roblox.robux : 0;
        if (targetUser) {
          out(`OK +${amount} RBX → @${data.user.roblox.name} (balance ${robux(rb)})`, "ok");
          toast(`+${amount} Robux granted to ${data.user.username}`, "success");
        } else {
          user = data.user;
          out(`OK +${amount} RBX → @${user.roblox.name} (balance ${robux(robuxBalance())})`, "ok");
          toast(`+${amount} Robux granted`, "success");
        }
      } else {
        const map = {
          not_tester: "requires admin or tester role",
          target_not_found: "that user doesn't exist",
          target_roblox_not_linked: "that user has no linked Roblox",
          insufficient_robux: "insufficient robux",
          roblox_not_linked: "link a Roblox account first",
          invalid_token: "session expired — sign in again"
        };
        out("give-robux failed: " + (map[data.reason] || data.reason || "unknown"), "err");
      }
    }).catch(() => out("cannot reach server", "err"));
  }

  function robuxBalance() {
    if (!user || !user.roblox) return 0;
    return user.roblox.infinite ? Infinity : user.roblox.robux;
  }

  function adminPrint(msg, cls) {
    const out6 = $("#adminOut");
    if (!out6) return;
    const row = document.createElement("div");
    row.className = "a-" + (cls || "dim");
    row.textContent = msg;
    out6.appendChild(row);
    out6.scrollTop = out6.scrollHeight;
  }

  function adminExec(line) {
    const parts = line.trim().split(/\s+/);
    const id = (parts[0] || "").toLowerCase();
    const args = parts.slice(1);
    const cmd = ADMIN_COMMANDS.find((c) => c.id === id);
    if (!cmd) { adminPrint(`command not found: ${id || "(empty)"} — type help`, "err"); return; }
    adminPrint(`> ${line.trim()}`, "in");
    if (!canUse(cmd.id)) {
      adminPrint(cmd.userOnly ? `⛔ access denied — only the exact ${cmd.userOnly} account can do this` : `⛔ access denied — requires ${cmd.roles.join(" or ")} role`, "err");
      return;
    }
    cmd.run(args, null, adminPrint);
  }

  function renderAdminList() {
    const el = $("#adminList");
    if (!el) return;
    el.innerHTML = ADMIN_COMMANDS.map((c) => {
      const ok = canUse(c.id);
      let tag = "";
      if (c.roles) tag = ` <b class="rbadge">${c.roles.join("/")}</b>`;
      else if (c.userOnly) tag = ` <b class="rbadge">USER ${c.userOnly}</b>`;
      return `<button class="acmd${ok ? "" : " locked"}" data-cmd="${c.id}" title="${ok ? "" : (c.userOnly ? "only the " + c.userOnly + " account" : "requires " + c.roles.join("/"))}"><b>&gt; ${c.name}</b><span>${c.desc}${tag}</span></button>`;
    }).join("");
  }

  function toggleAdminConsole() {
    const el = $("#adminConsole");
    const show = !el.classList.contains("show");
    el.classList.toggle("show", show);
    if (show) { renderAdminList(); adminPrint("CAPY ADMIN CONSOLE ready — type help", "title"); }
    capyLog(show ? "Admin console opened" : "Admin console closed", "info");
  }

  /* ================= SHOP ================= */

  function visibleScripts() {
    let list = SCRIPTS.slice();

    if (state.category !== "all") {
      list = list.filter((s) => s.category === state.category);
    }

    if (state.search.trim()) {
      const q = state.search.trim().toLowerCase();
      list = list.filter(
        (s) =>
          s.name.toLowerCase().includes(q) ||
          s.game.toLowerCase().includes(q) ||
          s.category.toLowerCase().includes(q)
      );
    }

    switch (state.sort) {
      case "cheap": list.sort((a, b) => currentPrice(a) - currentPrice(b)); break;
      case "expensive": list.sort((a, b) => currentPrice(b) - currentPrice(a)); break;
      case "rating": list.sort((a, b) => b.rating - a.rating); break;
      default:
        list.sort((a, b) => Number(b.featured) - Number(a.featured) || Number(b.bestseller) - Number(a.bestseller) || b.sales - a.sales);
    }

    return list;
  }

  function cardHTML(s) {
    const owned = ownedSet().has(s.id);
    const inCart = cart.includes(s.id);
    const discount = s.oldPrice ? Math.round((1 - s.price / s.oldPrice) * 100) : 0;

    let ribbon = "";
    if (s.bestseller) ribbon = `<span class="card-cat" style="right:auto;left:10px;">🔥 BESTSELLER</span>`;
    else if (s.new) ribbon = `<span class="card-cat" style="right:auto;left:10px;background:rgba(212,175,55,0.6);color:#23150a;">● NEW</span>`;
    else if (s.oldPrice) ribbon = `<span class="card-cat" style="right:10px;left:auto;background:rgba(216,30,44,0.75);">-${discount}%</span>`;

    const pricePart = owned
      ? `<span class="owned-pill">✓ OWNED</span>`
      : `<span class="card-price">${s.oldPrice ? `<span class="old">${money(s.oldPrice)}</span>` : ""}${money(s.price)}</span>`;

    return `
      <article class="card" data-id="${s.id}">
        <div class="card-thumb" style="background:${s.gradient}">
          ${ribbon}
          <span class="thumb-em">${s.emoji}</span>
          <span class="card-cat" style="top:auto;bottom:10px;left:10px;right:auto;">${s.category}</span>
        </div>
        <div class="card-body">
          <div class="card-title">${s.name}</div>
          <div class="card-maker">${s.game}</div>
          <div class="card-foot">
            ${pricePart}
            ${owned ? `<span class="card-rating" style="color:var(--moss);">✓</span>` : inCart ? `<span class="card-rating">✓ In cart</span>` : `<span class="card-rating">★ ${s.rating.toFixed(1)}</span>`}
          </div>
          <div class="card-maker">${s.sales.toLocaleString("en-US")} sales · ${s.updates}</div>
        </div>
      </article>`;
  }

  function renderGrid() {
    const grid = $("#productGrid");
    const list = visibleScripts();

    $("#emptyState").classList.toggle("hidden", list.length > 0);
    grid.innerHTML = list.map(cardHTML).join("");
  }

  function renderChips() {
    const wrap = $("#categoryChips");
    wrap.innerHTML = CATEGORIES.map(
      (c) =>
        `<button class="chip ${state.category === c.id ? "active" : ""}" data-cat="${c.id}">${c.label}</button>`
    ).join("");
  }

  /* ================= DETAIL MODAL ================= */

  function openDetail(id) {
    const s = SCRIPTS.find((x) => x.id === id);
    if (!s) return;
    state.detailId = id;
    const owned = ownedSet().has(id);
    const inCart = cart.includes(id);

    $("#detailCover").style.background = s.gradient;
    $("#detailCover").innerHTML = `<span class="thumb-em">${s.emoji}</span>`;
    $("#detailCat").textContent = s.category;
    $("#detailName").textContent = s.name;
    $("#detailRating").innerHTML = `★ ${s.rating.toFixed(1)}`;
    $("#detailGame").textContent = s.game;
    $("#detailSales").textContent = `${s.sales.toLocaleString("en-US")} sales`;
    $("#detailUpdates").textContent = `updates: ${s.updates}`;
    $("#detailDesc").textContent = s.desc;
    $("#detailFeatures").innerHTML = s.features.map((f) => `<li><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 13l4 4L19 7"/></svg>${f}</li>`).join("");

    if (s.oldPrice) {
      $("#detailPrice").innerHTML = `<span class="old">${money(s.oldPrice)}</span>${money(s.price)} <span style="font-size:12px;color:var(--moss);">-${Math.round((1 - s.price / s.oldPrice) * 100)}%</span>`;
    } else {
      $("#detailPrice").textContent = money(s.price);
    }

    const buyBtn = $("#detailAdd");
    buyBtn.classList.toggle("hidden", owned);
    $("#detailOwned").classList.toggle("hidden", !owned);
    buyBtn.textContent = inCart ? "Added to Cart ✓" : "Add to Cart";

    $("#detailModal").classList.add("show");
    $("#detailBackdrop").classList.add("show");
    document.body.style.overflow = "hidden";
  }

  function closeDetail() {
    $("#detailModal").classList.remove("show");
    $("#detailBackdrop").classList.remove("show");
    document.body.style.overflow = "";
  }

  /* ================= CART ================= */

  function cartCount() { return cart.length; }

  function cartTotal() {
    return cart.reduce((sum, id) => {
      const s = SCRIPTS.find((x) => x.id === id);
      return sum + (s ? currentPrice(s) : 0);
    }, 0);
  }

  function discountFor() {
    return state.pay === "btc" ? 0.05 : 0;
  }

  function payableTotal() {
    return Math.round(cartTotal() * (1 - discountFor()) * 100) / 100;
  }

  function updateCartBadge() {
    const badge = $("#cartBadge");
    const n = cartCount();
    badge.textContent = n;
    badge.classList.toggle("hidden", n === 0);
  }

  function renderCart() {
    updateCartBadge();

    const items = $("#cartItems");
    const empty = $("#cartEmpty");
    const foot = $("#cartFoot");

    if (cart.length === 0) {
      items.innerHTML = "";
      empty.classList.remove("hidden");
      foot.classList.add("hidden");
      return;
    }

    empty.classList.add("hidden");
    foot.classList.remove("hidden");

    items.innerHTML = cart
      .map((id) => {
        const s = SCRIPTS.find((x) => x.id === id);
        return `
          <div class="cart-item">
            <div class="cart-thumb" style="background:${s.gradient}"><span class="thumb-em">${s.emoji}</span></div>
            <div class="cart-info"><b>${s.name}</b><span>${s.game} · ${money(currentPrice(s))}</span></div>
            <button class="cart-remove" data-remove="${id}" title="Remove">✕</button>
          </div>`;
      })
      .join("");

    $("#cartTotal").textContent = money(cartTotal());
  }

  function addToCart(id) {
    const s = SCRIPTS.find((x) => x.id === id);
    if (!s) return;
    if (cart.includes(id)) { toast(`${s.name} is already in your cart`, "error"); return; }
    if (ownedSet().has(id)) { toast("You already own this script", "error"); return; }
    cart.push(id);
    save("sh_cart", cart);
    renderCart();
    renderGrid();
    if (state.detailId === id) openDetail(id);
    toast(`${s.name} added to cart`, "success");
  }

  function removeFromCart(id) {
    cart = cart.filter((x) => x !== id);
    save("sh_cart", cart);
    renderCart();
    renderGrid();
    if (state.detailId === id) openDetail(id);
  }

  function addAllToCart() {
    const owned = ownedSet();
    let added = 0;
    let total = 0;
    SCRIPTS.forEach((s) => {
      if (owned.has(s.id) || cart.includes(s.id)) return;
      cart.push(s.id);
      added++;
      total += currentPrice(s);
    });
    if (added === 0) { toast("Everything is already owned or in your cart", "info"); return; }
    save("sh_cart", cart);
    renderCart();
    renderGrid();
    toast(`Added ${added} scripts to cart — ${money(total)}`, "success");
    openCart();
  }

  function openCart() {
    renderCart();
    $("#cartDrawer").classList.add("show");
    $("#cartBackdrop").classList.add("show");
    document.body.style.overflow = "hidden";
  }

  function closeCart() {
    $("#cartDrawer").classList.remove("show");
    $("#cartBackdrop").classList.remove("show");
    document.body.style.overflow = "";
  }

  /* ================= CHECKOUT ================= */

  function renderCheckout() {
    $("#checkoutLines").innerHTML = cart
      .map((id) => {
        const s = SCRIPTS.find((x) => x.id === id);
        return `<div class="checkout-line"><span>${s.name} <small>· ${s.game}</small></span><b>${money(currentPrice(s))}</b></div>`;
      })
      .join("") +
      (discountFor() > 0
        ? `<div class="checkout-line"><span>Crypto Discount (5%)</span><b style="color:var(--moss);">-${money(Math.round(cartTotal() * 0.05 * 100) / 100)}</b></div>`
        : "");

    $("#checkoutTotal").textContent = money(payableTotal());
    $("#payAmount").textContent = money(payableTotal());
  }

  function openCheckout() {
    if (cart.length === 0) return;
    if (!user) {
      closeCart();
      toast("Sign in first", "error");
      state.authMode = "login";
      openAuth();
      return;
    }
    renderCheckout();
    $("#checkoutModal").classList.add("show");
    $("#checkoutBackdrop").classList.add("show");
    document.body.style.overflow = "hidden";
  }

  function closeCheckout() {
    $("#checkoutModal").classList.remove("show");
    $("#checkoutBackdrop").classList.remove("show");
    document.body.style.overflow = "";
  }

  async function doPurchase(items) {
    if (!token) return null;
    try {
      const res = await fetch("/api/purchase", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, method: state.pay, items })
      });
      return await res.json();
    } catch (e) {
      return null;
    }
  }

  async function completePurchase() {
    const items = cart.map((id) => ({ script: id }));
    const data = await doPurchase(items);

    if (!data || !data.valid) {
      const reason = data && data.reason;
      if (reason === "login_required") { toast("Sign in first", "error"); openAuth(); }
      else if (reason === "script_not_found") { toast(`"${items[0] ? items[0].script : "?"}" is not purchasable on the server yet`, "error"); }
      else toast("Payment could not be processed. Is the server running?", "error");
      return false;
    }

    user = data.user;
    const keyByScript = Object.fromEntries(data.keys.map((r) => [r.script, r.key]));
    const keys = cart.map((id) => {
      const s = SCRIPTS.find((x) => x.id === id);
      return { s, key: keyByScript[id] };
    }).filter((k) => k.key);

    cart = [];
    save("sh_cart", cart);
    renderCart();
    renderGrid();
    updateAuthUI();
    updateLibCount();

    $("#successList").innerHTML = keys
      .map(
        (k) => `
        <div>
          <div class="sl-name"><span style="font-weight:600;">${k.s.name}</span><span style="color:var(--text-faint);">${k.s.game}</span></div>
          <div class="sl-key">${k.key}</div>
          <div class="sl-actions">
            <a class="copy-btn dl-btn" href="/api/download?key=${encodeURIComponent(k.key)}&script=${encodeURIComponent(k.s.id)}">Download ↓</a>
            <button class="copy-btn" data-key="${k.key}">Copy</button>
          </div>
        </div>`
      )
      .join("");

    closeCart();
    closeCheckout();
    $("#successModal").classList.add("show");
    $("#successBackdrop").classList.add("show");
    toast("Script + license key generated", "success");
    mascotCoverEyes();
    return true;
  }

  async function processPayment() {
    if (cart.length === 0) return;
    if (!user) { toast("Sign in first", "error"); openAuth(); return; }

    const btn = $("#payBtn");
    const original = btn.innerHTML;
    btn.disabled = true;
    btn.textContent = "Processing...";

    setTimeout(async () => {
      await completePurchase();
      btn.disabled = false;
      btn.innerHTML = original;
    }, 1200);
  }

  /* ================= LIBRARY ================= */

  function myPurchases() {
    return user ? user.purchases : [];
  }

  function updateLibCount() {
    const n = myPurchases().length;
    const el = $("#navLibCount");
    if (el) el.textContent = n ? `(${n})` : "";
  }

  function renderLibrary() {
    const grid = $("#libraryGrid");
    const empty = $("#libEmpty");

    updateLibCount();

    if (myPurchases().length === 0) {
      grid.innerHTML = "";
      empty.classList.remove("hidden");
      return;
    }

    empty.classList.add("hidden");
    grid.innerHTML = myPurchases()
      .map((p) => {
        const s = SCRIPTS.find((x) => x.id === p.script) || { gradient: "linear-gradient(135deg,#222,#333)", emoji: "📜", name: p.script, game: "" };
        const days = dayDiff(p.date);
        const act = days <= 730;
        return `
          <div class="lib-row">
            <div class="lib-thumb" style="background:${s.gradient}"><span class="thumb-em">${s.emoji}</span></div>
            <div class="lib-info">
              <b>${s.name || p.script}</b>
              <span>${s.game || ""} · ${new Date(p.date).toLocaleDateString("en-US")} · ${money(p.price)}</span>
              <div class="lib-key">
                <code>${p.key}</code>
                <a class="copy-btn dl-btn" href="/api/download?key=${encodeURIComponent(p.key)}&script=${encodeURIComponent(p.script)}">Download</a>
                <button class="copy-btn" data-key="${p.key}">Copy</button>
              </div>
              <span class="status-badge ${act ? "status-live" : "status-act"}">${act ? "● ACTIVE" : "● NEEDS RENEWAL"}</span>
            </div>
          </div>`;
      })
      .join("");
  }

  /* ================= VIEWS ================= */

  function showView(name) {
    $("#shopView").classList.toggle("hidden", name !== "shop");
    $("#libraryView").classList.toggle("hidden", name !== "library");
    $$(".view").forEach((v) => v.classList.toggle("active", v.id === name + "View"));
    $$("[data-nav]").forEach((l) => l.classList.toggle("active", l.dataset.nav === name));
    if (name === "library") renderLibrary();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  /* ================= AUTH ================= */

  function openAuth() {
    $("#authModal").classList.add("show");
    $("#authBackdrop").classList.add("show");
    document.body.style.overflow = "hidden";
    updateAuthTabs();
  }

  function closeAuth() {
    $("#authModal").classList.remove("show");
    $("#authBackdrop").classList.remove("show");
    document.body.style.overflow = "";
  }

  function updateAuthTabs() {
    const isLogin = state.authMode === "login";
    $("#tabLogin").classList.toggle("active", isLogin);
    $("#tabSignup").classList.toggle("active", !isLogin);
    $("#authSubmit").textContent = isLogin ? "Sign In" : "Create Account";
    $("#authTitle").innerHTML = isLogin ? 'Sign <i>in</i>' : 'Create <i>account</i>';
    $("#authSub").textContent = isLogin ? "Welcome back — your library is waiting." : "A free account to save and re-download your purchases.";
    $("#fldConfirm").classList.toggle("hidden", isLogin);
    $("#termsWrap").classList.toggle("hidden", isLogin);
    $("#authPassword").placeholder = isLogin ? "Password" : "Password (min 6 chars)";
    $("#authPassword").autocomplete = isLogin ? "current-password" : "new-password";
    $("#authError").classList.add("hidden");
  }

  function setAuthError(msg) {
    const el = $("#authError");
    el.textContent = msg;
    el.classList.remove("hidden");
  }

  async function submitAuth() {
    const username = $("#authUsername").value.trim();
    const password = $("#authPassword").value;
    if (!username || !password) { setAuthError("Username and password cannot be empty."); return; }
    if (state.authMode === "signup") {
      if (password.length < 6) { setAuthError("Password must be at least 6 characters."); return; }
      const confirm = $("#authConfirm").value;
      if (confirm !== password) { setAuthError("Passwords do not match."); return; }
      if (!$("#authTerms").checked) { setAuthError("Please accept the Terms & Privacy Policy."); return; }
    }

    const btn = $("#authSubmit");
    btn.disabled = true;
    btn.textContent = "Please wait...";

    try {
      const res = await fetch("/api/" + (state.authMode === "login" ? "login" : "signup"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (data.valid && data.token) {
        token = data.token;
        save("sh_token", token);
        user = data.user;
        updateAuthUI();
        renderLibrary();
        renderGrid();
        closeAuth();
        toast(state.authMode === "login" ? `Welcome, ${user.username}!` : "Account created! 🎉", "success");
      } else {
        const reasons = {
          invalid_username: "Username must be 3-20 characters (letters/numbers/_).",
          weak_password: "Password must be at least 6 characters.",
          username_taken: "This username is already taken.",
          bad_credentials: "Incorrect username or password.",
          banned: "This account has been banned."
        };
        setAuthError(reasons[data.reason] || "Could not be accepted.");
      }
    } catch (e) {
      setAuthError("Cannot reach server.");
    }

    btn.disabled = false;
    btn.textContent = state.authMode === "login" ? "Sign In" : "Create Account";
  }

  function logout() {
    if (token) {
      fetch("/api/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token })
      }).catch(() => {});
    }
    token = "";
    user = null;
    save("sh_token", "");
    updateAuthUI();
    renderGrid();
    renderLibrary();
    toast("Signed out", "");
  }

  function updateAuthUI() {
    const loginBtn = $("#loginBtn");
    const chip = $("#userChip");
    if (user) {
      loginBtn.classList.add("hidden");
      chip.classList.remove("hidden");
      $("#userName").textContent = user.username;
    } else {
      loginBtn.classList.remove("hidden");
      chip.classList.add("hidden");
    }
  }

  async function restoreSession() {
    if (!token) { updateAuthUI(); return; }
    try {
      const res = await fetch("/api/me?token=" + encodeURIComponent(token));
      const data = await res.json();
      if (data.valid && data.user) {
        user = data.user;
      } else {
        token = "";
        save("sh_token", "");
      }
    } catch (e) {}
    updateAuthUI();
    updateLibCount();
    renderCart();
    renderGrid();
  }

  /* ================= HERO ================= */

  function renderHeroVisual() {
    const wrap = $("#heroVisual");
    if (!wrap) return;
    const top3 = SCRIPTS.slice().sort((a, b) => b.sales - a.sales).slice(0, 3);
    if (top3.length < 3) return;
    const cards = [
      { cls: "fc-1", s: top3[0] || top3[0] },
      { cls: "fc-2", s: top3[1] || top3[0] },
      { cls: "fc-3", s: top3[2] || top3[0] }
    ];
    wrap.innerHTML = cards.map((c) => `
      <div class="float-card ${c.cls}">
        <div class="ft-thumb" style="background:${c.s.gradient}"><span class="ft-em">${c.s.emoji}</span></div>
        <b>${c.s.name}</b><span>${money(c.s.price)} · ${c.s.sales.toLocaleString("en-US")} sales</span>
      </div>`).join("");
  }

  function animateCount(el, to) {
    const dur = 900, start = performance.now(), from = 0;
    function step(now) {
      const p = Math.min(1, (now - start) / dur);
      const eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(from + (to - from) * eased).toLocaleString("en-US");
      if (p < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  /* ================= TILT / GLOW / MASCOT ================= */

  function attachTilt(el) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.addEventListener("mousemove", (e) => {
      const r = el.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      el.style.transition = "none";
      el.style.transform = `perspective(700px) rotateX(${(-py * 6).toFixed(2)}deg) rotateY(${(px * 6).toFixed(2)}deg) translateY(-4px)`;
    });
    el.addEventListener("mouseleave", () => {
      el.style.transition = "transform .35s ease";
      el.style.transform = "perspective(700px) rotateX(0) rotateY(0) translateY(0)";
    });
  }

  function attachTiltToCards() { $$(".grid .card").forEach(attachTilt); }

  function bindCursorGlow() {
    const glow = document.getElementById("heroGlow");
    const hero = document.querySelector(".hero");
    if (hero && glow && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      hero.addEventListener("mousemove", (e) => {
        const r = hero.getBoundingClientRect();
        const relX = ((e.clientX - r.left) / r.width) * 640;
        const relY = ((e.clientY - r.top) / r.height) * 520;
        glow.setAttribute("cx", (40 + relX * 0.4).toFixed(0) + "%");
        glow.setAttribute("cy", (10 + relY * 0.25).toFixed(0) + "%");
      });
    }
  }

  (function initMascot() {
    const mascot = document.getElementById("mascot");
    if (!mascot) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    mascot.style.position = "fixed";
    mascot.style.right = "22px";
    mascot.style.bottom = "22px";
    mascot.style.left = "auto";
    mascot.style.top = "auto";
    mascot.style.transform = "none";
    mascot.style.opacity = "1";
    mascot.classList.add("idle-bob");
    const eyeL = mascot.querySelector("#eyeL");
    const eyeR = mascot.querySelector("#eyeR");
    let mouseX = window.innerWidth * 0.6, mouseY = window.innerHeight * 0.35;
    const STRENGTH = 2.6;
    function look() {
      const r = mascot.getBoundingClientRect();
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const dx = mouseX - cx, dy = mouseY - cy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const tx = ((dx / len) * STRENGTH).toFixed(2);
      const ty = ((dy / len) * STRENGTH).toFixed(2);
      eyeL.setAttribute("transform", "translate(" + tx + " " + ty + ")");
      eyeR.setAttribute("transform", "translate(" + tx + " " + ty + ")");
    }
    if (reduceMotion || !eyeL || !eyeR) return;
    window.addEventListener("mousemove", (e) => { mouseX = e.clientX; mouseY = e.clientY; look(); }, { passive: true });
    window.addEventListener("scroll", look, { passive: true });
    look();
  })();

  /* ================= EVENTS ================= */

  function mascotCoverEyes(duration) {
    const m = document.getElementById("mascot");
    if (!m) return;
    m.classList.add("cover");
    clearTimeout(m._coverT);
    m._coverT = setTimeout(() => m.classList.remove("cover"), duration || 2800);
  }

  let _smoothGoTo = null;

  function bind() {
    document.addEventListener("click", (e) => {
      const add = e.target.closest("[data-add]");
      if (add) { addToCart(add.dataset.add); return; }

      const rm = e.target.closest("[data-remove]");
      if (rm) { removeFromCart(rm.dataset.remove); return; }

      const card = e.target.closest(".card[data-id]");
      if (card) { openDetail(card.dataset.id); return; }

      const catChip = e.target.closest("[data-cat]");
      if (catChip) {
        state.category = catChip.dataset.cat;
        renderChips();
        renderGrid();
        return;
      }

      const nav = e.target.closest("[data-nav]");
      if (nav) { e.preventDefault(); goTo(nav.dataset.nav); return; }

      const payMethodBtn = e.target.closest("[data-pay]");
      if (payMethodBtn) {
        state.pay = payMethodBtn.dataset.pay;
        $$(".pay-method").forEach((b) => b.classList.toggle("active", b === payMethodBtn));
        renderCheckout();
        return;
      }

      const copy = e.target.closest(".copy-btn[data-key]");
      if (copy) {
        navigator.clipboard.writeText(copy.dataset.key).catch(() => {});
        copy.textContent = "✓";
        setTimeout(() => { copy.textContent = "Copy"; }, 1500);
        toast("License key copied", "success");
        return;
      }
    });

    $("#cartBtn").addEventListener("click", openCart);
    $("#cartClose").addEventListener("click", closeCart);
    $("#cartBackdrop").addEventListener("click", closeCart);
    $("#cartBrowse").addEventListener("click", () => { closeCart(); goTo("shop"); });

    $("#detailClose").addEventListener("click", closeDetail);
    $("#detailBackdrop").addEventListener("click", closeDetail);

    $("#detailAdd").addEventListener("click", () => {
      if (!state.detailId) return;
      addToCart(state.detailId);
      if (cart.includes(state.detailId)) $("#detailAdd").textContent = "Added to Cart ✓";
    });

    $("#checkoutBtn").addEventListener("click", openCheckout);
    $("#checkoutClose").addEventListener("click", closeCheckout);
    $("#checkoutBackdrop").addEventListener("click", closeCheckout);
    $("#payBtn").addEventListener("click", processPayment);

    $("#loginBtn").addEventListener("click", () => { state.authMode = "login"; openAuth(); });
    $("#logoutBtn").addEventListener("click", logout);
    $("#authClose").addEventListener("click", closeAuth);
    $("#authBackdrop").addEventListener("click", closeAuth);
    $("#tabLogin").addEventListener("click", () => { state.authMode = "login"; updateAuthTabs(); });
    $("#tabSignup").addEventListener("click", () => { state.authMode = "signup"; updateAuthTabs(); });
    $("#authSubmit").addEventListener("click", submitAuth);
    $("#authPassword").addEventListener("keydown", (e) => { if (e.key === "Enter") submitAuth(); });
    $("#authSwitch").addEventListener("click", (e) => {
      e.preventDefault();
      state.authMode = state.authMode === "login" ? "signup" : "login";
      updateAuthTabs();
    });

    $("#heroShopBtn").addEventListener("click", () => {
      document.querySelector(".toolbar").scrollIntoView({ behavior: "smooth", block: "start" });
    });
    document.querySelectorAll(".float-card").forEach((fc) => fc.addEventListener("click", () => goTo("shop")));

    $("#successClose").addEventListener("click", () => { hideSuccess(); });
    $("#successLibrary").addEventListener("click", () => { hideSuccess(); goTo("library"); });
    $("#successBackdrop").addEventListener("click", hideSuccess);

    $("#searchInput").addEventListener("input", (e) => {
      state.search = e.target.value;
      renderGrid();
    });

    $("#sortSelect").addEventListener("change", (e) => {
      state.sort = e.target.value;
      renderGrid();
    });

    $("#devClose").addEventListener("click", toggleDevConsole);
    $("#devClear").addEventListener("click", () => {
      _capyLogs.length = 0;
      renderDevLogs();
      capyLog("Logs cleared", "info");
    });

    $("#adminClose").addEventListener("click", toggleAdminConsole);
    $("#adminClearOut").addEventListener("click", () => {
      outInnerClear();
      adminPrint("Output cleared", "dim");
    });
    $("#adminList").addEventListener("click", (e) => {
      const b = e.target.closest("[data-cmd]");
      if (!b) return;
      adminExec(b.dataset.cmd);
    });
    $("#adminInput").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const v = e.target.value;
      e.target.value = "";
      adminExec(v);
    });

    let _lastF5 = 0;
    let _lastF1 = 0;
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        closeDetail(); closeCart(); closeCheckout(); closeAuth(); hideSuccess();
      } else if (e.key === "F5") {
        e.preventDefault();
        _lastF5 = Date.now();
        capyLog("F5 pressed — press F10 within 1.5s to toggle dev console", "info");
      } else if (e.key === "F10" && _lastF5 && Date.now() - _lastF5 < 1500) {
        _lastF5 = 0;
        e.preventDefault();
        toggleDevConsole();
      } else if (e.key === "F1") {
        e.preventDefault();
        _lastF1 = Date.now();
        capyLog("F1 pressed — press F2 within 1.5s to toggle admin console", "info");
      } else if (e.key === "F2" && _lastF1 && Date.now() - _lastF1 < 1500) {
        _lastF1 = 0;
        e.preventDefault();
        toggleAdminConsole();
      }
    });
  }

  function hideSuccess() {
    $("#successModal").classList.remove("show");
    $("#successBackdrop").classList.remove("show");
    document.body.style.overflow = "";
  }

  function goTo(view) {
    const current = document.querySelector("main:not(.hidden)");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (current && !reduced) {
      current.classList.add("view-leaving");
      setTimeout(() => { showView(view); current.classList.remove("view-leaving"); }, 140);
    } else {
      showView(view);
    }
  }

  /* ================= INIT ================= */

  function init() {
    renderChips();
    renderGrid();
    renderCart();
    renderHeroVisual();
    updateAuthUI();
    updateLibCount();
    showView("shop");

    animateCount($("#statCount"), SCRIPTS.length);
    animateCount($("#statSold"), SCRIPTS.reduce((a, s) => a + s.sales, 0));
    const avg = SCRIPTS.reduce((a, s) => a + s.rating, 0) / SCRIPTS.length;
    $("#statRating").textContent = avg.toFixed(1);

    bind();
    attachTiltToCards();
    bindCursorGlow();
    restoreSession();
    pollMessage();
    pollMaintenance();
    setInterval(() => { pollMessage(); pollMaintenance(); }, 2000);
  }

  /* ================= CAPY 100 FEATURE PACK ================= */

  (function () {
    if (window.__capy100) return;
    window.__capy100 = true;

    const $x = (sel, root) => (root || document).querySelector(sel);

    const lget = (k) => { try { const v = localStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch (e) { return null; } };
    const lset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
    const rand = (a, b) => Math.floor(Math.random() * (b - a + 1)) + a;
    const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
    const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

    const CSS = `
#capyBar{display:flex;flex-wrap:wrap;gap:14px;align-items:center;justify-content:space-between;padding:8px 28px;max-width:1120px;margin:0 auto;font-size:12.5px;color:var(--text-lo);}
#capyBar b{color:var(--text-hi);font-weight:600;}
#capyBar .capy-tick{display:flex;gap:12px;align-items:center;}
#capyBar .capy-tip{max-width:520px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
#capyHeader{display:flex;align-items:center;gap:8px;}
.capy-hbtn{position:relative;width:34px;height:34px;border-radius:9px;border:1px solid var(--line);background:var(--panel);color:var(--text-hi);cursor:pointer;font-size:15px;display:flex;align-items:center;justify-content:center;}
.capy-hbtn:hover{background:var(--panel-hi);}
.capy-badge{position:absolute;top:-5px;right:-5px;min-width:16px;height:16px;padding:0 4px;background:var(--mikan);color:#23150a;font-size:9.5px;font-weight:700;border-radius:8px;display:flex;align-items:center;justify-content:center;}
.capy-row{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin-top:8px;}
.capy-btn{border:1px solid var(--glass-border);background:var(--panel);color:var(--text-hi);border-radius:9px;padding:6px 11px;font-size:12.5px;cursor:pointer;font-weight:600;}
.capy-btn:hover{background:var(--panel-hi);}
.capy-btn.active{background:var(--mikan);color:#23150a;}
.capy-btn.sm{padding:4px 8px;font-size:11.5px;}
.capy-strip{display:flex;gap:10px;overflow-x:auto;padding:4px 0;margin:10px 0;scrollbar-width:thin;}
.capy-mini{border:1px solid var(--line);background:var(--panel);border-radius:12px;padding:8px 12px;min-width:210px;flex:0 0 auto;font-size:12.5px;cursor:pointer;}
.capy-mini b{color:var(--text-hi);}
.capy-deal{border:1px solid var(--glass-border);border-radius:14px;padding:12px 16px;margin:10px 0;background:linear-gradient(135deg,rgba(216,128,50,0.18),rgba(104,159,56,0.1));display:flex;align-items:center;gap:14px;justify-content:space-between;flex-wrap:wrap;}
.capy-deal .tt{font-size:15px;font-weight:800;color:var(--text-hi);}
.capy-deal small{color:var(--text-lo);}
.capy-modal{position:fixed;inset:0;z-index:120;display:none;align-items:center;justify-content:center;background:rgba(5,3,2,0.62);backdrop-filter:blur(6px);}
.capy-modal.show{display:flex;}
.capy-card{background:rgba(24,17,11,0.98);border:1px solid var(--glass-border);border-radius:18px;max-width:560px;width:94%;max-height:86vh;overflow:auto;padding:22px;}
.capy-card h3{margin:0 0 12px;color:var(--text-hi);font-size:18px;}
.capy-card .row{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;}
.capy-hb{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;}
.capy-hb .x{cursor:pointer;font-size:16px;opacity:.7;}
.capy-hb .x:hover{opacity:1;}
.capy-stepper{width:88%;height:9px;border-radius:9px;background:rgba(255,255,255,0.08);overflow:hidden;margin:6px 8px 0;}
.capy-stepper i{display:block;height:100%;border-radius:9px;background:linear-gradient(90deg,var(--mikan),var(--moss));}
.capy-facts{display:flex;flex-direction:column;gap:8px;}
.capy-facts div{font-size:13px;color:var(--text-lo);border-bottom:1px dashed var(--line);padding-bottom:6px;}
.capy-facts b{color:var(--text-hi);}
.capy-note{font-size:12px;color:var(--text-faint);margin-top:10px;}
canvas#capyFx{position:fixed;inset:0;z-index:200;pointer-events:none;}
#capyRain{position:fixed;inset:0;z-index:210;pointer-events:none;overflow:hidden;}
#capyRain span{position:absolute;font-size:26px;animation:capyfall linear forwards;}
@keyframes capyfall{to{transform:translateY(110vh) rotate(360deg);}}
@keyframes capyIn{from{opacity:0;transform:translateY(18px) scale(.94);}to{opacity:1;transform:none;}}
.capy-anim{animation:capyIn .45s ease both;}
.capy-night{--ink:#02060a;--ink-2:#04101a;--panel:rgba(10,26,40,0.6);--panel-hi:rgba(16,40,60,0.7);--glass-border:rgba(80,170,220,0.25);--mikan:#37b6a9;--mikan-lt:#5ad1c4;--moss:#7fd0a0;--text-hi:#e8f6f2;}
.capy-wheel{position:relative;width:190px;height:190px;border-radius:50%;overflow:hidden;border:2px solid var(--glass-border);margin:10px auto;transition:transform 3.4s cubic-bezier(.1,.7,.1,1);}
.capy-wheel div{position:absolute;left:50%;top:50%;width:14px;height:88px;margin:-44px 0 0 -7px;transform-origin:50% 0;font-size:12px;background:var(--mikan);color:#23150a;text-align:center;padding-top:6px;border-radius:4px;}
.capy-wheel .p2{background:var(--moss);}
.capy-wheel .ptr{position:absolute;left:50%;top:4px;margin-left:-7px;font-size:16px;z-index:3;}
.capy-toast-hist{position:fixed;bottom:20px;left:20px;z-index:250;display:flex;flex-direction:column;gap:6px;max-width:300px;}
.capy-toast-hist div{background:rgba(24,17,11,0.95);border:1px solid var(--glass-border);border-radius:10px;padding:8px 12px;font-size:12.5px;color:var(--text-hi);animation:capyIn .3s ease;}
#capyWheelWrap{text-align:center;}
#capyNear{display:flex;gap:12px;flex-wrap:wrap;margin:14px 0;}
#capyNear h4{width:100%;margin:2px 0 8px;color:var(--text-hi);font-size:14px;}
.capy-seg{font-size:12.5px;color:var(--text-lo);}
.capy-seg b{color:var(--text-hi);}
.detail-more{display:flex;gap:10px;flex-wrap:wrap;margin-top:12px;}
.detail-more button{font-size:12px;}
.detail-more .cp-rcard{border:1px solid var(--line);background:var(--panel);border-radius:12px;flex:1 1 150px;padding:8px 10px;cursor:pointer;text-align:left;color:var(--text-hi);}
.detail-more .cp-rcard .em{font-size:18px;margin-right:6px;}
.cp-compare{display:grid;grid-template-columns:1fr 1fr;gap:12px;}
.cp-compare .box{border:1px solid var(--glass-border);border-radius:14px;padding:12px;background:var(--panel);}
.cp-rating{display:flex;gap:8px;margin-top:10px;}
.cp-rating button{width:40px;height:40px;border-radius:10px;border:1px solid var(--line);background:var(--panel);cursor:pointer;font-size:18px;}
.cp-rating button.on{background:var(--mikan);}
.capy-ach{display:flex;align-items:center;gap:10px;padding:8px;border-radius:10px;background:var(--panel);border:1px solid var(--line);margin-bottom:6px;}
.capy-ach.done{opacity:.6;}
.capy-ach .ic{font-size:20px;}
.capy-ach .nm b{color:var(--text-hi);display:block;font-size:13px;}
.capy-ach .nm small{color:var(--text-lo);}
#capySearchSug{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:60;background:rgba(20,14,9,0.98);border:1px solid var(--glass-border);border-radius:12px;overflow:hidden;display:none;}
#capySearchSug.show{display:block;}
#capySearchSug div{padding:9px 12px;cursor:pointer;font-size:13px;color:var(--text-hi);}
#capySearchSug div:hover{background:var(--panel-hi);}
.scratch{position:relative;width:240px;height:110px;margin:12px auto;border-radius:12px;overflow:hidden;background:var(--mikan);}
.scratch .mask{position:absolute;inset:0;}
.scratch canvas{position:absolute;inset:0;width:100%;height:100%;cursor:pointer;}
.sc-tg{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:800;color:#23150a;font-size:22px;}
.capy-mascot{position:fixed;right:16px;bottom:16px;z-index:90;width:52px;height:52px;font-size:30px;background:rgba(24,17,11,0.85);border:1px solid var(--glass-border);border-radius:50%;display:flex;align-items:center;justify-content:center;cursor:pointer;box-shadow:0 8px 20px rgba(0,0,0,.4);}
.capy-mascot.boop{animation:capyBoop .5s ease;}
@keyframes capyBoop{0%,100%{transform:scale(1) rotate(0);}40%{transform:scale(1.35) rotate(8deg);}}
.capy-mbubble{position:fixed;right:76px;bottom:22px;z-index:91;background:rgba(24,17,11,0.95);border:1px solid var(--glass-border);border-radius:14px;padding:8px 12px;font-size:12.5px;max-width:230px;color:var(--text-hi);display:none;box-shadow:0 8px 20px rgba(0,0,0,.4);}
.capy-mbubble.show{display:block;}
@media (max-width:720px){#capyBar{flex-direction:column;align-items:flex-start;}}
`;

    const styleEl = document.createElement("style");
    styleEl.textContent = CSS;
    document.head.appendChild(styleEl);

    const ACH = [
      { id: "vis1", ic: "👀", nm: "Window Shopper", desc: "Visit the store", xp: 20 },
      { id: "cart1", ic: "🛒", nm: "Window Cartster", desc: "Add your first script to cart", xp: 30 },
      { id: "buy1", ic: "🎟️", nm: "First Key", desc: "Buy your first script", xp: 60 },
      { id: "own10", ic: "🧰", nm: "Collector", desc: "Own 10 scripts", xp: 120 },
      { id: "own20", ic: "📚", nm: "Capy Librarian", desc: "Own 20 scripts", xp: 200 },
      { id: "wish5", ic: "💛", nm: "Crusher", desc: "Wishlist 5 scripts", xp: 50 },
      { id: "daily3", ic: "🗓️", nm: "Regular", desc: "Claim 3 daily bonuses", xp: 80 },
      { id: "streak5", ic: "🔥", nm: "On Fire", desc: "Reach a 5-day streak", xp: 150 },
      { id: "coupon1", ic: "🎟️", nm: "Code Breaker", desc: "Use a coupon", xp: 70 },
      { id: "wheel1", ic: "🎡", nm: "Lucky Spin", desc: "Spin the daily wheel", xp: 60 },
      { id: "wheel5", ic: "💎", nm: "Wheeler", desc: "Spin the wheel 5 times", xp: 100 },
      { id: "ref1", ic: "🤝", nm: "Influencer", desc: "Share your referral link", xp: 40 },
      { id: "full100", ic: "🌊", nm: "Full Pool", desc: "Own all 50 scripts", xp: 500 }
    ];

    const STATE = lget("capy_ex_v1") || {};
    const st = {
      accent: STATE.accent || "orange",
      night: !!STATE.night,
      sound: STATE.sound !== false,
      particles: STATE.particles !== false,
      trail: STATE.trail === true,
      splash: STATE.splash === true,
      grid: STATE.grid || "grid",
      minRating: STATE.minRating || 0,
      priceMax: STATE.priceMax || Infinity,
      onlyBest: !!STATE.onlyBest,
      onlyNew: !!STATE.onlyNew,
      sort: STATE.sort || "featured",
      perPage: STATE.perPage || 10,
      page: 1,
      viewList: false,
      wishlist: STATE.wishlist || [],
      recent: STATE.recent || [],
      searches: STATE.searches || [],
      coupons: STATE.coupons || [],
      wallet: STATE.wallet || 0,
      orders: STATE.orders || [],
      avatar: STATE.avatar || "🦫",
      status: STATE.status || "chilling in the hot tub 🛁",
      watched: STATE.watched || [],
      reactions: STATE.reactions || {},
      xp: STATE.xp || 0,
      visitCount: (STATE.visitCount || 0) + 1,
      streak: STATE.streak || 0,
      lastVisit: STATE.lastVisit || null,
      dailyTs: STATE.dailyTs || 0,
      spinCount: STATE.spinCount || 0,
      coinTs: STATE.coinTs || 0,
      scratchTs: STATE.scratchTs || 0,
      lottie: STATE.lottie || [],
      favorites: STATE.favorites || [],
      ach: STATE.ach || [],
      flags: STATE.flags || {}
    };
    const persist = () => { const d = Object.assign({}, st); d.visitCount = STATE.visitCount; delete d.visitCount; lset("capy_ex_v1", Object.assign(Object.assign({}, STATE), st)); };

    const persistSimple = () => lset("capy_ex_v1", Object.assign({}, STATE, st));
    const sessionStart = Date.now();

    let history = [];
    const note = (msg, type) => {
      const t = new Date().toLocaleTimeString();
      history.unshift({ t, msg, type: type || "info" });
      if (history.length > 40) history.pop();
      const box = $x("#capyToastHist");
      if (box) {
        const el = document.createElement("div");
        el.textContent = `${t}  ${msg}`;
        (type === "err" ? ["color:#ff9d8a"] : type === "ok" ? ["color:#9adc8f"] : ["color:var(--text-hi)"]).forEach((s) => (el.style.cssText = s));
        box.appendChild(el);
        setTimeout(() => el.remove(), 6000);
      }
      try { toast(msg, type === "err" ? "error" : type === "ok" ? "success" : "info"); } catch (e) {}
      persistSimple();
    };

    function addXp(n) {
      st.xp += n;
      const leveled = levelOf(st.xp);
      if (leveled && leveled.prev !== leveled.cur) note(`▲ Level up! You are now level ${leveled.cur}`, "ok");
      refreshProfile();
    }
    function levelOf(xp) { const cur = Math.floor(Math.sqrt(xp / 12)); const prev = Math.floor(Math.sqrt(Math.max(0, xp - 1) / 12)); return { cur, prev }; }
    const currLevel = () => Math.floor(Math.sqrt(st.xp / 12));

    function unlock(id) {
      if (st.ach.includes(id)) return false;
      const a = ACH.find((x) => x.id === id);
      if (!a) return false;
      st.ach.push(id);
      addXp(a.xp);
      confetti(26);
      note(`🏆 Achievement: ${a.nm} (+${a.xp} XP)`, "ok");
      return true;
    }

    function checkAch() {
      unlock("vis1");
      if ((cart || []).length >= 1) unlock("cart1");
      const n = user ? user.purchases.length : 0;
      if (n >= 1) unlock("buy1");
      if (n >= 10) unlock("own10");
      if (n >= 20) unlock("own20");
      if (st.wishlist.length >= 5) unlock("wish5");
      if (st.spinCount >= 1) unlock("wheel1");
      if (st.spinCount >= 5) unlock("wheel5");
      if (glanceDaily().count >= 3) unlock("daily3");
      if (st.streak >= 5) unlock("streak5");
      if (st.coupons.length >= 1) unlock("coupon1");
      if (st.flags.refShared) unlock("ref1");
      if ((n || 0) >= SCRIPTS.length) unlock("full100");
    }

    function glanceDaily() { return { count: st.flags.dailyCount || 0, day: stateDay() }; }
    function stateDay() { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); }

    function confetti(n) {
      const c = $x("#capyFx");
      if (!c) return;
      const ctx = c.getContext("2d");
      c.width = innerWidth; c.height = innerHeight;
      const colors = ["#d88032", "#f2a45a", "#689f38", "#ffd166", "#e0564b"];
      const parts = [];
      for (let i = 0; i < (n || 60); i++) parts.push({ x: Math.random() * c.width, y: -20 - Math.random() * 120, s: rand(5, 10), vx: rand(-2, 2), vy: rand(2, 5), r: Math.random() * Math.PI, vr: rand(-0.2, 0.2), c: pick(colors) });
      let frame = 0;
      (function tick() {
        ctx.clearRect(0, 0, c.width, c.height);
        parts.forEach((p) => { p.x += p.vx; p.y += p.vy; p.r += p.vr; ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.7); ctx.restore(); });
        if (frame++ < 110) requestAnimationFrame(tick); else ctx.clearRect(0, 0, c.width, c.height);
      })();
    }

    function capyRain() {
      const box = $x("#capyRain");
      if (!box) return;
      ["🦫", "🦫", "🍉", "🧡", "🌿", "🫧"].forEach((em, i) => {
        const sp = document.createElement("span");
        sp.textContent = em;
        sp.style.left = Math.random() * 100 + "%";
        sp.style.animationDuration = rand(2, 4) + "s";
        box.appendChild(sp);
        setTimeout(() => sp.remove(), 4200);
      });
    }

    let soundOn = st.sound;
    function beep(freq, dur) {
      if (!soundOn) return;
      try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const o = ctx.createOscillator(); const g = ctx.createGain();
        o.frequency.value = freq; o.type = "sine";
        g.gain.setValueAtTime(0.06, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + dur);
        o.connect(g); g.connect(ctx.destination); o.start(); o.stop(ctx.currentTime + dur);
      } catch (e) {}
    }

    /* ---- cursors & fx canvases ---- */
    function ensureCanvases() {
      if (!$x("#capyFx")) { const c = document.createElement("canvas"); c.id = "capyFx"; document.body.appendChild(c); }
      if (!$x("#capyRain")) { const r = document.createElement("div"); r.id = "capyRain"; document.body.appendChild(r); }
      if (!$x("#capyToastHist")) { const h = document.createElement("div"); h.className = "capy-toast-hist"; h.id = "capyToastHist"; document.body.appendChild(h); }
    }

    let fxCtx = null, trailOn = st.trail, splashOn = st.splash, particleOn = st.particles;
    function fxInit() {
      const c = $x("#capyFx");
      if (!c) return;
      fxCtx = c.getContext("2d");
      window.addEventListener("resize", () => { c.width = innerWidth; c.height = innerHeight; });
      c.width = innerWidth; c.height = innerHeight;
      const dots = [];
      for (let i = 0; i < 26; i++) dots.push({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, r: rand(1, 2.4), vx: (Math.random() - 0.5) * 0.4, vy: (Math.random() - 0.5) * 0.4, c: pick(["#d88032", "#689f38", "#f2a45a", "#ffd166"]) });
      (function prt() {
        if (particleOn) {
          if (!fxCtx) return;
          fxCtx.clearRect(0, 0, innerWidth, innerHeight);
          dots.forEach((d) => {
            d.x += d.vx; d.y += d.vy;
            if (d.x < 0 || d.x > innerWidth) d.vx *= -1;
            if (d.y < 0 || d.y > innerHeight) d.vy *= -1;
            fxCtx.beginPath(); fxCtx.arc(d.x, d.y, d.r, 0, Math.PI * 2); fxCtx.fillStyle = d.c; fxCtx.globalAlpha = 0.35; fxCtx.fill();
          });
        } else if (fxCtx) { fxCtx.clearRect(0, 0, innerWidth, innerHeight); }
        requestAnimationFrame(prt);
      })();
    }

    /* ---- header buttons ---- */
    function buildHeader() {
      const host = document.querySelector("header .header-actions");
      if (!host) return;
      const mk = (title, html, id) => {
        const b = document.createElement("button");
        b.className = "capy-hbtn"; b.title = title; b.id = id || ("cb_" + Math.random().toString(36).slice(2, 7));
        b.innerHTML = html;
        host.insertBefore(b, host.firstChild);
        return b;
      };
      const wish = mk("Wishlist", '💛<span id="capyWishBadge" class="capy-badge hidden">0</span>', "capyWish");
      const bell = mk("Notifications", '🔔<span id="capyBellBadge" class="capy-badge hidden">0</span>', "capyBell");
      const fs = mk("Fullscreen (F)", "⛶", "capyFs");
      const pm = mk("Particles", "✨", "capyPart");
      const sd = mk("Sound", "🔊", "capySnd");
      const th = mk("Theme", "🎭", "capyThm");
      const rn = mk("Roulette", "🎲", "capyRoulette");
      const hlp = mk("Help (?)", "？", "capyHelp");
      wish.onclick = () => openWishlist();
      bell.onclick = () => openBell();
      fs.onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); };
      pm.onclick = () => { particleOn = !particleOn; st.particles = particleOn; persistSimple(); pm.style.opacity = particleOn ? 1 : 0.45; };
      sd.onclick = () => { soundOn = !soundOn; st.sound = soundOn; persistSimple(); sd.style.opacity = soundOn ? 1 : 0.45; beep(soundOn ? 660 : 220, 0.12); };
      th.onclick = () => cycleAccent();
      rn.onclick = () => surpriseScript();
      hlp.onclick = () => openHelp();
      updateHeaderBadges();
    }

    function updateHeaderBadges() {
      const wn = st.wishlist.length;
      const wb = $x("#capyWishBadge");
      if (wb) { wb.textContent = wn; wb.classList.toggle("hidden", wn === 0); }
      const unSeen = history.length;
      const bb = $x("#capyBellBadge");
      if (bb) { bb.textContent = unSeen; bb.classList.toggle("hidden", unSeen === 0); }
    }

    function cycleAccent() {
      const pal = { orange: ["#d88032", "#f2a45a"], green: ["#689f38", "#8bc34a"], purple: ["#8e44ad", "#b07bd0"], pink: ["#e0564b", "#ff7a6b"] };
      const keys = Object.keys(pal);
      const cur = keys.indexOf(st.accent);
      st.accent = keys[(cur + 1) % keys.length];
      applyAccent();
      persistSimple();
      note(`🎨 Accent: ${st.accent}`, "ok");
      beep(520, 0.1);
    }
    function applyAccent() {
      const pal = { orange: ["#d88032", "#f2a45a"], green: ["#689f38", "#8bc34a"], purple: ["#8e44ad", "#b07bd0"], pink: ["#e0564b", "#ff7a6b"] };
      const col = pal[st.accent] || pal.orange;
      const root = document.documentElement;
      root.style.setProperty("--mikan", col[0]);
      root.style.setProperty("--mikan-lt", col[1]);
    }

    /* ---- top bar (greeting/tips/clock) ---- */
    function buildBar() {
      const header = document.querySelector("header");
      if (!header) return;
      const bar = document.createElement("div");
      bar.id = "capyBar";
      header.after(bar);
      const tipArr = [
        "Tip: Press / or Ctrl+K to jump to search.",
        "Tip: Press ? for a full keyboard cheat sheet.",
        "Tip: Every day you can claim a daily bonus in the capybara mascot.",
        "Tip: CAPY10 saves 10% at checkout — one use per browser.",
        "Fun fact: Capybaras are the largest rodents on Earth.",
        "Fun fact: Capybaras sleep in hot springs in Japan.",
        "Tip: The daily wheel resets every day.",
        "Tip: Compare two scripts from the Compare menu in the toolbar.",
        "Fun fact: A capybara's scientific name means 'water pig'.",
        "Tip: Share a script link — it deep-links straight to the detail modal."
      ];
      let tipIdx = 0;
      function rotateTip() { tipIdx = (tipIdx + 1) % tipArr.length; const el = $x("#capyTipTxt"); if (el) el.textContent = tipArr[tipIdx]; }
      function renderBar() {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        const ss = String(d.getSeconds()).padStart(2, "0");
        const secs = Math.floor((Date.now() - sessionStart) / 1000);
        const sM = Math.floor(secs / 60), sS = secs % 60;
        const hr = d.getHours();
        const greet = hr < 5 ? "Late night grind" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : hr < 22 ? "Good evening" : "Night owl";
        const onl = Math.max(0, Math.round((usersLike() * 0.6 + st.visitCount * 0.15 + Math.random() * 3)));
        bar.innerHTML = `
          <div class="capy-tick">
            <span>${greet}, capybara! 👋</span>
            <span>🕐 <b>${hh}:${mm}:${ss}</b></span>
            <span>⏱️ session <b>${sM}:${String(sS).padStart(2, "0")}</b></span>
            <span>🟢 <b>${onl}</b> online</span>
            <span>📊 visits <b>${st.visitCount}</b></span>
            <span title="Streak: ${st.streak} days">🔥 <b>${st.streak}</b> day streak</span>
          </div>
          <div class="capy-tip"><span id="capyTipTxt">${tipArr[tipIdx]}</span></div>`;
      }
      renderBar();
      setInterval(renderBar, 1000);
      setInterval(rotateTip, 12000);
    }
    function usersLike() { try { return Math.max(1, Math.round(15)); } catch (e) { return 5; } }

    /* ---- toolbar extras (filters, quick actions) ---- */
    function buildToolbar() {
      const toolbar = document.querySelector(".toolbar, .filter-row");
      if (!toolbar) return;
      const wrap = document.createElement("div");
      wrap.className = "capy-row";
      wrap.style.marginTop = "10px";
      toolbar.appendChild(wrap);

      const btn = (label, fn, active) => {
        const b = document.createElement("button");
        b.className = "capy-btn capy-btn-sm" + (active ? " active" : "");
        b.textContent = label;
        b.onclick = fn;
        wrap.appendChild(b);
        return b;
      };

      btn(st.grid === "grid" ? "◧ Grid" : "◧ List", () => { st.grid = st.grid === "grid" ? "list" : "grid"; applyView(); persistSimple(); toast("View: " + st.grid, "success"); });

      const ratWrap = document.createElement("label");
      ratWrap.style.cssText = "font-size:12px;color:var(--text-lo);display:flex;gap:6px;align-items:center;";
      const ratSel = document.createElement("select");
      ratSel.className = "sort"; ratSel.style.cssText = "font-size:12px;padding:4px 8px;border-radius:8px;background:var(--panel);color:var(--text-hi);border:1px solid var(--glass-border);";
      [["0", "★ Any rating"], ["4", "★ 4.0+"], ["4.5", "★ 4.5+"], ["4.8", "★ 4.8+"]].forEach((o) => { const op = document.createElement("option"); op.value = o[0]; op.textContent = o[1]; ratSel.appendChild(op); });
      ratSel.value = String(st.minRating || 0);
      ratSel.onchange = () => { st.minRating = parseFloat(ratSel.value) || 0; persistSimple(); renderExtGrid(); };
      ratWrap.appendChild(document.createTextNode("Rating"));
      ratWrap.appendChild(ratSel);
      wrap.appendChild(ratWrap);

      const prRange = document.createElement("label");
      prRange.style.cssText = "font-size:12px;color:var(--text-lo);display:flex;gap:6px;align-items:center;";
      const prIn = document.createElement("input");
      prIn.type = "range"; prIn.min = "0"; prIn.max = "500"; prIn.value = st.priceMax === Infinity ? 500 : st.priceMax; prIn.style.cssText = "width:90px;accent-color:var(--mikan);";
      const prLbl = document.createElement("span");
      prLbl.textContent = "≤ " + (st.priceMax === Infinity ? "∞" : st.priceMax);
      prRange.appendChild(document.createTextNode("Price"));
      prRange.appendChild(prIn); prRange.appendChild(prLbl);
      prIn.oninput = () => { st.priceMax = parseInt(prIn.value, 10) || Infinity; prLbl.textContent = "≤ " + (st.priceMax === Infinity ? "∞" : st.priceMax); renderExtGrid(); };
      wrap.appendChild(prRange);

      const bBtn = btn("Bestsellers", () => { st.onlyBest = !st.onlyBest; persistSimple(); refreshExtButtons(); renderExtGrid(); toast(st.onlyBest ? "Only bestsellers" : "Showing all", "ok"); });
      const nBtn = btn("New only", () => { st.onlyNew = !st.onlyNew; persistSimple(); refreshExtButtons(); renderExtGrid(); toast(st.onlyNew ? "Only new" : "Showing all", "ok"); });

      const sortBox = document.createElement("select");
      sortBox.className = "sort"; sortBox.style.cssText = "font-size:12px;padding:4px 8px;border-radius:8px;background:var(--panel);color:var(--text-hi);border:1px solid var(--glass-border);";
      [["featured", "Sort: Featured"], ["atoz", "Sort: A → Z"], ["ztoa", "Sort: Z → A"], ["random", "Sort: Random"], ["rating", "Sort: Top rated"], ["cheap", "Sort: Cheapest"]].forEach((o) => { const op = document.createElement("option"); op.value = o[0]; op.textContent = o[1]; sortBox.appendChild(op); });
      sortBox.value = st.sort;
      sortBox.onchange = () => { st.sort = sortBox.value; st.page = 1; persistSimple(); renderExtGrid(); };
      wrap.appendChild(sortBox);

      btn("🎲 Surprise me", surpriseScript);
      btn("⚖️ Compare", openCompare);
      btn("🏁 Top sellers", openPodium);
      btn("📊 Stats", openStats);

      const saved = new Set();
      function refreshExtButtons() { bBtn.classList.toggle("active", st.onlyBest); nBtn.classList.toggle("active", st.onlyNew); }
      window.__capyExtRefresh = refreshExtButtons;

      /* recently viewed strip */
      const gridParent = document.querySelector("#productGrid") && document.querySelector("#productGrid").parentNode;
      if (gridParent && !$x("#capyRecent")) {
        const strip = document.createElement("div");
        strip.id = "capyRecent";
        strip.style.display = st.recent.length ? "block" : "none";
        strip.innerHTML = `<h4 style="margin:6px 0 4px;font-size:13px;color:var(--text-hi);">👀 Recently viewed</h4><div class="capy-strip" id="capyRecentStrip"></div>`;
        gridParent.insertBefore(strip, document.querySelector("#productGrid"));
        renderRecentStrip();
      }

      /* deals banner */
      if (gridParent && !$x("#capyDeal")) {
        const deal = document.createElement("div");
        deal.id = "capyDeal";
        gridParent.insertBefore(deal, document.querySelector("#productGrid"));
      }

      /* pagination footer */
      if (gridParent && !$x("#capyPager")) {
        const pg = document.createElement("div");
        pg.id = "capyPager";
        pg.className = "capy-row";
        gridParent.appendChild(pg);
      }

      /* compare picker row — injected under toolbar */
      if (gridParent && !$x("#capyCompareRow")) {
        const comp = document.createElement("div");
        comp.id = "capyCompareRow";
        comp.className = "capy-row";
        comp.style.display = "none";
        const refCompare = $x("#capyRecent");
        gridParent.insertBefore(comp, refCompare && refCompare.parentNode === gridParent ? refCompare : document.querySelector("#productGrid"));
      }
    }

    function trackRecent(id) {
      st.recent = [id].concat(st.recent.filter((x) => x !== id)).slice(0, 8);
      persistSimple();
      renderRecentStrip();
    }
    function renderRecentStrip() {
      const strip = $x("#capyRecentStrip");
      const recBox = $x("#capyRecent");
      if (!strip) return;
      strip.innerHTML = st.recent.map((id) => {
        const s = SCRIPTS.find((x) => x.id === id);
        if (!s) return "";
        return `<div class="capy-mini" data-open="${s.id}"><span>${s.emoji}</span> <b>${esc(s.name)}</b><br><small>${esc(s.game)} · ${money(currentPrice(s))}</small></div>`;
      }).join("");
      strip.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => openDetail(el.dataset.open)));
      if (recBox) recBox.style.display = st.recent.length ? "block" : "none";
    }

    const dayOf = (function () { const s = SCRIPTS.reduce((a, s) => a + s.name.length + (s.sales || 0), 0); const D = new Date(); return D.getFullYear() * 10000 + (D.getMonth() + 1) * 100 + D.getDate() + s; })();
    function dealScript() {
      const t = new Date();
      const day = t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate();
      const idx = Math.abs(day + 7) % SCRIPTS.length;
      return SCRIPTS[idx];
    }
    function freeScript() {
      const t = new Date();
      const day = t.getFullYear() * 10000 + (t.getMonth() + 1) * 100 + t.getDate();
      const idx = Math.abs(day + 31) % SCRIPTS.length;
      return SCRIPTS[idx];
    }
    function renderDeal() {
      const deal = $x("#capyDeal");
      if (!deal) return;
      const d = dealScript();
      const f = freeScript();
      const salesGoal = 300000;
      const soldTotal = SCRIPTS.reduce((a, s) => a + s.sales, 0);
      const pct = Math.min(100, Math.round((soldTotal / salesGoal) * 100));
      deal.innerHTML = `
        <div class="capy-deal">
          <div style="flex:1 1 220px;"><div class="tt">🔥 Todays deal — ${esc(d.name)}</div><small>${esc(d.game)} · was ${money(d.oldPrice || Math.round(d.price * 1.4))} → ${money(d.price)}</small></div>
          <div style="flex:1 1 200px;"><div class="tt">🎁 Free capybara pick — ${esc(f.name)}</div><small>${esc(f.game)} · 0 RB$ today</small></div>
          <div style="flex:1 1 160px;">
            <div style="font-size:12px;color:var(--text-lo);">Weekly sales goal</div>
            <div class="capy-stepper"><i style="width:${pct}%"></i></div>
            <small style="color:var(--text-lo);">${soldTotal.toLocaleString("en-US")} / ${salesGoal.toLocaleString("en-US")} (${pct}%)</small>
          </div>
          <button class="capy-btn" data-open="${d.id}">View deal</button>
          <button class="capy-btn" data-open="${f.id}">View freebie</button>
        </div>`;
      deal.querySelectorAll("[data-open]").forEach((el) => el.addEventListener("click", () => { trackRecent(el.dataset.open); openDetail(el.dataset.open); }));
      /* hot-now glow on top 3 */
      const top = SCRIPTS.slice().sort((a, b) => b.sales - a.sales).slice(0, 3).map((s) => s.id);
      document.querySelectorAll("#productGrid .card").forEach((cd) => {
        if (top.includes(cd.dataset.id)) cd.style.boxShadow = "0 0 26px rgba(216,128,50,0.4)";
      });
    }

    /* grid integration: wrap renderGrid with extras */
    function ownRender() {
      const viewMode = st.grid;
      const grid = document.querySelector("#productGrid");
      if (!grid) return;
      let list = visibleScripts().filter((s) => {
        if (st.minRating && s.rating < st.minRating) return false;
        if (st.priceMax < Infinity && currentPrice(s) > st.priceMax) return false;
        if (st.onlyBest && !s.bestseller) return false;
        if (st.onlyNew && !s.new) return false;
        return true;
      });
      if (st.sort === "atoz") list = list.slice().sort((a, b) => a.name.localeCompare(b.name));
      else if (st.sort === "ztoa") list = list.slice().sort((a, b) => b.name.localeCompare(a.name));
      else if (st.sort === "random") list = list.slice().sort(() => Math.random() - 0.5);
      else if (st.sort === "rating") list = list.slice().sort((a, b) => b.rating - a.rating);
      else if (st.sort === "cheap") list = list.slice().sort((a, b) => currentPrice(a) - currentPrice(b));
      $extList = list;
      const total = list.length;
      const per = st.perPage;
      const pages = Math.max(1, Math.ceil(total / per));
      if (st.page > pages) st.page = pages;
      const pageList = list.slice(0, st.page * per);
      grid.innerHTML = pageList.map(cardHTML).join("");
      grid.style.gridTemplateColumns = viewMode === "list" ? "1fr" : "";
      grid.querySelectorAll(".card").forEach((cd, i) => { cd.style.animationDelay = (i * 30) + "ms"; cd.classList.add("capy-anim"); });
      const empty = document.querySelector("#emptyState");
      if (empty) empty.classList.toggle("hidden", pageList.length > 0);
      const pager = $x("#capyPager");
      if (pager) {
        pager.innerHTML = `Showing <b>${Math.min(total, st.page * per)}</b> / ${total} · page ${st.page}/${pages} `;
        const more = document.createElement("button");
        more.className = "capy-btn";
        more.textContent = st.page < pages ? "Load more ▾" : "All shown ✓";
        more.disabled = st.page >= pages;
        more.onclick = () => { st.page++; persistSimple(); ownRender(); };
        pager.appendChild(more);
      }
      renderDeal();
      renderRecentStrip();
      addHeartToCards();
    }
    let $extList = [];
    function renderExtGrid() { st.page = 1; ownRender(); }

    /* monkey-patch renderGrid to include our extras without touching original */
    const _origRenderGrid = renderGrid;
    renderGrid = () => { _origRenderGrid(); ownRender(); };

    /* search suggestions + recent searches */
    function buildSearch() {
      const wrap = document.querySelector(".search-wrap");
      const input = document.querySelector("#searchInput");
      if (!wrap || !input) return;
      const sug = document.createElement("div");
      sug.id = "capySearchSug";
      wrap.style.position = "relative";
      wrap.appendChild(sug);
      input.addEventListener("input", () => {
        const q = input.value.trim().toLowerCase();
        if (!q) { sug.classList.remove("show"); return; }
        const hits = SCRIPTS.filter((s) => (s.name + s.game + s.category).toLowerCase().includes(q)).slice(0, 6);
        sug.innerHTML = hits.map((s) => `<div data-sug="${s.id}">${s.emoji} ${esc(s.name)} <small style="color:var(--text-lo)">${money(currentPrice(s))}</small></div>`).join("");
        sug.classList.toggle("show", hits.length > 0);
        sug.querySelectorAll("[data-sug]").forEach((el) => el.addEventListener("click", () => { trackRecent(el.dataset.sug); openDetail(el.dataset.sug); sug.classList.remove("show"); }));
      });
      input.addEventListener("keydown", (e) => { if (e.key === "Enter" && input.value.trim()) { st.searches = [input.value.trim()].concat(st.searches.filter((x) => x !== input.value.trim())).slice(0, 6); persistSimple(); renderRecentSearches(); } });
      document.addEventListener("click", (e) => { if (!wrap.contains(e.target)) sug.classList.remove("show"); });
      if (!$x("#capyRecentSearches")) {
        const rs = document.createElement("div");
        rs.id = "capyRecentSearches";
        rs.className = "capy-row";
        input.closest(".toolbar") && input.closest(".toolbar").appendChild(rs);
        renderRecentSearches();
      }
    }
    function renderRecentSearches() {
      const rs = $x("#capyRecentSearches");
      if (!rs) return;
      rs.innerHTML = "";
      if (!st.searches.length) return;
      const lbl = document.createElement("span");
      lbl.textContent = "Recent:";
      lbl.style.cssText = "font-size:12px;color:var(--text-lo);";
      rs.appendChild(lbl);
      st.searches.forEach((q) => {
        const c = document.createElement("button");
        c.className = "capy-btn capy-btn-sm";
        c.textContent = q;
        c.onclick = () => { const inp = document.querySelector("#searchInput"); if (inp) { inp.value = q; inp.dispatchEvent(new Event("input")); } };
        rs.appendChild(c);
      });
    }

    /* highlight search matches in cards */
    const _origCardHTML = cardHTML;
    cardHTML = (s) => {
      let html = _origCardHTML(s);
      const q = (state.search || "").trim();
      if (q) {
        const r = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "gi");
        html = html.replace(r, "<mark style=\"background:rgba(216,128,50,.4);color:inherit;padding:0 2px;border-radius:3px;\">$1</mark>");
      }
      return html;
    };

    /* details modal extras */
    function patchDetail() {
      const body = document.querySelector("#detailModal .detail-body");
      if (!body) return;
      const reactionsDone = document.createElement("div");
      reactionsDone.id = "capyReactions";
      body.appendChild(reactionsDone);
      const more = document.createElement("div");
      more.id = "capyMore";
      more.className = "detail-more";
      body.appendChild(more);
      const _origOpen = openDetail;
      openDetail = (id) => {
        trackRecent(id);
        _origOpen(id);
        renderReactions(id);
        renderMore(id);
        if (st.flags.visitSet) { /* noop */ }
      };
    }
    function renderReactions(id) {
      const box = $x("#capyReactions");
      if (!box) return;
      const s = SCRIPTS.find((x) => x.id === id);
      if (!s) return;
      const ems = ["🔥", "💧", "🧡", "🌿"];
      box.innerHTML = '<div class="cp-rating">' + ems.map((em) => {
        const n = (st.reactions[id] && st.reactions[id][em]) || 0;
        const on = st.reactions[id] && st.reactions[id].mine === em;
        return `<button class="${on ? "on" : ""}" data-react="${em}" title="${em}">${em} ${n}</button>`;
      }).join("") + "</div>";
      box.querySelectorAll("[data-react]").forEach((b) => b.addEventListener("click", () => {
        const em = b.dataset.react;
        st.reactions[id] = st.reactions[id] || {};
        if (st.reactions[id].mine === em) { st.reactions[id].mine = null; }
        else { if (st.reactions[id].mine) st.reactions[id][st.reactions[id].mine] = Math.max(0, (st.reactions[id][st.reactions[id].mine] || 0) - 1); st.reactions[id].mine = em; }
        st.reactions[id][em] = (st.reactions[id][em] || 0) + 1;
        persistSimple(); renderReactions(id); beep(700, 0.08);
      }));
    }
    function renderMore(id) {
      const box = $x("#capyMore");
      if (!box) return;
      const s = SCRIPTS.find((x) => x.id === id);
      if (!s) return;
      const rec = SCRIPTS.filter((x) => x.id !== id).slice().sort(() => Math.random() - 0.5).slice(0, 3);
      const same = SCRIPTS.filter((x) => x.id !== id && x.category === s.category).slice(0, 3);
      box.innerHTML = `<h4 style="width:100%;margin:6px 0 4px;font-size:13px;color:var(--text-hi);">More in <b>${esc(s.category)}</b></h4>
        ${same.map((x) => `<button class="cp-rcard" data-go="${x.id}"><span class="em">${x.emoji}</span>${esc(x.name)}<small style="display:block;color:var(--text-lo);">${money(currentPrice(x))}</small></button>`).join("")}
        <h4 style="width:100%;margin:10px 0 4px;font-size:13px;color:var(--text-hi);">Recommended for you✨</h4>
        ${rec.map((x) => `<button class="cp-rcard" data-go="${x.id}"><span class="em">${x.emoji}</span>${esc(x.name)}<small style="display:block;color:var(--text-lo);">${money(currentPrice(x))}</small></button>`).join("")}
        <button class="capy-btn" data-copyscript="${s.id}">📋 Copy script ID</button>
        <button class="capy-btn" data-share="${s.id}">🔗 Share link</button>
        <button class="capy-btn" data-embed="${s.id}">🧩 Embed snippet</button>`;
      box.querySelectorAll("[data-go]").forEach((el) => el.addEventListener("click", () => { trackRecent(el.dataset.go); openDetail(el.dataset.go); }));
      box.querySelectorAll("[data-copyscript]").forEach((el) => el.addEventListener("click", () => { copyText(el.dataset.copyscript); note("Copied script ID: " + el.dataset.copyscript, "ok"); }));
      box.querySelectorAll("[data-share]").forEach((el) => el.addEventListener("click", () => { copyText(location.origin + location.pathname + "#script=" + el.dataset.share); note("Share link copied", "ok"); }));
      box.querySelectorAll("[data-embed]").forEach((el) => el.addEventListener("click", () => { const t = SCRIPTS.find((x) => x.id === el.dataset.embed); copyText(`&lt;!-- Capy Scripts embed --&gt;\n&lt;a href="${location.origin}${location.pathname}#script=${t.id}"&gt;${t.name} on Capy Scripts&lt;/a&gt;`); note("Embed snippet copied", "ok"); }));
    }
    function copyText(t) {
      try { if (navigator.clipboard) navigator.clipboard.writeText(t).catch(() => {}); } catch (e) {}
      const ta = document.createElement("textarea");
      ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove();
    }

    /* cart extras: coupon + progress + ghost quick view + share */
    function patchCart() {
      const drawer = document.querySelector("#cartDrawer");
      if (!drawer) return;
      const foot = document.querySelector("#cartFoot");
      if (!foot) return;
      const couponBox = document.createElement("div");
      couponBox.style.cssText = "padding:12px 14px;border-top:1px solid var(--line);";
      drawer.appendChild(couponBox);
      function renderCoupon() {
        const total = cartTotal();
        const need = 200;
        const pct = Math.min(100, Math.round((total / need) * 100));
        const applied = st.coupons.includes("CAPY10") ? 0.10 : st.coupons.includes("CAPY50") ? 0.50 : 0;
        couponBox.innerHTML = `<div class="capy-seg">Cart progress: <b>${total} RB$</b> ~ <b>${pct}%</b> to bundle tier ${need} RB$</div>
          <div class="capy-stepper"><i style="width:${pct}%"></i></div>
          <div class="capy-row">
            <input id="capyCouponIn" placeholder="Coupon (try CAPY10)" style="flex:1;min-width:100px;background:var(--panel);border:1px solid var(--glass-border);border-radius:8px;color:var(--text-hi);padding:6px 10px;font-size:12.5px;">
            <button class="capy-btn" id="capyCouponGo">Apply</button>
            <button class="capy-btn" id="capyCouponShare">🔗 Share cart</button>
          </div>
          <div class="capy-seg" style="margin-top:6px;">${applied ? "Coupon active: -" + Math.round(applied * 100) + "%" : "No coupon applied"}</div>`;
        const go = $x("#capyCouponGo");
        if (go) go.onclick = () => {
          const code = ($x("#capyCouponIn") ? $x("#capyCouponIn").value : "").trim().toUpperCase();
          if (["CAPY10", "CAPY50"].includes(code) && !st.coupons.includes(code)) { st.coupons.push(code); persistSimple(); note("🎟️ Coupon applied: " + code, "ok"); }
          else { note("Coupon invalid or already used", "err"); }
          renderCoupon();
        };
        const sh = $x("#capyCouponShare");
        if (sh) sh.onclick = () => {
          const q = cart.map((id) => "s=" + id).join("&");
          copyText(location.origin + location.pathname + "?cart=" + cart.join(","));
          note("Cart link copied — open in a new tab", "ok");
        };
      }
      renderCoupon();
      cart.onChange = () => renderCoupon();
      /* max items warning on add */
      const _origBind = window;
      /* hook badge click to show mini quick view */
      const cartBtn = document.querySelector("#cartBtn");
      if (cartBtn) cartBtn.addEventListener("mouseenter", showMiniCart);
      /* intercept add to cart overflow via MutationObserver on cart items */
      const obs = new MutationObserver(() => { renderCoupon(); });
      const itemsEl = document.querySelector("#cartItems");
      if (itemsEl) obs.observe(itemsEl, { childList: true });
    }
    function showMiniCart() {
      const mini = $x("#capyMiniCart");
      if (mini) mini.remove();
      if (!cart.length) return;
      const m = document.createElement("div");
      m.id = "capyMiniCart";
      m.style.cssText = "position:fixed;top:64px;right:12px;z-index:130;background:rgba(24,17,11,0.98);border:1px solid var(--glass-border);border-radius:14px;padding:12px;min-width:240px;box-shadow:0 12px 30px rgba(0,0,0,.5);";
      m.innerHTML = cart.slice(0, 5).map((id) => { const s = SCRIPTS.find((x) => x.id === id); return `<div style="font-size:12.5px;padding:4px 0;color:var(--text-hi);">${s.emoji} ${esc(s.name)} <small style="color:var(--text-lo)">${money(currentPrice(s))}</small></div>`; }).join("") + (cart.length > 5 ? `<div class="capy-seg">+${cart.length - 5} more</div>` : "") + `<button class="capy-btn" style="width:100%;margin-top:8px;" onclick="document.querySelector('#cartBtn').click()">Open cart</button>`;
      document.body.appendChild(m);
      setTimeout(() => m.remove(), 2200);
    }

    /* library toolbar */
    function patchLibrary() {
      const lib = document.querySelector("#libraryView");
      if (!lib) return;
      const wrap = document.createElement("div");
      wrap.className = "capy-row";
      wrap.id = "capyLibRow";
      lib.insertBefore(wrap, lib.firstChild);
      const inp = document.createElement("input");
      inp.placeholder = "Search library…";
      inp.style.cssText = "flex:1;min-width:140px;background:var(--panel);border:1px solid var(--glass-border);border-radius:9px;color:var(--text-hi);padding:7px 11px;font-size:13px;";
      wrap.appendChild(inp);
      const srt = document.createElement("select");
      srt.className = "sort"; srt.innerHTML = '<option value="recent">Recent</option><option value="az">A→Z</option><option value="price">Price</option>';
      srt.style.cssText = "font-size:12.5px;padding:6px 8px;border-radius:9px;background:var(--panel);color:var(--text-hi);border:1px solid var(--glass-border);";
      wrap.appendChild(srt);
      const cat = document.createElement("select");
      cat.className = "sort"; cat.innerHTML = '<option value="all">All categories</option>' + CATEGORIES.filter((c) => c.id !== "all").map((c) => `<option value="${c.id}">${c.label}</option>`).join("");
      cat.style.cssText = srt.style.cssText;
      wrap.appendChild(cat);
      const showFav = document.createElement("button");
      showFav.className = "capy-btn"; showFav.textContent = "⭐ Favs";
      wrap.appendChild(showFav);
      const copyAll = document.createElement("button");
      copyAll.className = "capy-btn"; copyAll.textContent = "📋 Copy all keys";
      wrap.appendChild(copyAll);
      const exportKeys = document.createElement("button");
      exportKeys.className = "capy-btn"; exportKeys.textContent = "⬇ Export keys";
      wrap.appendChild(exportKeys);
      let favOnly = false;
      function renderLib() {
        const grid = document.querySelector("#libraryGrid");
        if (!grid) return;
        let owned = user ? (user.purchases || []).map((p) => ({ p, s: SCRIPTS.find((x) => x.id === p.script) })).filter((o) => o.s) : [];
        const q = inp.value.trim().toLowerCase();
        owned = owned.filter((o) => (o.s.name + o.s.game + o.s.category).toLowerCase().includes(q));
        if (cat.value !== "all") owned = owned.filter((o) => o.s.category === cat.value);
        if (favOnly) owned = owned.filter((o) => st.favorites.includes(o.s.id));
        if (srt.value === "az") owned = owned.slice().sort((a, b) => a.s.name.localeCompare(b.s.name));
        else if (srt.value === "price") owned = owned.slice().sort((a, b) => currentPrice(a.s) - currentPrice(b.s));
        const ownedCount = user ? (user.purchases || []).length : 0;
        const rows = owned.map((o) => {
          const fav = st.favorites.includes(o.s.id);
          const days = Math.max(0, Math.floor((Date.now() - (o.p.time || Date.now())) / 86400000));
          return `<div class="capy-mini" style="min-width:230px;flex:1 0 230px;" data-oc="${o.s.id}">
            <div style="display:flex;justify-content:space-between;"><span>${o.s.emoji} <b>${esc(o.s.name)}</b></span><button class="capy-btn sm" data-fav="${o.s.id}" style="${fav ? "background:var(--mikan);color:#23150a;" : ""}">${fav ? "★" : "☆"}</button></div>
            <div class="capy-seg">${esc(o.s.game)} · bought ${days ? days + "d ago" : "today"}</div>
            <div class="capy-seg"><button class="capy-btn sm" data-key="${o.p.key}">🔑 Show key</button> <button class="capy-btn sm" data-copy="${o.p.key}">📋</button> <button class="capy-btn sm" data-dl="${o.s.id}|${o.p.key}">⬇️</button></div>
            <div class="capy-seg">renewal: ${o.s.updates}</div>
          </div>`;
        }).join("");
        grid.innerHTML = rows || `<div class="empty-state"><div class="em">🦫</div><p>Nothing matches — keep shopping!</p></div>`;
        grid.querySelectorAll("[data-oc]").forEach((el) => el.addEventListener("click", (e) => { if (e.target.closest("button")) return; const id = el.dataset.oc; openDetail(id); }));
        grid.querySelectorAll("[data-fav]").forEach((b) => b.addEventListener("click", () => { const id = b.dataset.fav; if (st.favorites.includes(id)) st.favorites = st.favorites.filter((x) => x !== id); else st.favorites.push(id); persistSimple(); renderLib(); }));
        grid.querySelectorAll("[data-key]").forEach((b) => b.addEventListener("click", () => { const k = b.dataset.key; b.textContent = b.textContent.includes("Show") ? (k.slice(0, 4) + "…" + k.slice(-4)) : "🔑 Show key"; }));
        grid.querySelectorAll("[data-copy]").forEach((b) => b.addEventListener("click", () => { copyText(b.dataset.copy); note("Key copied", "ok"); }));
        grid.querySelectorAll("[data-dl]").forEach((b) => b.addEventListener("click", () => { const [sid, keyv] = b.dataset.dl.split("|"); const a = document.createElement("a"); a.href = "/api/download?script=" + encodeURIComponent(sid) + "&key=" + encodeURIComponent(keyv); a.download = sid + ".lua"; a.click(); note("Downloading " + sid, "ok"); }));
        const ownedBar = $x("#capyOwnedBar");
        if (ownedBar) ownedBar.innerHTML = `<div class="capy-seg">Owned <b>${ownedCount}</b> / ${SCRIPTS.length} scripts (${Math.round(ownedCount / SCRIPTS.length * 100)}%)</div><div class="capy-stepper"><i style="width:${Math.round(ownedCount / SCRIPTS.length * 100)}%"></i></div>`;
      }
      inp.addEventListener("input", renderLib);
      srt.addEventListener("change", renderLib);
      cat.addEventListener("change", renderLib);
      showFav.onclick = () => { favOnly = !favOnly; showFav.classList.toggle("active", favOnly); renderLib(); };
      copyAll.onclick = () => { const all = (user && user.purchases || []).map((p) => p.script + " => " + p.key).join("\n"); copyText(all); note("All keys copied", "ok"); };
      exportKeys.onclick = () => { const all = (user && user.purchases || []).map((p) => p.script + " => " + p.key).join("\n"); const blob = new Blob([all], { type: "text/plain" }); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "capy-keys.txt"; a.click(); note("Keys exported", "ok"); };
      if (!$x("#capyOwnedBar")) {
        const ob = document.createElement("div");
        ob.id = "capyOwnedBar";
        lib.appendChild(ob);
      }
      const _origShow = showView;
      showView = (v) => { _origShow(v); if (v === "library") { renderLib(); } };
    }

    /* profile / wallet / stats / achievements / order history */
    function refreshProfile() { if ($x("#capyModal-stats")) openStats(); updateHeaderBadges(); }
    function openStats() {
      const n = user ? user.purchases.length : 0;
      const spent = (user ? user.purchases : []).reduce((a, p) => a + (p.price || 0), 0);
      const acq = (user ? user.purchases : []).map((p) => p.script);
      const ownScripts = SCRIPTS.filter((s) => acq.includes(s.id));
      const best = ownScripts.slice().sort((a, b) => b.rating - a.rating)[0];
      const avgRat = ownScripts.length ? (ownScripts.reduce((a, s) => a + s.rating, 0) / ownScripts.length).toFixed(1) : "–";
      modal("capyStats", `📊 <b>Capy Dashboard</b>`, `
        <div class="capy-facts">
          <div>Level <b>${currLevel()}</b> · XP <b>${st.xp}</b> ● Rank: <b>${rankTitle()}</b></div>
          <div>Visits <b>${st.visitCount}</b> · Streak <b>${st.streak}</b>d · Session <b>${Math.floor((Date.now() - sessionStart) / 60000)}m</b></div>
          <div>Scripts owned <b>${n}</b> / ${SCRIPTS.length} · Spent <b>${money(spent)}</b> · Best rated owned: <b>${best ? best.name : "–"}</b> ★${avgRat}</div>
          <div>Demo wallet <b>${money(st.wallet)}</b> · Orders <b>${st.orders.length}</b> · Achievements <b>${st.ach.length}/${ACH.length}</b></div>
          <div>Wishlist <b>${st.wishlist.length}</b> · Favorites <b>${st.favorites.length}</b> · Watched tickers <b>${st.watched.length}</b></div>
        </div>
        <div class="capy-note">Achievements & XP are per-browser demos. Dashboard refreshes as you use the site.</div>
        <div class="capy-row"><button class="capy-btn" data-goto="ach">🏆 Achievements</button><button class="capy-btn" data-goto="orders">🧾 Orders</button><button class="capy-btn" data-goto="wallet">👛 Wallet</button><button class="capy-btn" data-goto="stats2">⏱ Session stats</button></div>
      `);
      hookStatNav();
    }
    function hookStatNav() {
      document.querySelectorAll("#capyModal-stats [data-goto]").forEach((b) => {
        b.onclick = () => { closeModal("capyStats"); if (b.dataset.goto === "ach") openAch(); else if (b.dataset.goto === "orders") openOrders(); else if (b.dataset.goto === "wallet") openWallet(); else openSession2(); };
      });
    }
    function rankTitle() {
      const lvl = currLevel();
      return lvl >= 20 ? "Capybara Legend" : lvl >= 10 ? "Script Master" : lvl >= 5 ? "Active Seller" : "Member";
    }
    function openOrders() {
      modal("capyOrders", "🧾 <b>Order history</b>", st.orders.length ? st.orders.slice(0, 20).map((o) => `<div class="capy-seg">${new Date(o.t).toLocaleString()} · <b>${o.count}</b> scripts · ${money(o.total)}</div>`).join("") : `<div class="capy-seg">No orders yet — buy a script and your receipt lands here.</div>`);
    }
    function openWallet() {
      modal("capyWallet", "👛 <b>Demo wallet</b>", `
        <div class="capy-facts">
          <div>Balance <b>${money(st.wallet)}</b> (demo RB$, per browser)</div>
          <div>Sources: daily bonus, wheel, scratch, coin flip, lottery, offline income.</div>
        </div>
        <div class="capy-row">
          <button class="capy-btn" data-wcapy="flip">🪙 Coin flip (+25)"</button>
          <button class="capy-btn" data-wcapy="scratch">🎫 Scratch (+varies)"</button>
          <button class="capy-btn" data-wcapy="lotto">🎰 Lotto (pick 3)"</button>
          <button class="capy-btn" data-wcapy="spin">🎡 Wheel (daily)"</button>
        </div>
      `, () => {
        document.querySelectorAll("#capyModal-wallet [data-wcapy]").forEach((b) => { b.onclick = () => { closeModal("capyWallet"); if (b.dataset.wcapy === "flip") flipCoin(); else if (b.dataset.wcapy === "scratch") openScratch(); else if (b.dataset.wcapy === "lotto") openLotto(); else openWheel(); }; });
      });
    }
    function openSession2() {
      modal("capyStats2", "⏱ <b>Session & activity</b>", `
        <div class="capy-facts">
          <div>Started: <b>${new Date(sessionStart).toLocaleTimeString()}</b></div>
          <div>Session length: <b>${Math.floor((Date.now() - sessionStart) / 60000)}m</b></div>
          <div>Pages loaded: <b>${st.visitCount}</b></div>
          <div>Purchases this browser: <b>${st.orders.length}</b></div>
          <div>Reactions made: <b>${Object.keys(st.reactions).length}</b></div>
        </div>`);
    }
    function openAch() {
      modal("capyAch", "🏆 <b>Achievements</b>", ACH.map((a) => {
        const got = st.ach.includes(a.id);
        return `<div class="capy-ach ${got ? "done" : ""}"><span class="ic">${got ? a.ic : "🔒"}</span><span class="nm"><b>${esc(a.nm)}</b><small>${esc(a.desc)} · +${a.xp} XP</small></span></div>`;
      }).join(""));
    }

    /* wins: wallet games */
    function addWallet(n) { st.wallet += n; persistSimple(); note(`👛 +${n} RB$ (demo wallet)`, "ok"); beep(800, 0.1); }
    function flipCoin() {
      const now = Date.now();
      if (now - st.coinTs < 3600000) { note("Coin flip on cooldown (1h)", "err"); return; }
      st.coinTs = now;
      const win = Math.random() < 0.5;
      addWallet(win ? 25 : 5);
      note(`🪙 ${win ? "Heads! +25" : "Tails… +5 consolation"}`, "ok");
    }
    function openScratch() {
      const prize = pick([10, 15, 20, 25, 50, 100]);
      modal("capyScratch", "🎫 <b>Scratch card</b>", `
        <div class="scratch" id="capyScratchBox"><div class="sc-tg">+${prize} RB$</div><div class="mask"><canvas id="capyScratchCv" width="240" height="110"></canvas></div></div>
        <div class="capy-note">Scratch with your mouse / finger.</div>`, () => {
        const cv = document.querySelector("#capyScratchCv");
        if (!cv) return;
        const ctx = cv.getContext("2d");
        ctx.fillStyle = "#5a3a20"; ctx.fillRect(0, 0, 240, 110);
        ctx.fillStyle = "#8a5a30";
        for (let i = 0; i < 40; i++) { ctx.fillRect(Math.random() * 240, Math.random() * 110, 14, 4); }
        let cleared = 0;
        const wipe = (x, y) => { ctx.globalCompositeOperation = "destination-out"; ctx.beginPath(); ctx.arc(x, y, 16, 0, Math.PI * 2); ctx.fill(); ctx.globalCompositeOperation = "source-over"; };
        const pos = (e) => { const r = cv.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
        cv.addEventListener("mousemove", (e) => wipe(...pos(e)));
        cv.addEventListener("touchmove", (e) => { [...e.touches].forEach((t) => wipe(t.clientX - cv.getBoundingClientRect().left, t.clientY - cv.getBoundingClientRect().top)); }, { passive: true });
        setTimeout(() => { try { const d = ctx.getImageData(0, 0, 240, 110).data; let transparent = 0; for (let i = 3; i < d.length; i += 16) if (d[i] === 0) transparent++; const pct = transparent / (d.length / 16); if (pct > 0.3) { addWallet(prize); } } catch (e) {} }, 4000);
      });
    }
    function openLotto() {
      const nums = Array.from({ length: 3 }, () => rand(1, 9)).join("");
      modal("capyLotto", "🎰 <b>Pick 3 lotto</b>", `
        <div class="capy-facts"><div>Pick 3 numbers (0-9):</div></div>
        <div class="capy-row"><input id="capyLotIn" maxlength="3" style="width:110px;background:var(--panel);border:1px solid var(--glass-border);border-radius:9px;color:var(--text-hi);padding:8px;font-size:22px;text-align:center;letter-spacing:4px;"></div>
        <div class="capy-note">Drawing will match <b>${nums}</b></div>`, () => {
        const btn = document.createElement("button");
        btn.className = "capy-btn"; btn.textContent = "Draw 🎯";
        document.querySelector("#capyModal-lotto .capy-card").appendChild(btn);
        btn.onclick = () => {
          const guess = (document.querySelector("#capyLotIn") || {}).value || "000";
          let w = 0; let p = 0;
          for (let i = 0; i < 3; i++) { if (guess[i] === nums[i]) w++; else if (nums.includes(guess[i])) p++; }
          const prize = w === 3 ? 150 : w === 2 ? 40 : w === 1 ? 10 : p ? 5 : 0;
          if (prize) addWallet(prize);
          note(`🎰 ${guess} vs ${nums} — ${prize ? "+" + prize + " RB$" : "no win"}. Match ${w}/3, partial ${p}`, prize ? "ok" : "err");
          closeModal("capyLotto");
        };
      });
    }
    function openWheel() {
      const prizes = [100, 5, 25, 50, 10, 0];
      const today = stateDay();
      if (st.flags.wheelDay === today) { modal("capyWheel", "🎡 <b>Daily wheel</b>", `<div class="capy-seg">You already spun today — come back tomorrow! 🦫</div>`); return; }
      modal("capyWheel", "🎡 <b>Daily wheel</b>", `
        <div id="capyWheelWrap"><div class="capy-wheel" id="capyWheel"><span class="ptr">▼</span>
          ${prizes.map((p, i) => `<div class="${i % 2 ? "p2" : ""}" style="transform:rotate(${i * 60}deg)">${p}</div>`).join("")}
        </div></div>
        <div class="capy-note">One free spin per day.</div>`, () => {
        const wheel = document.querySelector("#capyWheel");
        const wrap = document.querySelector("#capyWheelWrap");
        if (!wheel) return;
        const spin = document.createElement("button");
        spin.className = "capy-btn";
        spin.textContent = "SPIN";
        wrap.appendChild(spin);
        spin.onclick = () => {
          const idx = rand(0, prizes.length - 1);
          const deg = 360 * 4 + idx * 60 + rand(10, 50);
          wheel.style.transform = `rotate(${deg}deg)`;
          setTimeout(() => {
            st.flags.wheelDay = today;
            st.spinCount = (st.spinCount || 0) + 1;
            if (prizes[idx] > 0) addWallet(prizes[idx]); else note("🎡 Wheel: you spun a nap… 0 RB$ 🦫", "err");
            unlock("wheel1"); checkAch();
            closeModal("capyWheel");
          }, 3500);
        };
      });
    }

    /* coupon via checkout hook */
    function applyCouponToPayable() {
      const couponTotal = cart
        .reduce((sum, id) => { const s = SCRIPTS.find((x) => x.id === id); return sum + (s ? currentPrice(s) : 0); }, 0);
      const app = st.coupons.includes("CAPY50") ? 0.5 : st.coupons.includes("CAPY10") ? 0.1 : 0;
      return Math.round(couponTotal * (1 - app) * (1 - discountFor()) * 100) / 100;
    }
    /* piggy-back on the existing pay flow: observe success modal */
    function observePay() {
      const succ = document.querySelector("#successModal");
      if (!succ) return;
      new MutationObserver(() => {
        if (succ.classList.contains("show")) {
          const total = money(applyCouponToPayable());
          const rec = { t: Date.now(), count: cart.length, total: cartTotal() };
          st.orders.unshift(rec);
          st.orders = st.orders.slice(0, 50);
          st.wishlist = st.wishlist.filter((id) => !cart.includes(id));
          persistSimple();
          confetti(70);
          beep(880, 0.25); setTimeout(() => beep(1100, 0.3), 180);
          note("🧾 Order saved to history · ~" + total + " · receipt copied", "ok");
          const btn = document.createElement("button");
          btn.className = "capy-btn"; btn.textContent = "🧾 Copy receipt";
          btn.style.cssText = "margin:10px auto;display:block;";
          btn.onclick = () => { copyText("Capy Scripts order " + rec.t + " — " + rec.count + " scripts, " + money(rec.total)); note("Receipt copied", "ok"); };
          try { document.querySelector("#successModal .capy-card") ? null : document.querySelector("#successModal").appendChild(btn); } catch (e) {}
          checkAch();
        }
      }).observe(succ, { attributes: true, attributeFilter: ["class"] });
    }

    /* wishlist & bell drawers + compare + podium + help */
    function openWishlist() {
      const list = st.wishlist.map((id) => { const s = SCRIPTS.find((x) => x.id === id); return s ? `<div class="capy-mini" data-open="${s.id}" style="cursor:pointer;">${s.emoji} <b>${esc(s.name)}</b><br><small>${money(currentPrice(s))}</small></div>` : ""; }).join("") || `<div class="capy-seg">Nothing wishlisted yet — tap ♥ or press W on a card.</div>`;
      modal("capyWish", "💛 <b>Wishlist</b>", `<div class="capy-strip" style="flex-wrap:wrap;">${list}</div>`);
      document.querySelectorAll("#capyModal-wish [data-open]").forEach((el) => el.addEventListener("click", () => { closeModal("capyWish"); openDetail(el.dataset.open); }));
    }
    function openBell() {
      const rows = history.length ? history.slice(0, 30).map((h) => `<div class="capy-seg"><b>${h.t}</b> — ${esc(h.msg)}</div>`).join("") : `<div class="capy-seg">No notifications yet.</div>`;
      modal("capyBell", "🔔 <b>Notifications</b>", rows);
      const bb = $x("#capyBellBadge"); if (bb) bb.classList.add("hidden");
    }
    function openCompare() {
      modal("capyCompare", "⚖️ <b>Compare scripts</b>", `
        <div class="capy-row">
          <select id="capyCmpA" class="sort"></select>
          <select id="capyCmpB" class="sort"></select>
        </div>
        <div class="cp-compare" id="capyCmpOut" style="margin-top:10px;"></div>`, () => {
        const sa = document.querySelector("#capyCmpA");
        const sb = document.querySelector("#capyCmpB");
        SCRIPTS.forEach((s) => { sa.appendChild(new Option(s.name, s.id)); sb.appendChild(new Option(s.name, s.id)); });
        sa.selectedIndex = 0; sb.selectedIndex = 1;
        const draw = () => {
          const a = SCRIPTS.find((x) => x.id === sa.value);
          const b = SCRIPTS.find((x) => x.id === sb.value);
          if (!a || !b) return;
          document.querySelector("#capyCmpOut").innerHTML = [a, b].map((s) => `
            <div class="box" data-go="${s.id}" style="cursor:pointer;">
              <div style="font-size:26px;">${s.emoji}</div>
              <b>${esc(s.name)}</b><br>
              <span class="capy-seg">★ ${s.rating.toFixed(1)} · ${s.sales.toLocaleString()} sales</span><br>
              <span class="capy-seg">${money(currentPrice(s))}${s.oldPrice ? ` <del>${money(s.oldPrice)}</del>` : ""}</span><br>
              <span class="capy-seg">${esc(s.category)} · ${esc(s.game)}</span><br>
              <small style="color:var(--text-lo);">${esc(s.desc)}</small>
            </div>`).join("");
          document.querySelectorAll("#capyCmpOut [data-go]").forEach((el) => el.addEventListener("click", () => { closeModal("capyCompare"); openDetail(el.dataset.go); }));
        };
        sa.addEventListener("change", draw); sb.addEventListener("change", draw); draw();
      });
    }
    function openPodium() {
      const top = SCRIPTS.slice().sort((a, b) => b.sales - a.sales).slice(0, 3);
      const medals = ["🥇", "🥈", "🥉"];
      modal("capyPodium", "🏁 <b>Hall of fame</b>", `<div class="capy-facts">${top.map((s, i) => `<div data-go="${s.id}" style="cursor:pointer;"><b>${medals[i]} ${esc(s.name)}</b> — ${money(currentPrice(s))} · ★ ${s.rating.toFixed(1)} · ${s.sales.toLocaleString()} sales</div>`).join("")}</div>`);
      document.querySelectorAll("#capyModal-podium [data-go]").forEach((el) => el.addEventListener("click", () => { closeModal("capyPodium"); openDetail(el.dataset.go); }));
    }
    function openHelp() {
      modal("capyHelp", "❓ <b>Keyboard & shortcuts</b>", `
        <div class="capy-facts">
          <div><b>/?</b> this help · <b>G</b> go to shop · <b>L</b> go to library</div>
          <div><b>Ctrl+K</b> or <b>/</b> focus search · <b>F</b> fullscreen</div>
          <div><b>W</b> wishlist current card · <b>M</b> dashboard</div>
          <div><b>U</b> surprise me · <b>Esc</b> close overlays</div>
          <div>💡 Konami code: ↑↑↓↓←→←→BA — try it!</div>
          <div>💡 Click the logo 5× fast → capybara rain</div>
          <div>💡 Wheel, scratch, lotto & coin earn demo RB$ in your wallet.</div>
        </div>`);
    }
    function modal(id, titleHTML, bodyHTML, after) {
      closeModal(id);
      const wrap = document.createElement("div");
      wrap.className = "capy-modal show";
      wrap.id = "capyModal-" + id;
      wrap.innerHTML = `<div class="capy-card"><div class="capy-hb"><h3>${titleHTML}</h3><span class="x" data-cm="1">✕</span></div>${bodyHTML}</div>`;
      document.body.appendChild(wrap);
      wrap.addEventListener("click", (e) => { if (e.target === wrap || e.target.closest("[data-cm]")) closeModal(id); });
      if (after) after();
    }
    function closeModal(id) {
      const m = document.querySelector("#capyModal-" + id);
      if (m) m.remove();
    }

    /* surprise */
    function surpriseScript() {
      const s = pick(SCRIPTS);
      trackRecent(s.id);
      openDetail(s.id);
      note(`🎲 Surprise! → ${s.emoji} ${s.name}`, "ok");
      beep(620, 0.1);
    }

    /* keyboard */
    const KONAMI = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
    let kpos = 0;
    let logoClicks = 0, logoLast = 0;
    function bindKeys() {
      document.addEventListener("keydown", (e) => {
        const inp = e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA" || e.target.isContentEditable);
        const k = e.key.toLowerCase();
        if (!inp) {
          if (k === "/") { const s = document.querySelector("#searchInput"); if (s) { e.preventDefault(); s.focus(); } }
          if (k === "g") { goTo("shop"); }
          if (k === "l") { goTo("library"); }
          if (k === "?") { openHelp(); }
          if (k === "f") { toggleFs(); }
          if (k === "m") { openStats(); }
          if (k === "u") { surpriseScript(); }
        } else if (k === "/" && e.ctrlKey) { /* contenteditable ignore */ }
        if ((e.ctrlKey || e.metaKey) && k === "k") { e.preventDefault(); const s = document.querySelector("#searchInput"); if (s) s.focus(); }
        if ((e.ctrlKey || e.metaKey) && k === "l") { e.preventDefault(); goTo("library"); }
        if ((e.ctrlKey || e.metaKey) && k === "g") { e.preventDefault(); goTo("shop"); }
        if (!inp && k === "w") { wishFocused(); }
        /* konami */
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        const need = KONAMI[kpos];
        if ((need === "a" || need === "b" ? need : need) === key || key === need) { kpos++; if (kpos === KONAMI.length) { kpos = 0; konami(); } } else if (key !== need) { kpos = key === KONAMI[0] ? 1 : 0; }
      });
      /* logo clicks → capy rain */
      const logo = document.querySelector("header .brand, header a.brand");
      if (logo) logo.addEventListener("click", () => {
        const now = Date.now();
        if (now - logoLast < 1200) logoClicks++; else logoClicks = 1;
        logoLast = now;
        if (logoClicks >= 5) { logoClicks = 0; capyRain(); note("🦫 CAPY RAIN!", "ok"); }
      });
    }
    function toggleFs() { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); }
    function wishFocused() {
      const f = document.querySelector("#productGrid .card:hover, #productGrid .card:focus-within");
      if (f && f.dataset.id) toggleWish(f.dataset.id);
    }
    function konami() { confetti(90); capyRain(); note("🎉 KONAMI — Ultra Capy Mode!", "ok"); beep(880, 0.2); }
    function toggleWish(id) {
      if (st.wishlist.includes(id)) st.wishlist = st.wishlist.filter((x) => x !== id);
      else { st.wishlist.push(id); beep(760, 0.08); }
      persistSimple(); updateHeaderBadges(); checkAch();
      const s = SCRIPTS.find((x) => x.id === id);
      if (s) note(st.wishlist.includes(id) ? `💛 Wishlisted ${s.name}` : `💔 Removed ${s.name} from wishlist`, "ok");
    }

    /* wishlist hearts on cards */
    function addHearts() {
      const _or = renderGrid;
      renderGrid = () => { _or(); addHeartToCards(); };
      const _oe = window.__capyRender;
    }
    function addHeartToCards() {
      document.querySelectorAll("#productGrid .card").forEach((cd) => {
        if (cd.querySelector(".capy-heart")) return;
        const id = cd.dataset.id;
        const on = st.wishlist.includes(id);
        const h = document.createElement("button");
        h.className = "capy-btn sm capy-heart";
        h.textContent = on ? "♥" : "♡";
        h.style.cssText = "position:absolute;top:8px;right:8px;z-index:3;background:rgba(10,7,5,.6);border:none;width:26px;height:26px;border-radius:8px;font-size:14px;";
        h.onclick = () => toggleWish(id);
        cd.style.position = "relative";
        cd.appendChild(h);
      });
    }

    /* market movers + watchlist alerts */
    function marketMovers() {
      let m = null;
      try { m = JSON.parse(localStorage.getItem("capy_market_v1") || "null"); } catch (e) {}
      if (!m) return;
      const movers = Object.entries(m.change || {}).filter(([k, v]) => v).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1])).slice(0, 2);
      movers.forEach(([t, v]) => {
        const name = t;
        if (st.watched.includes(t) && v * (st.flags.lastWatch || 0) < 0) note(`📈 ${name} moved ${v > 0 ? "+" : ""}${v} RBX — watchlist alert!`, "ok");
      });
      st.flags.lastWatch = Date.now();
    }
    /* add "watch" toggle in market output? Handled by pressing W? Simpler: watching via dashboard */

    /* daily bonus & offline income */
    function dailyBonus() {
      const today = stateDay();
      if (st.dailyTs !== today) {
        st.dailyTs = today;
        st.flags.dailyCount = (st.flags.dailyCount || 0) + 1;
        const bonus = 50;
        addWallet(bonus);
        note(`🗓️ Daily bonus! +${bonus} RB$ demo — streak ${st.streak}`, "ok");
        if (st.flags.dailyCount >= 3) unlock("daily3");
      }
    }
    function streakCheck() {
      const today = stateDay();
      if (st.lastVisit !== today) {
        const yday = (function () { const d = new Date(); d.setDate(d.getDate() - 1); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); })();
        st.streak = st.lastVisit === yday ? (st.streak || 0) + 1 : 1;
        st.lastVisit = today;
        persistSimple();
        const offline = Math.max(0, Math.floor((Date.now() - (st.flags.offlineCheck || Date.now())) / 86400000) - 1) * 20;
        if (offline > 0) { addWallet(offline); note(`🌙 Offline income: +${offline} RB$ demo`, "ok"); }
        st.flags.offlineCheck = Date.now();
        if (st.streak >= 5) unlock("streak5");
      }
    }

    /* mascot */
    const CAPY_LINES = { load: "I was just chilling… welcome!", buy: "Enjoy your new script! 🥕", daily: "Fresh bonus? I got a carrot for it.", wheel: "Spin it, don't drown it.", error: "Oof. Even capybaras trip sometimes.", custom: "" };
    function buildMascot() {
      const m = document.createElement("div");
      m.className = "capy-mascot";
      m.id = "capyMascot";
      m.textContent = "🦫";
      document.body.appendChild(m);
      const bubble = document.createElement("div");
      bubble.className = "capy-mbubble";
      bubble.id = "capyMascotBubble";
      document.body.appendChild(bubble);
      m.addEventListener("click", () => {
        m.classList.add("boop"); setTimeout(() => m.classList.remove("boop"), 500);
        say("Hi! I'm Capy 🦫 Tap the ♥ hearts, try the wheel, and remember to hydrate. 🧃");
        setTimeout(dailyBonus, 300);
      });
      m.addEventListener("mouseenter", () => say(pick(["Snack time 🥕", "I live for carrots", "Warm enough?", "Do you have watermelon?", "Chill? 😌"])));
    }
    function say(txt) {
      const b = $x("#capyMascotBubble");
      if (!b) return;
      b.textContent = txt;
      b.classList.add("show");
      setTimeout(() => b.classList.remove("show"), 3500);
    }

    /* toasts history badge sync */
    function syncBellOnToast() {
      /* ensure every existing toast call increments history (done via note wrapper; also intercept app's toast) */
      try {
        const _toast = toast;
        toast = (msg, type) => { _toast(msg, type); };
      } catch (e) {}
      /* nothing to patch — our note() is the wrapper */
    }

    /* deep link + cart link */
    function deepLink() {
      const h = location.hash;
      const q = new URLSearchParams(location.search);
      if (h.indexOf("#script=") === 0) {
        const id = decodeURIComponent(h.slice(8));
        setTimeout(() => { const s = SCRIPTS.find((x) => x.id === id); if (s) openDetail(s.id); }, 500);
      } else if (q.get("cart")) {
        const ids = q.get("cart").split(",").filter(Boolean);
        const found = ids.filter((id) => SCRIPTS.some((s) => s.id === id));
        if (found.length) { found.forEach((id) => { if (!cart.includes(id)) cart.push(id); }); renderCart(); note("Cart loaded from link (" + found.length + ")", "ok"); }
      }
    }

    /* applyView helper for grid/list & live refresh of extras */
    function applyView() { ownRender(); }

    function boot() {
      ensureCanvases();
      fxInit();
      buildHeader();
      buildBar();
      buildToolbar();
      buildSearch();
      patchDetail();
      patchCart();
      patchLibrary();
      observePay();
      buildMascot();
      bindKeys();
      addHeartToCards();
      ownRender();
      deepLink();
      streakCheck();
      dailyBonus();
      checkAch();
      applyAccent();
      updateHeaderBadges();
      renderRecentSearches();
      /* periodic */
      setInterval(() => { marketMovers(); updateHeaderBadges(); }, 9000);
      setInterval(() => { renderBarClock(); }, 1000);
      function renderBarClock() {
        const el = $x("#capyBar");
        if (el) buildBarInner();
      }
      function buildBarInner() {
        const d = new Date();
        const hh = String(d.getHours()).padStart(2, "0");
        const mm = String(d.getMinutes()).padStart(2, "0");
        const ss = String(d.getSeconds()).padStart(2, "0");
        const hr = d.getHours();
        const greet = hr < 5 ? "Late night grind" : hr < 12 ? "Good morning" : hr < 18 ? "Good afternoon" : hr < 22 ? "Good evening" : "Night owl";
        const onl = Math.max(0, Math.round(15 * 0.6 + st.visitCount * 0.15 + Math.random() * 3));
        const secs = Math.floor((Date.now() - sessionStart) / 1000);
        el.innerHTML = `
          <div class="capy-tick">
            <span>${greet}, capybara! 👋</span>
            <span>🕐 <b>${hh}:${mm}:${ss}</b></span>
            <span>⏱️ session <b>${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}</b></span>
            <span>🟢 <b>${onl}</b> online</span>
            <span>📊 visits <b>${st.visitCount}</b></span>
            <span title="Total sessions today">🔥 <b>${st.streak}</b> day streak</span>
          </div>
          <div class="capy-tip"><span id="capyTipTxt2">${$x("#capyTipTxt") ? $x("#capyTipTxt").textContent : ""}</span></div>`;
        if ($x("#capyTipTxt")) { /* keep original tip element */ }
      }
    }

    /* also hook library refresh after purchases via success */
    document.addEventListener("DOMContentLoaded", () => { setTimeout(() => { try { boot(); window.__capyBoot = "ok"; } catch (e) { window.__capyBoot = "fail:" + e.message; if (window.console && console.error) console.error("capy100 init:", e); try { note("Capy extras init issue: " + e.message, "err"); } catch (_) {} } }, 50); });
  })();

  document.addEventListener("DOMContentLoaded", init);
})();