import { useEffect, useState } from "react";
import type { ApprovalRequest, SendQuote } from "../../messages";
import { Button, Callout, Icon, ICONS } from "../components";
import { prlExact, prlReview, shortAddr, shortTxid } from "../format";
import { call, RpcError } from "../rpc";
import { Loading, Unlock } from "./unlock";

/**
 * The approval window a website's request opens. The site is identified by
 * the origin Chrome reported to the background, shown in full so a lookalike
 * domain is visible. Nothing here signs: approving asks the background to do
 * the work, so this page never holds a key.
 */
export function ApproveApp() {
  const id = new URLSearchParams(location.search).get("id") ?? "";
  const [req, setReq] = useState<ApprovalRequest>();
  const [locked, setLocked] = useState<boolean>();
  const [unlockError, setUnlockError] = useState<string>();
  const [autoLockMinutes, setAutoLockMinutes] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    (async () => {
      try {
        setReq(await call({ type: "approvalGet", id }));
        const state = await call({ type: "state" });
        setLocked(!state.unlocked);
        setAutoLockMinutes(state.autoLockMinutes);
      } catch (e) {
        setError((e as RpcError).message);
      }
    })();
  }, [id]);

  const answer = async (approved: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      await call({ type: "approvalResolve", id, approved });
      window.close();
    } catch (e) {
      setError((e as RpcError).message);
      setBusy(false);
    }
  };

  if (error && !req) {
    return (
      <div className="screen"><div className="body">
        <Callout kind="danger">{error}</Callout>
        <div className="spacer" />
        <Button variant="secondary" onClick={() => window.close()}>Close</Button>
      </div></div>
    );
  }
  if (!req || locked === undefined) return <Loading label="Loading request" />;
  if (locked) {
    return (
      <Unlock busy={busy} error={unlockError} autoLockMinutes={autoLockMinutes} onUnlock={async (password) => {
        setBusy(true);
        setUnlockError(undefined);
        try {
          await call({ type: "unlock", password });
          setLocked(false);
        } catch (e) {
          setUnlockError((e as RpcError).message);
        } finally {
          setBusy(false);
        }
      }} />
    );
  }

  const footer = (label: string) => (
    <div className="row-2">
      <Button variant="secondary" disabled={busy} onClick={() => answer(false)}>Reject</Button>
      <Button disabled={busy || (req.kind === "send" && !!error)} onClick={() => answer(true)}>{busy ? "Working…" : label}</Button>
    </div>
  );

  return (
    <div className="screen">
      <div className="body" style={{ gap: 13, padding: "24px 20px 20px" }}>
        {req.kind === "connect" && <ConnectBody origin={req.origin} />}
        {req.kind === "send" && <SendBody req={req} id={id} onError={setError} />}
        {req.kind === "signMessage" && <MessageBody origin={req.origin} message={req.message} />}
        {req.kind === "pushTx" && <PushBody req={req} />}
        {error && <Callout kind="danger">{error}</Callout>}
        <div className="spacer" />
        {footer(req.kind === "connect" ? "Connect" : req.kind === "send" ? "Approve" : req.kind === "pushTx" ? "Broadcast" : "Sign")}
      </div>
    </div>
  );
}

function Origin({ origin }: { origin: string }) {
  const insecure = origin.startsWith("http://") && !origin.startsWith("http://localhost");
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 12px", border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)" }}>
        <span style={{ display: "flex", color: "var(--text-2)" }}><Icon d={ICONS.globe} /></span>
        <span className="mono" style={{ fontSize: 12.5, wordBreak: "break-all" }}>{origin}</span>
      </div>
      {insecure && <Callout kind="warn">This site does not use HTTPS. Anyone on your network could tamper with it.</Callout>}
    </>
  );
}

function ConnectBody({ origin }: { origin: string }) {
  const [acct, setAcct] = useState<{ address: string; walletName: string }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    call({ type: "siteAccount" }).then(setAcct, (e: RpcError) => setError(e.message));
  }, []);
  const perm = (on: boolean, text: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, minHeight: 34, fontSize: 13.5, color: on ? "var(--text)" : "var(--text-3)" }}>
      <span style={{ display: "flex", color: on ? "var(--accent)" : "var(--text-3)" }}><Icon d={on ? ICONS.check : ICONS.minus} size={17} /></span>
      <span>{text}</span>
    </div>
  );
  return (
    <>
      <span className="eyebrow">Connection request</span>
      <h1 className="title">Connect to this site?</h1>
      <Origin origin={origin} />
      <div className="card" style={{ padding: "6px 12px" }}>
        {perm(true, "See your address and balance")}
        {perm(true, "Ask you to approve transactions")}
        {perm(false, "Move funds without your approval")}
      </div>
      {error ? (
        <Callout kind="danger">{error}</Callout>
      ) : (
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", minHeight: 44, padding: "0 12px", borderRadius: 10, background: "var(--surface-2)" }}>
          <span className="muted" style={{ fontSize: 13 }}>Account</span>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
            {acct?.walletName ?? "…"}
            <span className="mono muted" style={{ fontWeight: 400 }}>{acct ? shortAddr(acct.address, 9, 5) : ""}</span>
          </span>
        </div>
      )}
    </>
  );
}

