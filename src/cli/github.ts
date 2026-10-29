/**
 * Task 35 — `sc github` (and `sc repo`, which is the same command): the machine
 * face of the GitHub add-on.
 *
 * Why a CLI at all when the web/TUI/Telegram all have it: connecting an account
 * and looking at what is uncommitted are the two things you do *before* you trust
 * an agent with a repository, and a headless box (this project's whole premise)
 * has no other surface. So the CLI is the smallest complete shell around the
 * same service methods the other three call — no separate implementation, no
 * second publish path.
 *
 * Credential rule, enforced by `github.ts` rather than here: every printed line
 * goes through `redact()`, and every credential write lands 0600 in the state
 * dir. A token must never appear in a terminal transcript, a `.git/config`, or a
 * log line.
 */
import { resolveGithubCreds, redact } from "../repo/github.js";
import { RepoManager } from "../repo/manager.js";

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

function usage(): number {
  out("usage: sc github <command>");
  out("");
  out("  status                  who is connected, how, and whether it can push");
  out("  connect                 device-flow login (needs addons.github.clientId)");
  out("  adopt-gh                keep the credential an existing `gh auth login` wrote");
  out("  disconnect              forget the stored token (env/gh logins are untouched)");
  out("  repos [--filter text] [--limit N]");
  out("                          list repositories this account can see, private marked");
  out("  branches <owner/name>   the branches this account could continue");
  out("  code <owner/name> [branch] [--session key]");
  out("                          continue that repository's branch in a session");
  out("  publish [--session key] [--title t] [--open]");
  out("                          open a pull request — draft unless --open");
  out("");
  out("`sc repo` is the same command. Publishing from the CLI still needs a");
  out("session that is actually bound: `sc github code owner/name --session main:work`.");
  return 1;
}

