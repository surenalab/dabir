import { useCallback, useEffect, useState } from "react";
import { githubInvite, githubPeople, githubRemove, openExternal, type GithubPeople as People } from "../lib/backend";

interface Props {
  root: string;
  onNote: (text: string) => void;
}

export function GithubPeople({ root, onNote }: Props) {
  const [data, setData] = useState<People | null>(null);
  const [busy, setBusy] = useState(false);
  const [login, setLogin] = useState("");
  const [perm, setPerm] = useState("write");
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(() => {
    githubPeople(root).then(setData).catch((e) => setData({
      repo: null, gh: false, signedIn: false, me: null, permission: null, collaborators: [], error: String(e),
    }));
  }, [root]);
  useEffect(() => { refresh(); }, [refresh]);

  const admin = data?.permission === "admin";
  const invite = async () => {
    const name = login.trim().replace(/^@/, "");
    if (!name || busy) return;
    setBusy(true); setErr(null);
    try {
      await githubInvite(root, name, perm);
      setLogin("");
      onNote(`Invited @${name} as ${perm === "admin" ? "an admin" : perm === "read" ? "a reader" : "a writer"}.`);
      refresh();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };
  const remove = async (who: string, invitationId: number | null) => {
    if (busy) return;
    const q = invitationId != null
      ? `Withdraw the invite for @${who}?`
      : `Remove @${who} from ${data?.repo ?? "this repository"}? They will lose access.`;
    if (!window.confirm(q)) return;
    setBusy(true); setErr(null);
    try {
      await githubRemove(root, who, invitationId);
      onNote(invitationId != null ? `Withdrew the invite for @${who}.` : `Removed @${who} from the repository.`);
      refresh();
    } catch (e) { setErr(String(e)); }
    finally { setBusy(false); }
  };

  if (!data) {
    return (
      <div className="field">
        <label>On GitHub</label>
        <span className="target">Looking up collaborators…</span>
      </div>
    );
  }
  if (!data.repo) {
    return (
      <div className="field">
        <label>GitHub</label>
        <span className="target">{data.error ?? "This paper’s origin is not a GitHub repository. Clone from GitHub, or add GitHub as origin, to invite people as collaborators. Live sessions above do not need GitHub."}</span>
      </div>
    );
  }

  const href = `https://github.com/${data.repo}`;
  return (
    <div className="field gh-people">
      <label>On GitHub</label>
      <p className="memory-note">Collaborators on <button type="button" className="link" onClick={() => void openExternal(href)}>{data.repo}</button>. Roles come from GitHub; Dabir has no accounts of its own.</p>
      {data.error && <span className="target">{data.error}{!data.gh ? <> <button type="button" className="link" onClick={() => void openExternal("https://cli.github.com")}>Install gh</button></> : !data.signedIn ? " Run gh auth login in a terminal, then come back." : ""}</span>}
      <div className="peers">
        {data.collaborators.map((c) => (
          <div className={`peer gh${c.pending ? " pending" : ""}`} key={`${c.login}:${c.pending ? "inv" : "col"}`}>
            <img className="avatar" src={`https://github.com/${c.login}.png?size=40`} alt="" width={20} height={20} />
            <span className="name">{c.login}{c.login === data.me ? " (you)" : ""}</span>
            <span className="where">{c.pending ? "invited" : c.role}</span>
            {admin && c.login !== data.me && (
              <button type="button" className="peer-follow" onClick={() => void remove(c.login, c.invitationId)} disabled={busy}>{c.pending ? "Withdraw" : "Remove"}</button>
            )}
          </div>
        ))}
      </div>
      {admin && (
        <div className="comment-box gh-invite">
          <input value={login} onChange={(e) => setLogin(e.target.value)} placeholder="GitHub username" aria-label="GitHub username" autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter") void invite(); }} disabled={busy} />
          <select value={perm} onChange={(e) => setPerm(e.target.value)} aria-label="Role" disabled={busy}>
            <option value="write">Write</option>
            <option value="admin">Admin</option>
            <option value="read">Read</option>
          </select>
          <button type="button" className="btn" onClick={() => void invite()} disabled={busy || !login.trim()}>Invite</button>
        </div>
      )}
      {err && <span className="target" role="alert">{err}</span>}
    </div>
  );
}
