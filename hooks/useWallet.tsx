"use client";

/**
 * Wallet context: connection state, the active network, and a `sign` function
 * bound to the connected account. The app's network follows Freighter while
 * connected (so reads and writes always agree), and is user-selectable while
 * disconnected for read-only browsing.
 */

import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  connect as fConnect,
  getConnectedAddress,
  getWalletNetwork,
  isFreighterInstalled,
  signTx,
  watchWallet,
} from "@/lib/freighter";
import { DEFAULT_NETWORK, networkPassphrase } from "@/lib/stellar";
import type { WriteCtx } from "@/lib/contracts";
import type { Network } from "@/types";

interface WalletContextValue {
  address: string | null;
  network: Network;
  walletNetwork: Network | null;
  /**
   * True when connected but the wallet's actual network couldn't be
   * determined (`getWalletNetwork` returned null). `network` may then be
   * stale, so writes are blocked until this clears.
   */
  networkUnknown: boolean;
  installed: boolean;
  connecting: boolean;
  error: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  setNetwork: (n: Network) => void;
  sign: (xdr: string) => Promise<string>;
  /** Build a write context for contract calls; throws if not connected. */
  writeCtx: (onPhase?: WriteCtx["onPhase"]) => WriteCtx;
}

const WalletContext = createContext<WalletContextValue | null>(null);

const STORAGE_KEY = "rwa.wallet.connected";

/**
 * `localStorage` access can throw a `SecurityError` rather than return null:
 * private-browsing modes, browsers configured to block site data and sandboxed
 * iframes all deny the access. Because the flag is only a convenience (it tells
 * us whether to probe the wallet on mount), a blocked storage must never break
 * connecting — it just means the session cannot be restored next time.
 *
 * Every read returns `null` on failure and every write is a no-op.
 */
const safeStorage = {
  get(key: string): string | null {
    try {
      if (typeof window === "undefined") return null;
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(key, value);
    } catch {
      // Storage is unavailable or full — the flag is best-effort.
    }
  },
  remove(key: string): void {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.removeItem(key);
    } catch {
      // Nothing to clear if we cannot write in the first place.
    }
  },
};

/**
 * Value used when the provider fails to initialise. Keeps the app usable in a
 * read-only, disconnected state instead of blanking the whole tree, and lets
 * the user retry the wallet connection.
 */
const DISCONNECTED_WALLET: WalletContextValue = {
  address: null,
  network: DEFAULT_NETWORK,
  walletNetwork: null,
  networkUnknown: false,
  installed: false,
  connecting: false,
  error: "The wallet failed to load.",
  connect: async () => {},
  disconnect: () => {},
  setNetwork: () => {},
  sign: () => Promise.reject(new Error("Connect your wallet first.")),
  writeCtx: () => {
    throw new Error("Connect your wallet first.");
  },
};

/**
 * Catches a failure thrown while the WalletProvider initialises (e.g. a
 * Freighter API throw) and degrades to a disconnected `WalletContext` so the
 * page stays alive. The `fallback` prop is the same app tree rendered normally
 * inside the provider; on error it is re-rendered against the disconnected
 * value with a retry affordance.
 */
