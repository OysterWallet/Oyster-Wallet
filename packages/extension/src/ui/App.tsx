import { useCallback, useEffect, useState } from "react";
import { browser } from "wxt/browser";
import type { AccountView, AppState, ChartRange, ChartView, NetworkId, PriceView, SendArgs, SendQuote, WalletView, WireTx, WrappedView } from "../messages";
import { Callout, type Tab } from "./components";
import { call, RpcError } from "./rpc";
import { CreatePassword, ImportWallet, SeedBackup, SeedConfirm, Welcome } from "./screens/onboarding";
import { Send, SendReview, type SendDraft } from "./screens/send";
import { AddressBook, AUTO_LOCK_OPTIONS, BackupWallet, ChangePassword, RelayServer, ConnectedSites, ExportSeed, Picker, ProtectedCoins, RestoreWallet, Settings, THEMES, themeLabel } from "./screens/settings";
import { Loading, Unlock } from "./screens/unlock";
import { Cash, Token, WrappedPearl } from "./screens/token";
import { Trade, type Side } from "./screens/trade";
import { Activity, Coins, Home, Receive, TxDetail } from "./screens/wallet";
import { AddWallet, WalletEdit, WalletMenu, Wallets } from "./screens/wallets";
import { Mining } from "./screens/mining";

type Route =
  | { name: "boot" }
  | { name: "welcome" }
  | { name: "import"; replace: boolean }
  | { name: "password"; mnemonic?: string; imported: boolean; replace: boolean }
  | { name: "backup"; mnemonic: string; password: string }
  | { name: "confirm"; mnemonic: string; password: string }
  | { name: "unlock"; fresh: boolean }
  | { name: "loading"; deep?: boolean }
  | { name: "home" }
  | { name: "activity" }
  | { name: "settings" }
  | { name: "receive" }
  | { name: "token" }
  | { name: "wrapped" }
  | { name: "cash" }
  | { name: "trade"; side: Side }
  | { name: "send"; draft?: SendDraft }
  | { name: "coins"; draft: SendDraft }
  | { name: "review"; args: SendArgs; quote: SendQuote; draft: SendDraft }
  | { name: "tx"; tx: WireTx; back: "home" | "activity" }
  | { name: "protected" }
  | { name: "export"; walletId?: string; back?: Route }
  | { name: "wallets" }
  | { name: "wallet-add" }
  | { name: "wallet-edit"; id: string }
  | { name: "mining"; back: "home" | "activity" | "settings" }
  | { name: "sites" }
  | { name: "theme" }
  | { name: "autolock" }
  | { name: "password-change"; done?: boolean }
  | { name: "book" }
  | { name: "relay" }
  | { name: "backup-file" }
  | { name: "restore-file" };

