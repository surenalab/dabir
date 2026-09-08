import { useEffect, useState } from "react";
import { Copy, Radio, Square, Upload, Download, Link2, BookMarked } from "lucide-react";
import { parseShareLink, shareLink, userName, setUserName, type Transport } from "../lib/collab";

export type LiveState = { url: string; lanUrl: string; room: string; host: boolean; transport: Transport; password?: string } | null;

interface Props {
  projectName: string;
  live: LiveState;
  overleafUrl: string | null;
  busy: string | null;
  onClose: () => void;
  onStart: (name: string, transport: Transport) => Promise<void>;
  onJoin: (name: string, url: string, room: string, transport: Transport, password?: string) => Promise<void>;
  signalingUrl: string;
  direct: { invite: () => Promise<string>; accept: (answer: string) => Promise<void>; answer: (name: string, invite: string) => Promise<string>; peers: number } | null;
  onStop: () => Promise<void>;
  onSetOverleaf: (url: string) => Promise<void>;
  onPull: () => Promise<void>;
  onPush: () => Promise<void>;
  onZotero: () => Promise<void>;
  onBibFile: () => Promise<void>;
}

export function ShareSheet(p: Props) {
  const [name, setName] = useState(userName());
  const [link, setLink] = useState("");
  const [overleaf, setOverleaf] = useState(p.overleafUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [transport, setTransport] = useState<Transport>("direct");
  const [invite, setInvite] = useState("");
  const [answerIn, setAnswerIn] = useState("");
  const [guestInvite, setGuestInvite] = useState("");
  const [guestAnswer, setGuestAnswer] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") p.onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [p]);

  const need = () => { if (!name.trim()) { setError("Enter the name coauthors will see."); return false; } setUserName(name.trim()); setError(null); return true; };
  const start = async () => { if (!need()) return; try { await p.onStart(name.trim(), transport); } catch (e) { setError(String(e)); } };
  const join = async () => {
    if (!need()) return;
    const parsed = parseShareLink(link);
    if (!parsed) { setError("Paste a dabir:// link or a ws:// address with the room."); return; }
    try { await p.onJoin(name.trim(), parsed.url, parsed.room, parsed.transport, parsed.password); } catch (e) { setError(String(e)); }
  };
  const copy = async (text: string) => { try { await navigator.clipboard.writeText(text); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setError("Could not copy. Select the link and copy it by hand."); } };
  const wrap = (f: () => Promise<void>) => async () => { try { setError(null); await f(); } catch (e) { setError(String(e)); } };

  return (
    <div className="sheet-backdrop" onClick={p.onClose}>
      <div className="sheet wide" role="dialog" aria-modal="true" aria-labelledby="share-title" onClick={(e) => e.stopPropagation()}>
        <h2 id="share-title">Share {p.projectName}</h2>

        <section className="share-section">
          <h3><Radio aria-hidden /> Live session</h3>
          {!p.live ? (
            <>
              <p className="memory-note">Edit together in real time. The host's checkout stays the source of truth; nothing is stored anywhere else, and no server of yours is needed.</p>
              <label className="share-label">Your name<input className="sheet-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Shown next to your cursor" /></label>
              <div className="share-radio" role="radiogroup" aria-label="How to connect">
                <label><input type="radio" name="transport" checked={transport === "direct"} onChange={() => setTransport("direct")} /> Direct, no server</label>
                <label><input type="radio" name="transport" checked={transport === "relay"} onChange={() => setTransport("relay")} /> Same network</label>
                <label><input type="radio" name="transport" checked={transport === "p2p"} onChange={() => setTransport("p2p")} disabled={!p.signalingUrl} title={p.signalingUrl ? "" : "Set a signalling server in Settings first"} /> Signalling server</label>
              </div>
              <p className="target">{transport === "direct" ? "Machines connect straight to each other over WebRTC. You swap two short codes with each coauthor once; after that the text goes directly between you, encrypted. Nothing is hosted anywhere." : transport === "relay" ? "Dabir hosts a small relay on this machine; coauthors on the same Wi-Fi or VPN (Tailscale is free and stretches this across the internet) paste the link." : "Peers meet through the signalling server in Settings; the text goes peer to peer. relay/signaling-worker.js deploys one to Cloudflare's free tier."}</p>
              <div className="actions">
                <button className="btn primary" onClick={start} disabled={!!p.busy}>{p.busy === "start" ? "Starting…" : "Start a Session"}</button>
              </div>
              {transport !== "direct" ? (
                <>
                  <label className="share-label">Or join one<input className="sheet-input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="dabir://join?relay=…&room=…" onKeyDown={(e) => { if (e.key === "Enter") join(); }} /></label>
                  <div className="actions"><button className="btn" onClick={join} disabled={!link.trim() || !!p.busy}>{p.busy === "join" ? "Joining…" : "Join"}</button></div>
                </>
              ) : (
                <>
                  <label className="share-label">Or join with an invite code<textarea className="sheet-input code" value={guestInvite} onChange={(e) => setGuestInvite(e.target.value)} placeholder="Paste the host's invite code" rows={3} /></label>
                  <div className="actions"><button className="btn" onClick={async () => { if (!need() || !p.direct) return; try { setGuestAnswer(await p.direct.answer(name.trim(), guestInvite.trim())); } catch (e) { setError(String(e)); } }} disabled={!guestInvite.trim() || !!p.busy}>Make Answer Code</button></div>
                  {guestAnswer && (
                    <>
                      <p className="target">Send this answer code back to the host. The session connects when they paste it.</p>
                      <div className="share-link"><code>{guestAnswer}</code><button className="btn" onClick={() => copy(guestAnswer)}><Copy /> {copied ? "Copied" : "Copy"}</button></div>
                    </>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              <p className="memory-note">{p.live.host ? "You are hosting" : "You joined"} {p.live.transport === "direct" ? "a direct session" : p.live.transport === "p2p" ? "a peer-to-peer session" : "a session on this network"}{p.live.transport === "direct" && p.direct ? <>, {p.direct.peers} connected</> : null}.</p>
              {p.live.transport === "direct" && p.live.host && p.direct && (
                <>
                  <div className="actions"><button className="btn primary" onClick={wrap(async () => setInvite(await p.direct!.invite()))} disabled={!!p.busy}>New Invite Code</button></div>
                  {invite && (
                    <>
                      <p className="target">Send this to one coauthor. Each coauthor needs their own invite.</p>
                      <div className="share-link"><code>{invite}</code><button className="btn" onClick={() => copy(invite)}><Copy /> {copied ? "Copied" : "Copy"}</button></div>
                    </>
                  )}
                  <label className="share-label">Paste their answer code<textarea className="sheet-input code" value={answerIn} onChange={(e) => setAnswerIn(e.target.value)} rows={3} placeholder="Answer code from the coauthor" /></label>
                  <div className="actions"><button className="btn" onClick={wrap(async () => { await p.direct!.accept(answerIn.trim()); setAnswerIn(""); setInvite(""); })} disabled={!answerIn.trim()}>Connect</button></div>
                </>
              )}
              {p.live.transport === "direct" && !p.live.host && guestAnswer && (
                <>
                  <p className="target">Send this answer code back to the host. The session connects when they paste it.</p>
                  <div className="share-link"><code>{guestAnswer}</code><button className="btn" onClick={() => copy(guestAnswer)}><Copy /> {copied ? "Copied" : "Copy"}</button></div>
                </>
              )}
              {p.live.transport !== "direct" && <div className="share-link">
                <code>{shareLink(p.live.host && p.live.transport === "relay" ? p.live.lanUrl : p.live.url, p.live.room, p.live.transport, p.live.password)}</code>
                <button className="btn" onClick={() => copy(shareLink(p.live!.host && p.live!.transport === "relay" ? p.live!.lanUrl : p.live!.url, p.live!.room, p.live!.transport, p.live!.password))}><Copy /> {copied ? "Copied" : "Copy Link"}</button>
              </div>}
              {p.live.transport !== "direct" && <p className="target">{p.live.transport === "p2p" ? "Send the link to coauthors; it contains the room key. Anyone with the link can join while the session is open." : "Coauthors on the same network paste the link into File › Share. For people elsewhere, use Tailscale or the direct mode, or run the standalone relay on a server you control (node relay/dist/relay.cjs)."}</p>}
              <div className="actions"><button className="btn danger" onClick={wrap(p.onStop)} disabled={!!p.busy}><Square /> {p.live.host ? "End Session" : "Leave Session"}</button></div>
            </>
          )}
        </section>

        <section className="share-section">
          <h3><Link2 aria-hidden /> Overleaf</h3>
          <p className="memory-note">Overleaf projects expose a Git remote (Menu › Git in Overleaf, premium on their side). Add it here to pull coauthors' edits and push yours.</p>
          <label className="share-label">Overleaf Git URL<input className="sheet-input" value={overleaf} onChange={(e) => setOverleaf(e.target.value)} placeholder="https://git.overleaf.com/1234567890abcdef" /></label>
          <div className="actions">
            <button className="btn" onClick={wrap(() => p.onSetOverleaf(overleaf.trim()))} disabled={!overleaf.trim() || overleaf.trim() === p.overleafUrl || !!p.busy}>Save Remote</button>
            <button className="btn" onClick={wrap(p.onPull)} disabled={!p.overleafUrl || !!p.busy}><Download /> {p.busy === "pull" ? "Pulling…" : "Pull from Overleaf"}</button>
            <button className="btn" onClick={wrap(p.onPush)} disabled={!p.overleafUrl || !!p.busy}><Upload /> {p.busy === "push" ? "Pushing…" : "Push to Overleaf"}</button>
          </div>
        </section>

        <section className="share-section">
          <h3><BookMarked aria-hidden /> References</h3>
          <p className="memory-note">Merge entries into the paper's <code>.bib</code> without duplicates: from Zotero 7 running on this Mac (its local API), or from any BibTeX file.</p>
          <div className="actions">
            <button className="btn" onClick={wrap(p.onZotero)} disabled={!!p.busy}>{p.busy === "zotero" ? "Importing…" : "Import from Zotero"}</button>
            <button className="btn" onClick={wrap(p.onBibFile)} disabled={!!p.busy}>Import .bib File…</button>
          </div>
        </section>

        {error && <p className="composer-note" role="alert">{error}</p>}
        <footer><button className="btn" onClick={p.onClose}>Done</button></footer>
      </div>
    </div>
  );
}