export class WalletErrorBoundary extends Component<
  { children: ReactNode; fallback: ReactNode },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error: Error) {
    console.error("WalletProvider failed to initialise:", error);
  }

  reset = () => this.setState({ hasError: false });

  render() {
    if (this.state.hasError) {
      return (
        <>
          <WalletContext.Provider value={DISCONNECTED_WALLET}>
            {this.props.fallback}
          </WalletContext.Provider>
          <div
            role="alert"
            className="fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-3 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-2 text-sm text-red-200 backdrop-blur"
          >
            <span>Wallet failed to load — browsing in read-only mode.</span>
            <button onClick={this.reset} className="btn-secondary text-xs">
              Retry
            </button>
          </div>
        </>
      );
    }
    return this.props.children;
  }
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const [address, setAddress] = useState<string | null>(null);
  const [network, setNetworkState] = useState<Network>(DEFAULT_NETWORK);
  const [walletNetwork, setWalletNetwork] = useState<Network | null>(null);
  const [installed, setInstalled] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addressRef = useRef<string | null>(null);
  useEffect(() => {
    addressRef.current = address;
  }, [address]);

  const syncNetwork = useCallback(async () => {
    const wn = await getWalletNetwork();
    setWalletNetwork(wn);
    if (wn) setNetworkState(wn);
  }, []);

  // Restore a prior session silently and detect the extension on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const present = await isFreighterInstalled();
      if (cancelled) return;
      setInstalled(present);
      if (!present) return;
      // A null flag means either "never connected" or "storage is blocked";
      // both cases simply skip session restore.
      if (safeStorage.get(STORAGE_KEY)) {
        const existing = await getConnectedAddress();
        if (cancelled) return;
        if (existing) {
          setAddress(existing);
          await syncNetwork();
        } else {
          // Access was revoked in the wallet since we last connected — drop
          // the stale flag so we stop silently probing on every load.
          safeStorage.remove(STORAGE_KEY);
        }
      }
    })().catch(() => {
      // A blocked localStorage (or any other storage-level failure) must not
      // escape as an unhandled rejection from this un-awaited IIFE.
    });
    return () => {
      cancelled = true;
    };
  }, [syncNetwork]);

  // React to account / network switches made inside the extension. Runs
  // whenever the extension is present, not just while connected, so a
  // network change made before connecting is still picked up.
  //
  // The watcher polls Freighter on a timer (no push events are available),
  // so we stop it while the tab is hidden and restart it on return to avoid
  // burning battery/CPU on background tabs the user isn't looking at.
  useEffect(() => {
    if (!installed) return;
    if (typeof document === "undefined") return watchWallet(handleWatchChange);

    let stop: (() => void) | null = null;

    function handleWatchChange({ address: next }: { address: string; network: string }) {
      if (addressRef.current) {
        if (next && next !== addressRef.current) setAddress(next);
        void syncNetwork();
      } else {
        // Disconnected: just observe the wallet's network without forcing
        // the freely-chosen read-only browsing network to follow it.
        void getWalletNetwork().then(setWalletNetwork);
      }
    }

    function start() {
      if (!stop) stop = watchWallet(handleWatchChange);
    }

    function pause() {
      stop?.();
      stop = null;
    }

    function onVisibilityChange() {
      if (document.hidden) {
        pause();
      } else {
        start();
      }
    }

    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      pause();
    };
  }, [installed, syncNetwork]);

  const connect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const addr = await fConnect();
      setAddress(addr);
      // Persisting the flag is best-effort: if storage is blocked the wallet is
      // still connected, so a failure here must not surface as a connect error.
      safeStorage.set(STORAGE_KEY, "1");
      await syncNetwork();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to connect wallet.");
      throw e;
    } finally {
      setConnecting(false);
    }
  }, [syncNetwork]);

  const disconnect = useCallback(() => {
    setAddress(null);
    setWalletNetwork(null);
    safeStorage.remove(STORAGE_KEY);
  }, []);

  const setNetwork = useCallback(
    (n: Network) => {
      // Only meaningful while disconnected; connected apps follow the wallet.
      if (!address) setNetworkState(n);
    },
    [address],
  );

  const networkUnknown = Boolean(address) && walletNetwork === null;
  const networkMismatch = Boolean(address) && walletNetwork !== null && walletNetwork !== network;

  const sign = useCallback(
    (xdr: string) => {
      if (!addressRef.current) {
        return Promise.reject(new Error("Connect your wallet first."));
      }
      if (networkUnknown) {
        return Promise.reject(
          new Error("Can't verify your wallet's network. Reconnect and try again."),
        );
      }
      if (networkMismatch) {
        return Promise.reject(
          new Error(
            `Your wallet is on a different network. Switch your wallet to match the app's network and try again.`,
          ),
        );
      }
      return signTx(xdr, networkPassphrase(network), addressRef.current);
    },
    [network, networkUnknown, networkMismatch],
  );

  const writeCtx = useCallback(
    (onPhase?: WriteCtx["onPhase"]): WriteCtx => {
      if (!addressRef.current) throw new Error("Connect your wallet first.");
      if (networkUnknown) {
        throw new Error("Can't verify your wallet's network. Reconnect and try again.");
      }
      if (networkMismatch) {
        throw new Error(
          `Your wallet is on a different network. Switch your wallet to match the app's network and try again.`,
        );
      }
      return {
        network,
        source: addressRef.current,
        sign,
        ...(onPhase !== undefined ? { onPhase } : {}),
      };
    },
    [network, sign, networkUnknown, networkMismatch],
  );

  const value = useMemo<WalletContextValue>(
    () => ({
      address,
      network,
      walletNetwork,
      networkUnknown,
      installed,
      connecting,
      error,
      connect,
      disconnect,
      setNetwork,
      sign,
      writeCtx,
    }),
    [
      address,
      network,
      walletNetwork,
      networkUnknown,
      installed,
      connecting,
      error,
      connect,
      disconnect,
      setNetwork,
      sign,
      writeCtx,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