function SendBody({ req, id, onError }: { req: Extract<ApprovalRequest, { kind: "send" }>; id: string; onError: (m: string) => void }) {
  const [q, setQ] = useState<SendQuote & { inputs: number; outputs: number }>();
  useEffect(() => {
    call({ type: "approvalQuote", id }).then(setQ, (e: RpcError) => onError(e.message));
  }, [id]);
  return (
    <>
      <span className="eyebrow">Signature request</span>
      <h1 className="title">Approve this transaction?</h1>
      <Origin origin={req.origin} />
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2, padding: "4px 0" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ fontFamily: "var(--serif)", fontSize: 34, lineHeight: 1.05, letterSpacing: "-0.02em" }}>{prlReview(req.amount)}</span>
          <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-2)" }}>PRL</span>
        </div>
        <span className="muted" style={{ fontSize: 12.5 }}>leaves your wallet, plus the network fee</span>
      </div>
      <div className="kv">
        <div style={{ flexDirection: "column", alignItems: "stretch", gap: 4 }}>
          <span className="k">To</span>
          {/* In full. A site can ask for any address, so the user has to be
              able to read every character of it. */}
          <span className="v mono" style={{ textAlign: "left", lineHeight: 1.6, wordBreak: "break-all", userSelect: "all" }}>{req.to}</span>
        </div>
        <div><span className="k">Network fee</span><span className="v">{q ? `${prlExact(q.fee)} PRL` : "…"}</span></div>
        <div><span className="k">Total</span><span className="v">{q ? `${prlExact(q.total)} PRL` : "…"}</span></div>
        <div><span className="k">Inputs and outputs</span><span className="v">{q ? `${q.inputs} in · ${q.outputs} out` : "…"}</span></div>
      </div>
      {q && (
        <Callout kind="info" icon={ICONS.shield}>
          Built by Oyster, not the site. No protected coins are spent
          {q.excluded.frozen > 0 ? ` (${q.excluded.frozen} left out)` : ""}.
        </Callout>
      )}
    </>
  );
}

/** A transaction the site built itself. Oyster did not choose the inputs or
 *  the outputs here, so the screen shows what it decoded and says so. */
function PushBody({ req }: { req: Extract<ApprovalRequest, { kind: "pushTx" }> }) {
  const { tx } = req;
  return (
    <>
      <span className="eyebrow">Broadcast request</span>
      <h1 className="title">Send this transaction to the network?</h1>
      <Origin origin={req.origin} />
      <Callout kind="warn">
        This was built by the site, not by Oyster. Check every output: once it is broadcast it cannot be taken back.
      </Callout>
      <div style={{ display: "flex", flexDirection: "column" }}>
        <span className="eyebrow">Pays out</span>
        {tx.outputs.map((o, i) => (
          <div key={i} className="list-row" style={{ padding: "8px 0", cursor: "default", alignItems: "flex-start" }}>
            <span className="main">
              <span className="t">
                {o.address ? (o.mine ? "To this wallet" : "To another address") : "Data, no address"}
                {o.mine && <span className="chip info">yours</span>}
              </span>
              <span className="s mono" style={{ whiteSpace: "normal", wordBreak: "break-all", lineHeight: 1.5 }}>
                {o.address ?? "not an address"}
              </span>
            </span>
            <span className="mono" style={{ fontSize: 13 }}>{prlExact(o.value)}</span>
          </div>
        ))}
      </div>
      <div className="kv">
        <div><span className="k">Total out</span><span className="v">{prlExact(tx.total)} PRL</span></div>
        <div><span className="k">Inputs</span><span className="v">{tx.inputs}</span></div>
        <div><span className="k">Size</span><span className="v">{tx.vsize} vB</span></div>
        <div><span className="k">Tx ID</span><span className="v">{shortTxid(tx.txid)}</span></div>
      </div>
    </>
  );
}

function MessageBody({ origin, message }: { origin: string; message: string }) {
  return (
    <>
      <span className="eyebrow">Signature request</span>
      <h1 className="title">Sign this message?</h1>
      <Origin origin={origin} />
      <div className="mono" style={{ maxHeight: 180, overflowY: "auto", padding: 12, border: "1px solid var(--border)", borderRadius: 10, background: "var(--surface)", fontSize: 12.5, lineHeight: 1.55, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
        {message}
      </div>
      <Callout kind="info" icon={ICONS.shield}>
        Signing proves you control this wallet. It cannot move funds. Only sign messages from sites you trust.
      </Callout>
    </>
  );
}