export function App() {
  const [route, setRoute] = useState<Route>({ name: "boot" });
  const [state, setState] = useState<AppState>();
  const [view, setView] = useState<WalletView>();
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [justImported, setJustImported] = useState(false);
  const [walletMenu, setWalletMenu] = useState(false);
  const [siteCount, setSiteCount] = useState<number>();
  const [price, setPrice] = useState<PriceView>();
  /**
   * What the relay holds for this wallet.
   *
   * Buying power is part of the portfolio, not a separate thing beside it,
   * so the home screen needs it as much as the cash screen does. It was
   * hardcoded to zero while there was nothing to show; there is now.
   */
  const [account, setAccount] = useState<AccountView | null>();
  const [chart, setChart] = useState<ChartView>();
  const [range, setRange] = useState<ChartRange>("1D");
  const [wrapped, setWrapped] = useState<WrappedView>();

  // Price is optional: without it the wallet shows PRL only. It is also
  // retried, because the first call can land while the service worker is
  // still starting, and one lost call used to leave the whole session
  // without a price.

  /**
   * What the relay holds, on a timer.
   *
   * Money arrives without anybody touching the wallet, so a balance that
   * only updates when you go looking for it is a balance nobody trusts.
   * The first thing anyone does after sending a deposit is open the wallet
   * to see whether it landed.
   */
  useEffect(() => {
    let live = true;
    const load = () =>
      call({ type: "myAccount" }).then(
        (a) => { if (live) setAccount(a); },
        () => { if (live) setAccount(null); },
      );
    void load();
    const timer = setInterval(() => void load(), 20_000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let live = true;
    void (async () => {
      for (const wait of [0, 600, 2000]) {
        if (!live) return;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        try {
          const p = await call({ type: "price" });
          if (!live) return;
          if (p) return setPrice(p);
        } catch { /* worker not up yet, or the relay is down */ }
      }
    })();
    return () => { live = false; };
  }, []);
  useEffect(() => {
    let live = true;
    void (async () => {
      for (const wait of [0, 600, 2000]) {
        if (!live) return;
        if (wait) await new Promise((r) => setTimeout(r, wait));
        try {
          const c = await call({ type: "chart", range });
          if (!live) return;
          if (c) return setChart(c);
        } catch { /* as above */ }
      }
    })();
    return () => { live = false; };
  }, [range]);
  // Wrapped PRL is read from Ethereum through the relay, so it is optional
  // in the same way a price is: a failure leaves the row saying so.
  useEffect(() => {
    if (!view?.wrappedAddress) return setWrapped(undefined);
    call({ type: "wrappedBalance" }).then((w) => setWrapped(w ?? undefined), () => {});
  }, [view?.wrappedAddress]);
  useEffect(() => {
    if (route.name === "settings") call({ type: "listSites" }).then((s) => setSiteCount(s.length), () => {});
  }, [route.name]);

  const go = (r: Route) => {
    setError(undefined);
    setRoute(r);
  };

  /** Auto-lock while a window is open.
   *
   *  The background says so the moment it happens, which covers the normal
   *  case. The poll is the backstop: a message can be missed if this window
   *  was starting up, and a window that sat open through a browser restart
   *  would otherwise show balances from a wallet that is no longer unlocked.
   */
  useEffect(() => {
    const lockNow = () => {
      setView(undefined);
      setWalletMenu(false);
      setRoute((r) => (r.name === "unlock" || r.name === "welcome" ? r : { name: "unlock", fresh: false }));
    };
    const onEvent = (m: unknown) => {
      if (typeof m === "object" && m !== null && (m as { name?: string }).name === "locked") lockNow();
    };
    browser.runtime.onMessage.addListener(onEvent);
    // lockState, not state: reading the vault would count as activity and
    // this timer would hold the wallet open for as long as the window is.
    const timer = setInterval(() => {
      call({ type: "lockState" }).then((s) => {
        if (s?.hasVault && !s.unlocked) lockNow();
      }, () => {});
    }, 15_000);
    return () => {
      browser.runtime.onMessage.removeListener(onEvent);
      clearInterval(timer);
    };
  }, []);

  /** Any "locked" error means the auto-lock fired while the popup was open. */
  const handleError = useCallback((e: unknown) => {
    const err = e as RpcError;
    if (err.code === "locked") {
      setView(undefined);
      setRoute({ name: "unlock", fresh: false });
      return;
    }
    setError(err.message ?? String(e));
  }, []);

  const loadView = useCallback(async (refresh = false) => {
    setRefreshing(true);
    try {
      setView(await call({ type: "walletView", refresh }));
      // A scan updates the wallet list's cached balance and address too.
      setState(await call({ type: "state" }));
      setError(undefined);
    } catch (e) {
      handleError(e);
    } finally {
      setRefreshing(false);
    }
  }, [handleError]);

  useEffect(() => {
    call({ type: "state" }).then((s) => {
      if (!s) return setError("The wallet background did not answer. Try reopening the popup.");
      setState(s);
      if (!s.hasVault) setRoute({ name: "welcome" });
      else if (!s.unlocked) setRoute({ name: "unlock", fresh: false });
      else {
        setRoute({ name: "home" });
        void loadView();
      }
    }, (e: RpcError) => setError(e.message));
  }, [loadView]);

  /**
   * The balance, rescanned every two minutes while the wallet screen is up.
   *
   * Quietly: a timer is not somebody using the wallet, so this does not hold
   * off auto-lock. If the wallet has locked meanwhile, the "locked" answer
   * takes the screen to unlock like any other call would.
   */
  useEffect(() => {
    if (route.name !== "home") return;
    const timer = setInterval(() => {
      call({ type: "walletView", background: true }).then(
        (v) => setView(v),
        (e) => { if ((e as RpcError).code === "locked") handleError(e); },
      );
    }, 120_000);
    return () => clearInterval(timer);
  }, [route.name, handleError]);

  const onTab = (t: Tab) => {
    if (t === "wallet") go({ name: "home" });
    else if (t === "trade") go({ name: "trade", side: "buy" });
    else if (t === "activity") go({ name: "activity" });
    else if (t === "settings") go({ name: "settings" });
  };

  const createVault = async (password: string, mnemonic: string, imported: boolean, replace: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      setState(await call({ type: "createVault", password, mnemonic, imported, replace }));
      setJustImported(imported);
      go({ name: "unlock", fresh: true });
    } catch (e) {
      handleError(e);
    } finally {
      setBusy(false);
    }
  };

  const unlock = async (password: string) => {
    setBusy(true);
    setError(undefined);
    try {
      setState(await call({ type: "unlock", password }));
      go({ name: "loading", deep: justImported });
      setView(await call({ type: "walletView" }));
      setJustImported(false);
      go({ name: "home" });
    } catch (e) {
      const err = e as RpcError;
      if (route.name === "loading" || err.code !== "wrong-password") {
        // Unlocked but the network scan failed: open the wallet anyway.
        go({ name: "home" });
        setError(err.message);
      } else {
        setError(err.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const lock = async () => {
    setState(await call({ type: "lock" }));
    setView(undefined);
    go({ name: "unlock", fresh: false });
  };

  const setNetwork = async (network: NetworkId) => {
    setState(await call({ type: "setNetwork", network }));
    setView(undefined);
    void loadView();
  };

  // An explicit theme overrides the system preference (see theme.css).
  useEffect(() => {
    const t = state?.theme ?? "system";
    if (t === "system") delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
  }, [state?.theme]);

  // A chart fetch can take a moment. Until the new range arrives, show no
  // chart rather than the old range's data under the new range's label.
  const forRange = chart && chart.range === range ? chart : undefined;

  const network = state?.network ?? "mainnet";
  const walletName = state?.wallets.find((w) => w.id === state.activeWalletId)?.name ?? "Main wallet";

  switch (route.name) {
    case "boot":
      return error ? <div className="screen"><div className="body"><Callout kind="danger">{error}</Callout></div></div> : <Loading label="Starting" />;

    case "welcome":
      return (
        <Welcome network={network}
          onCreate={() => go({ name: "password", imported: false, replace: false })}
          onImport={() => go({ name: "import", replace: false })} />
      );

    case "import":
      return (
        <div className="screen" style={{ position: "relative" }}>
          <ImportWallet network={network}
            onBack={() => go(route.replace ? { name: "unlock", fresh: false } : { name: "welcome" })}
            onContinue={(mnemonic) => go({ name: "password", mnemonic, imported: true, replace: route.replace })} />
          {route.replace && (
            <div style={{ position: "absolute", left: 20, right: 20, bottom: 78 }}>
              <Callout kind="warn">This replaces the wallet on this device. Only continue if you have its seed phrase.</Callout>
            </div>
          )}
        </div>
      );

    case "password":
      return (
        <CreatePassword imported={route.imported} busy={busy} error={error}
          onBack={() => go(route.imported ? { name: "import", replace: route.replace } : { name: "welcome" })}
          onContinue={async (password) => {
            if (route.imported) {
              await createVault(password, route.mnemonic!, true, route.replace);
            } else {
              const { mnemonic } = await call({ type: "generateMnemonic" });
              go({ name: "backup", mnemonic, password });
            }
          }} />
      );

    case "backup":
      return (
        <SeedBackup mnemonic={route.mnemonic}
          onBack={() => go({ name: "password", imported: false, replace: false })}
          onDone={() => go({ name: "confirm", mnemonic: route.mnemonic, password: route.password })} />
      );

    case "confirm":
      return (
        <SeedConfirm mnemonic={route.mnemonic} busy={busy} error={error}
          onBack={() => go({ name: "backup", mnemonic: route.mnemonic, password: route.password })}
          onConfirmed={() => createVault(route.password, route.mnemonic, false, false)} />
      );

    case "unlock":
      return (
        <Unlock fresh={route.fresh} busy={busy} error={error} autoLockMinutes={state?.autoLockMinutes} onUnlock={unlock}
          onForgot={() => go({ name: "import", replace: true })} />
      );

    case "loading":
      return <Loading label={route.deep ? "Finding your addresses. The first scan of an imported wallet takes a minute." : undefined} />;

    case "home":
      return (
        <div style={{ position: "relative" }}>
          <Home view={view} network={network} walletName={walletName} error={error} refreshing={refreshing}
            cashUsdt={account ? Number(BigInt(account.usdt)) / 1e6 : 0}
            keptPrl={account ? BigInt(account.kept) : 0n}
            {...(account?.incoming ? { incoming: account.incoming } : {})}
            {...(account?.selling ? { selling: account.selling } : {})}
            {...(account?.withdrawing ? { withdrawing: account.withdrawing } : {})}
            onTab={onTab} onLock={lock} onRefresh={() => loadView(true)}
            onSend={() => go({ name: "send" })} onReceive={() => go({ name: "receive" })}
            onWalletMenu={() => setWalletMenu(true)} onToken={() => go({ name: "token" })}
            onBuy={() => go({ name: "trade", side: "buy" })} onSell={() => go({ name: "trade", side: "sell" })} onWrapped={() => go({ name: "wrapped" })} onCash={() => go({ name: "cash" })}
            onMining={() => go({ name: "mining", back: "home" })}
            price={price} chart={forRange} range={range} onRange={setRange} wrapped={wrapped} />
          {walletMenu && state && (
            <WalletMenu wallets={state.wallets} activeId={state.activeWalletId} onClose={() => setWalletMenu(false)}
              onManage={() => { setWalletMenu(false); go({ name: "wallets" }); }}
              onPick={async (id) => {
                setWalletMenu(false);
                if (id === state.activeWalletId) return;
                setState(await call({ type: "switchWallet", id }));
                setView(undefined);
                void loadView();
              }} />
          )}
        </div>
      );

    case "activity":
      return (
        <Activity view={view} price={price} {...(account?.incoming ? { incoming: account.incoming } : {})}
          onTab={onTab} onOpenTx={(tx) => go({ name: "tx", tx, back: "activity" })}
          onMining={() => go({ name: "mining", back: "activity" })}
          loadingMore={refreshing}
          onLoadMore={async () => {
            setRefreshing(true);
            try {
              setView(await call({ type: "loadMoreHistory" }));
            } catch (e) {
              handleError(e);
            } finally {
              setRefreshing(false);
            }
          }} />
      );

    case "settings":
      return (
        <Settings network={network} protectedCount={view?.protectedCount} onTab={onTab} onNetwork={setNetwork}
          walletCount={state?.wallets.length ?? 1} onWallets={() => go({ name: "wallets" })}
          minerMode={state?.wallets.find((w) => w.id === state.activeWalletId)?.miner ?? false}
          onMining={() => go({ name: "mining", back: "settings" })}
          siteCount={siteCount} onSites={() => go({ name: "sites" })}
          autoLockMinutes={state?.autoLockMinutes ?? 15} theme={state?.theme ?? "system"}
          onProtected={() => go({ name: "protected" })} onExport={() => go({ name: "export" })} onLock={lock}
          onTheme={() => go({ name: "theme" })} onAutoLock={() => go({ name: "autolock" })}
          onChangePassword={() => go({ name: "password-change" })}
          uiMode={state?.uiMode ?? "popup"} sidePanelSupported={state?.sidePanelSupported === true}
          canExportSeed={view ? !view.watchOnly : true}
          onBackup={() => go({ name: "backup-file" })} onRestore={() => go({ name: "restore-file" })}
          onBook={() => go({ name: "book" })}
          relayLabel={(state?.relayUrl ?? "").replace(/^https?:\/\//, "").replace(/:\d+$/, "").slice(0, 18)}
          onRelay={() => go({ name: "relay" })}
          onUiMode={async (mode) => setState(await call({ type: "setUiMode", mode }))} />
      );

    case "token":
      return (
        <Token view={view} network={network} price={price} chart={forRange} range={range} onRange={setRange}
          onBack={() => go({ name: "home" })} onSend={() => go({ name: "send" })} onReceive={() => go({ name: "receive" })}
          onOpenTx={(tx) => go({ name: "tx", tx, back: "home" })} onSeeAll={() => onTab("activity")} />
      );

    case "trade":
      return (
        <Trade side={route.side} onSide={(side) => go({ name: "trade", side })} price={price} view={view}
          cashUsdt={account ? Number(BigInt(account.usdt)) / 1e6 : 0} onTab={onTab} onCash={() => go({ name: "cash" })} />
      );

    case "cash":
      return (
        <Cash onBack={() => go({ name: "home" })} cashAddresses={state?.cashAddresses ?? {}}
          onCashAddress={async (chain, address) => { setState(await call({ type: "setCashAddress", chain, address })); }} />
      );

    case "wrapped":
      return (
        <WrappedPearl {...(view?.wrappedAddress ? { address: view.wrappedAddress } : {})} {...(wrapped ? { wrapped } : {})} price={price}
          inTotal={view?.wrappedInTotal === true}
          onInTotal={async (include) => {
            await call({ type: "setWrappedInTotal", include });
            setView((v) => (v ? { ...v, wrappedInTotal: include } : v));
          }}
          onBack={() => go({ name: "home" })}
          onSave={async (address) => {
            const r = await call({ type: "setWrappedAddress", address });
            setView((v) => (v ? { ...v, ...(r.address ? { wrappedAddress: r.address } : {}) } : v));
          }}
          onForget={async () => {
            await call({ type: "setWrappedAddress", address: null });
            setView((v) => {
              if (!v) return v;
              const { wrappedAddress: _gone, ...rest } = v;
              setWrapped(undefined);
              return rest;
            });
          }} />
      );

    case "receive":
      return (
        <Receive address={view?.receiveAddress} network={network} walletName={walletName} onBack={() => go({ name: "home" })} />
      );

    case "send":
      return (
        <Send view={view} network={network} price={price} {...(route.draft ? { draft: route.draft } : {})} onBack={() => go({ name: "home" })}
          onReview={(args, quote, draft) => go({ name: "review", args, quote, draft })}
          onPickCoins={(draft) => go({ name: "coins", draft })} />
      );

    case "coins":
      return (
        <Coins selected={route.draft.only ?? []} onBack={() => go({ name: "send", draft: route.draft })}
          onDone={(only) => go({ name: "send", draft: { ...route.draft, only } })} />
      );

    case "review":
      return (
        <SendReview quote={route.quote} args={route.args} walletName={walletName} price={price}
          onBack={() => go({ name: "send", draft: route.draft })}
          onSent={(txid, quote) => {
            const tx: WireTx = {
              txid, time: 0, confirmations: 0, direction: "sent", coinbase: false,
              net: (-BigInt(quote.total)).toString(), fee: quote.fee, counterparty: quote.to,
            };
            void loadView(true);
            go({ name: "tx", tx, back: "home" });
          }} />
      );

    case "tx":
      return <TxDetail tx={route.tx} network={network} onDone={() => go({ name: route.back })} />;

    case "relay":
      return (
        <RelayServer current={state?.relayUrl ?? ""} hasOperatorKey={state?.hasOperatorKey === true}
          onOperatorKey={async (secret) => { setState(await call({ type: "setOperatorKey", secret })); }} onBack={() => go({ name: "settings" })}
          onSaved={async (relay) => {
            setState(await call({ type: "setRelayUrl", url: relay }));
            setPrice(undefined);
            setChart(undefined);
          }} />
      );

    case "book":
      return <AddressBook onBack={() => go({ name: "settings" })} />;

    case "backup-file":
      return <BackupWallet onBack={() => go({ name: "settings" })} />;

    case "restore-file":
      return (
        <RestoreWallet onBack={() => go({ name: "settings" })}
          onRestored={async () => {
            setView(undefined);
            setState(await call({ type: "state" }));
            go({ name: "unlock", fresh: false });
          }} />
      );

    case "protected":
      return <ProtectedCoins onBack={() => { void loadView(); go({ name: "settings" }); }} />;

    case "export":
      return <ExportSeed walletId={route.walletId} onBack={() => go(route.back ?? { name: "settings" })} />;

    case "mining":
      return (
        <Mining walletName={walletName} price={price}
          onBack={async () => { setState(await call({ type: "state" })); go({ name: route.back }); }}
          onOpenPayout={(txid) => {
            const tx = view?.txs.find((t) => t.txid === txid);
            if (tx) go({ name: "tx", tx, back: "activity" });
          }} />
      );

    case "sites":
      return <ConnectedSites onBack={() => go({ name: "settings" })} />;

    case "wallets":
      return (
        <Wallets wallets={state?.wallets ?? []} activeId={state?.activeWalletId} onBack={() => go({ name: "settings" })}
          onEdit={(id) => go({ name: "wallet-edit", id })} onAdd={() => go({ name: "wallet-add" })} />
      );

    case "wallet-add":
      return (
        <AddWallet network={network} onBack={() => go({ name: "wallets" })}
          onAdded={async () => {
            setState(await call({ type: "state" }));
            setView(undefined);
            void loadView();
            go({ name: "home" });
          }} />
      );

    case "wallet-edit":
      return (
        <WalletEdit id={route.id}
          onBack={async () => { setState(await call({ type: "state" })); go({ name: "wallets" }); }}
          onExport={(walletId) => go({ name: "export", walletId, back: { name: "wallet-edit", id: route.id } })}
          onRemoved={async () => {
            setState(await call({ type: "state" }));
            setView(undefined);
            void loadView();
            go({ name: "wallets" });
          }} />
      );

    case "theme":
      return (
        <Picker title="Appearance" options={THEMES} value={state?.theme ?? "system"} label={themeLabel}
          note="System follows your computer's light or dark setting."
          onBack={() => go({ name: "settings" })}
          onPick={async (theme) => setState(await call({ type: "setTheme", theme }))} />
      );

    case "autolock":
      return (
        <Picker title="Auto-lock" options={AUTO_LOCK_OPTIONS} value={(state?.autoLockMinutes ?? 15) as (typeof AUTO_LOCK_OPTIONS)[number]}
          label={(m) => (m === 60 ? "1 hour" : `${m} minute${m === 1 ? "" : "s"}`)}
          note="Oyster locks itself after this long without use. Shorter is safer on a shared computer."
          onBack={() => go({ name: "settings" })}
          onPick={async (minutes) => setState(await call({ type: "setAutoLock", minutes }))} />
      );

    case "password-change":
      return <ChangePassword onBack={() => go({ name: "settings" })} onDone={() => go({ name: "settings" })} />;
  }
}