export async function cmdGithub(argv: string[]): Promise<number> {
  const { Service } = await import("../agent/service.js");
  const sub = (argv[0] ?? "").replace(/^--/, "");
  if (!sub || sub === "help" || sub === "--help") return usage();

  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const svc = new Service();

  try {
    if (sub === "status") {
      const status = await svc.githubStatus();
      out(`host       ${status.host}`);
      out(`connected  ${status.connected ? "yes" : "no"}`);
      if (status.connected) {
        out(`account    ${status.login}`);
        out(`source     ${status.source}${status.source === "token" ? " (stored by the device flow)" : ""}`);
        out(`scopes     ${status.scopes.length ? status.scopes.join(", ") : "(unknown — assumed repo read:user)"}`);
        out(`can push   ${status.scopes.length === 0 || status.scopes.includes("repo") ? "yes" : "no — missing the repo scope, so no private repos and no pushes"}`);
      } else {
        out("");
        out("Nothing is connected. Two ways in, pick one:");
        out("  sc github adopt-gh    reuse `gh auth login` on this machine (no browser)");
        out("  sc github connect     device flow — set addons.github.clientId first");
      }
      return 0;
    }

    if (sub === "connect") {
      if (!svc.config.addons.github.clientId) {
        out("no addons.github.clientId — create an OAuth app (device flow enabled) and run:");
        out("  sc config set addons.github.clientId <id>");
        out("");
        out("Or skip the browser entirely: `sc github adopt-gh` if `gh` is logged in.");
        return 1;
      }
      const res = await svc.githubConnect({
        onCode: (info) => {
          out("");
          out(`  open  ${info.verificationUri}`);
          out(`  code  ${info.userCode}`);
          out("");
          out(`waiting for approval (expires in ${Math.round(info.expiresIn / 60)} min)…`);
        },
      });
      out(`connected as ${res.login} on ${res.host} (${res.scopes.join(", ") || "scopes unknown"})`);
      return 0;
    }

    if (sub === "adopt-gh") {
      const res = svc.githubAdoptGhCli();
      if (!res.ok) {
        out(res.error ?? "no gh login found");
        return 1;
      }
      out(`connected as ${res.login} via the existing gh login — stored 0600 in the state dir`);
      return 0;
    }

    if (sub === "disconnect") {
      const had = svc.githubDisconnect();
      out(had ? "stored token removed" : "nothing was stored — env and gh logins are untouched");
      return 0;
    }

    if (sub === "repos") {
      const rows = await svc.githubRepos({ filter: flag("filter"), page: 1 });
      const limit = Number(flag("limit") ?? 30) || 30;
      if (!rows.length) {
        out("no repositories returned — an empty account, or a token without the repo scope");
        return 0;
      }
      for (const r of rows.slice(0, limit)) {
        const lock = r.private ? "private" : "public ";
        out(`${lock}  ${r.fullName}${r.defaultBranch ? `   (default ${r.defaultBranch})` : ""}`);
      }
      return 0;
    }

    if (sub === "branches") {
      const repo = argv.slice(1).find((a) => !a.startsWith("--"));
      if (!repo || !repo.includes("/")) {
        out("usage: sc github branches <owner/name>");
        return 1;
      }
      const defaultBranch = flag("base");
      const branches = await svc.githubBranches({ repo, base: defaultBranch });
      if (!branches.length) {
        out("no branches returned — an empty repository, or a token without the repo scope");
        return 0;
      }
      for (const b of branches) out(`${b.default ? "*" : " "} ${b.name}${b.protected ? "   (protected)" : ""}`);
      out("");
      out("continue one:  sc github code " + repo + " <branch>");
      return 0;
    }

    if (sub === "code") {
      // Positionals only: skip the flags *and* their values, so
      // `code --session main:x owner/name` and `code owner/name --session main:x`
      // both read the repo from the same place.
      const positional: string[] = [];
      for (let i = 1; i < argv.length; i++) {
        const a = argv[i]!;
        if (a.startsWith("--")) {
          i++; // its value is not a positional
          continue;
        }
        positional.push(a);
      }
      const repo = positional[0];
      const base = positional[1];
      const sessionKey = flag("session") ?? "main:cli";
      if (!repo || !repo.includes("/")) {
        out("usage: sc github code <owner/name> [branch] [--session key]");
        return 1;
      }
      out(`preparing ${repo}${base ? ` on ${base}` : ""} in ${svc.store.getSessionRepo(sessionKey)?.workspace ?? "(new worktree)"}…`);
      // `base` here is the branch argument: the branch this session continues.
      const bound = await svc.bindRepo({ sessionKey, repo, base });
      if (!bound.ok) {
        out(bound.error);
        return 1;
      }
      out(`session ${sessionKey} → ${bound.repo} · ${bound.branch} (from ${bound.base})`);
      out(`workspace ${bound.workspace}`);
      out("");
      out(`next: sc chat --session ${sessionKey}   or   /repo inside it`);
      return 0;
    }

    if (sub === "publish") {
      const sessionKey = flag("session") ?? "main:cli";
      const binding = svc.store.getSessionRepo(sessionKey);
      if (!binding) {
        out(`session ${sessionKey} is not bound — run sc github code <owner/name> --session ${sessionKey} first`);
        return 1;
      }
      const st = await svc.repos.status(binding.workspace);
      if (st.clean) {
        out("nothing to publish — the worktree is clean");
        return 1;
      }
      const manager = new RepoManager({ host: svc.config.addons.github.host });
      try {
        const res = await manager.publish({
          workspace: binding.workspace,
          repo: binding.repo,
          base: binding.base,
          branch: binding.branch,
          creds: resolveGithubCreds({ host: svc.config.addons.github.host }),
          title: flag("title") ?? `Changes from ${sessionKey.replace(/^main:/, "")}`,
          draft: !argv.includes("--open"),
          sessionKey,
        });
        out(`${res.draft ? "draft " : ""}pull request #${res.prNumber}: ${res.prUrl}`);
        out(`branch ${res.branch}`);
        return 0;
      } catch (err) {
        out(redact((err as Error).message, svc.githubCreds()?.token));
        return 1;
      }
    }

    out(`unknown github command "${sub}"`);
    return usage();
  } catch (err) {
    // Every failure sentence is redacted: a token can leak through a fetch error
    // that echoes the Authorization header, and a terminal transcript is forever.
    out(redact((err as Error).message, svc.githubCreds()?.token));
    return 1;
  }
}

/** Kept for `sc github --help` discoverability from the doctor/status screens. */
export function githubCliHelp(): string {
  return "sc github <status|connect|adopt-gh|disconnect|repos|code|publish>";
}
