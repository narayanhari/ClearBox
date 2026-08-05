"use client";

import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ApiResponseError, readApiJson } from "@/app/lib/client-http";

interface SenderSummary {
  email: string;
  name: string;
  count: number;
  unread: number;
  protectedCount: number;
  latestAt: number;
  accountCount: number;
}

interface GmailAccountSummary {
  email: string;
  lastSyncedAt: number | null;
  syncStatus: string;
  syncIndexedCount: number;
}

interface DashboardData {
  connected: boolean;
  configured: boolean;
  mode: "demo" | "live";
  user: { email: string; role: "admin" | "member" } | null;
  stats: { total: number; unread: number; senders: number; protected: number };
  senders: SenderSummary[];
  accounts: GmailAccountSummary[];
  lastSyncedAt: number | null;
  syncStatus: string;
  syncScope: string;
}

interface MessageItem {
  id: string;
  subject: string;
  receivedAt: number;
  isUnread: boolean | number;
  isStarred: boolean | number;
  isImportant: boolean | number;
  accountEmail: string;
  preview: string;
}

interface SenderDetail {
  sender: SenderSummary;
  messages: MessageItem[];
  mode: "demo" | "live";
}

interface ToastState {
  message: string;
  tone?: "success" | "error";
  jobIds?: string[];
}

interface BetaMember {
  email: string;
  role: "admin" | "member";
  status: "invited" | "active" | "revoked";
  invitedAt: number;
  acceptedAt: number | null;
}

const compactNumber = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const actionHeaders = { "x-clearbox-action": "1" };
const SYNC_STATUS_RETRY_LIMIT = 6;
const SYNC_LOCK_RETRY_LIMIT = 15;
const PROGRESSIVE_DASHBOARD_PAGE_INTERVAL = 25;

function relativeTime(timestamp: number | null): string {
  if (!timestamp) return "Not synced yet";
  const seconds = Math.max(1, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "Just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function senderInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function senderTone(email: string): number {
  return [...email].reduce((total, character) => total + character.charCodeAt(0), 0) % 5;
}

export function MailDashboard() {
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"count" | "unread" | "latest">("count");
  const [selectedAccount, setSelectedAccount] = useState("");
  const [selected, setSelected] = useState<SenderSummary | null>(null);
  const [detail, setDetail] = useState<SenderDetail | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [cleanupTarget, setCleanupTarget] = useState<SenderSummary | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const [cleaningProgress, setCleaningProgress] = useState(0);
  const [setupOpen, setSetupOpen] = useState(false);
  const [betaMembers, setBetaMembers] = useState<BetaMember[]>([]);
  const [betaMemberLimit, setBetaMemberLimit] = useState(25);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteBusy, setInviteBusy] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const conversationStreamRef = useRef<HTMLDivElement | null>(null);

  const loadDashboard = useCallback(async () => {
    const accountQuery = selectedAccount ? `?account=${encodeURIComponent(selectedAccount)}` : "";
    const response = await fetch(`/api/dashboard${accountQuery}`, { cache: "no-store" });
    if (!response.ok) throw new Error("Could not load the dashboard.");
    const nextDashboard = (await response.json()) as DashboardData;
    setDashboard(nextDashboard);
    setSelected((current) =>
      current ? nextDashboard.senders.find((sender) => sender.email === current.email) ?? null : null,
    );
  }, [selectedAccount]);

  const loadBetaMembers = useCallback(async () => {
    const response = await fetch("/api/admin/invitations", {
      cache: "no-store",
      headers: actionHeaders,
    });
    const payload = (await response.json()) as {
      error?: string;
      members?: BetaMember[];
      maxMembers?: number;
    };
    if (!response.ok) throw new Error(payload.error ?? "Could not load beta invitations.");
    setBetaMembers(payload.members ?? []);
    setBetaMemberLimit(payload.maxMembers ?? 25);
  }, []);

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      loadDashboard().catch((error) => setToast({ message: error.message, tone: "error" }));
    });
    return () => {
      cancelled = true;
    };
  }, [loadDashboard]);

  useEffect(() => {
    queueMicrotask(() => {
      const params = new URLSearchParams(window.location.search);
      const error = params.get("error");
      if (error === "missing-config") {
        setSetupOpen(true);
        setToast({ message: "Add your Google credentials before connecting Gmail.", tone: "error" });
      } else if (error === "invite-required" || error === "account-not-allowed") {
        setSetupOpen(true);
        setToast({ message: "That Gmail address has not been invited to the beta.", tone: "error" });
      } else if (error === "account-already-linked") {
        setToast({ message: "That Gmail account is already linked to another owner.", tone: "error" });
      } else if (error === "account-reserved") {
        setToast({ message: "That Gmail address is reserved for its own beta workspace.", tone: "error" });
      } else if (error === "account-limit") {
        setToast({ message: "A beta workspace can link up to five Gmail accounts.", tone: "error" });
      } else if (error) {
        setToast({ message: "Google connection was not completed. Please try again.", tone: "error" });
      } else if (params.get("account-added")) {
        setToast({ message: "Gmail account added. Sync the inbox to include it.", tone: "success" });
      } else if (params.get("connected")) {
        setToast({ message: "Gmail connected. Run your first full Inbox scan.", tone: "success" });
      }
      if (error || params.get("connected") || params.get("account-added")) {
        window.history.replaceState({}, "", "/");
      }
    });
  }, []);

  useEffect(() => {
    if (!setupOpen || dashboard?.user?.role !== "admin") return;
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      loadBetaMembers().catch((error) => {
        if (!cancelled) {
          setToast({ message: error instanceof Error ? error.message : "Could not load invitations.", tone: "error" });
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, [dashboard?.user?.role, loadBetaMembers, setupOpen]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    queueMicrotask(() => {
      if (controller.signal.aborted) return;
      setLoadingDetail(true);
      const params = new URLSearchParams({ sender: selected.email });
      if (selectedAccount) params.set("account", selectedAccount);
      fetch(`/api/senders?${params.toString()}`, {
        cache: "no-store",
        headers: actionHeaders,
        signal: controller.signal,
      })
        .then(async (response) => {
          const payload = (await response.json()) as SenderDetail & { error?: string };
          if (!response.ok) throw new Error(payload.error ?? "Could not load sender messages.");
          if (!controller.signal.aborted) setDetail(payload);
        })
        .catch((error) => {
          if (!controller.signal.aborted) setToast({ message: error.message, tone: "error" });
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingDetail(false);
        });
    });
    return () => controller.abort();
  }, [selected, selectedAccount]);

  useEffect(() => {
    if (!selected) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSelected(null);
        setDetail(null);
      }
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [selected]);

  useEffect(() => {
    if (!loadingDetail && detail?.messages.length && conversationStreamRef.current) {
      conversationStreamRef.current.scrollTop = conversationStreamRef.current.scrollHeight;
    }
  }, [detail, loadingDetail]);

  useEffect(() => {
    if (!toast || toast.jobIds?.length) return;
    const timer = window.setTimeout(() => setToast(null), 4500);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const visibleSenders = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return [...(dashboard?.senders ?? [])]
      .filter(
        (sender) =>
          !normalizedQuery ||
          sender.name.toLowerCase().includes(normalizedQuery) ||
          sender.email.toLowerCase().includes(normalizedQuery),
      )
      .sort((left, right) => {
        if (sort === "unread") return right.unread - left.unread;
        if (sort === "latest") return right.latestAt - left.latestAt;
        return right.count - left.count;
      });
  }, [dashboard, query, sort]);

  async function runSync() {
    setSyncing(true);
    try {
      const accounts = selectedAccount
        ? dashboard?.accounts.filter((account) => account.email === selectedAccount) ?? []
        : dashboard?.accounts ?? [];
      let completedIndexed = 0;
      for (const account of accounts) {
        let complete = false;
        let accountIndexed = account.syncIndexedCount;
        let pageCount = 0;
        let transientRetries = 0;
        let lockRetries = 0;
        while (!complete) {
          setToast({
            message: `Scanning ${account.email}…${accountIndexed ? ` ${accountIndexed.toLocaleString()} indexed` : ""}`,
          });
          const response = await fetch("/api/sync", {
            method: "POST",
            headers: { ...actionHeaders, "content-type": "application/json" },
            body: JSON.stringify({ accountEmail: account.email }),
          });
          let payload: { error?: string; indexedTotal?: number; complete?: boolean };
          try {
            payload = await readApiJson(response);
          } catch (error) {
            if (
              error instanceof ApiResponseError &&
              error.retryable &&
              transientRetries < SYNC_STATUS_RETRY_LIMIT
            ) {
              const waitMs = Math.min(20_000, 3_000 * 2 ** transientRetries);
              transientRetries += 1;
              setToast({
                message: `Cloudflare interrupted the scan. Retrying ${account.email} in ${Math.round(waitMs / 1000)}s…`,
              });
              await new Promise((resolve) => window.setTimeout(resolve, waitMs));
              continue;
            }
            throw error;
          }
          if (response.status === 409 && lockRetries < SYNC_LOCK_RETRY_LIMIT) {
            lockRetries += 1;
            setToast({ message: `Waiting for the previous ${account.email} scan step to finish…` });
            await new Promise((resolve) => window.setTimeout(resolve, 5_000));
            continue;
          }
          if (response.status === 503 && transientRetries < SYNC_STATUS_RETRY_LIMIT) {
            const waitMs = Math.min(30_000, 2_000 * 2 ** transientRetries);
            transientRetries += 1;
            setToast({ message: `Gmail is busy. Retrying ${account.email} in ${Math.round(waitMs / 1000)}s…` });
            await new Promise((resolve) => window.setTimeout(resolve, waitMs));
            continue;
          }
          if (!response.ok) throw new Error(payload.error ?? `Sync failed for ${account.email}`);
          transientRetries = 0;
          lockRetries = 0;
          accountIndexed = payload.indexedTotal ?? accountIndexed;
          complete = Boolean(payload.complete);
          pageCount += 1;
          if (pageCount === 1 || pageCount % PROGRESSIVE_DASHBOARD_PAGE_INTERVAL === 0 || complete) {
            await loadDashboard();
          }
        }
        completedIndexed += accountIndexed;
      }
      await loadDashboard();
      setToast({
        message: `${completedIndexed.toLocaleString()} Inbox messages indexed across ${accounts.length} account${accounts.length === 1 ? "" : "s"}.`,
        tone: "success",
      });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Sync failed", tone: "error" });
    } finally {
      setSyncing(false);
    }
  }

  async function trashSender() {
    if (!cleanupTarget) return;
    if (!dashboard?.connected) {
      setCleanupTarget(null);
      if (dashboard?.configured) window.location.href = "/api/auth/google/start";
      else setSetupOpen(true);
      return;
    }
    const senderEmail = cleanupTarget.email;
    const accountEmail = selectedAccount;
    const completedJobIds: string[] = [];
    let movedTotal = 0;
    setCleaning(true);
    setCleaningProgress(0);
    try {
      let hasMore = true;
      while (hasMore) {
        const response = await fetch("/api/cleanup/trash", {
          method: "POST",
          headers: { ...actionHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            senderEmail,
            ...(accountEmail ? { accountEmail } : {}),
          }),
        });
        const payload = (await response.json()) as {
          error?: string;
          count?: number;
          jobId?: string;
          limited?: boolean;
        };
        if (!response.ok || !payload.jobId || !payload.count) {
          throw new Error(payload.error ?? "Cleanup stopped before all messages were moved");
        }
        completedJobIds.push(payload.jobId);
        movedTotal += payload.count;
        setCleaningProgress(movedTotal);
        hasMore = Boolean(payload.limited);
      }
      setCleanupTarget(null);
      setSelected(null);
      setDetail(null);
      await loadDashboard();
      setToast({
        message: `${movedTotal.toLocaleString()} messages moved to Trash.`,
        tone: "success",
        jobIds: completedJobIds,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Cleanup failed";
      if (completedJobIds.length) {
        setCleanupTarget(null);
        setSelected(null);
        setDetail(null);
        await loadDashboard().catch(() => undefined);
        setToast({
          message: `${movedTotal.toLocaleString()} messages were moved before cleanup stopped. ${message}`,
          tone: "error",
          jobIds: completedJobIds,
        });
      } else {
        setToast({ message, tone: "error" });
      }
    } finally {
      setCleaning(false);
      setCleaningProgress(0);
    }
  }

  async function trashSingle(messageId: string, accountEmail: string) {
    if (!dashboard?.connected) return;
    try {
      const response = await fetch("/api/cleanup/trash", {
        method: "POST",
        headers: { ...actionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ messageId, accountEmail }),
      });
      const payload = (await response.json()) as { error?: string; count?: number; jobId?: string };
      if (!response.ok || !payload.jobId) throw new Error(payload.error ?? "Cleanup failed");
      if (selected) setSelected({ ...selected, count: Math.max(0, selected.count - 1) });
      await loadDashboard();
      setToast({ message: "1 message moved to Trash.", tone: "success", jobIds: [payload.jobId] });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Cleanup failed", tone: "error" });
    }
  }

  async function undoCleanup(jobIds: string[]) {
    setToast({ message: "Restoring messages…" });
    let restoredTotal = 0;
    const failedJobIds: string[] = [];
    let firstError = "";
    for (const jobId of [...jobIds].reverse()) {
      try {
        const response = await fetch("/api/cleanup/undo", {
          method: "POST",
          headers: { ...actionHeaders, "content-type": "application/json" },
          body: JSON.stringify({ jobId }),
        });
        const payload = (await response.json()) as { error?: string; count?: number };
        if (!response.ok) throw new Error(payload.error ?? "Undo failed");
        restoredTotal += payload.count ?? 0;
      } catch (error) {
        failedJobIds.push(jobId);
        if (!firstError) firstError = error instanceof Error ? error.message : "Undo failed";
      }
    }
    await loadDashboard().catch(() => undefined);
    if (failedJobIds.length) {
      setToast({
        message: `${restoredTotal.toLocaleString()} messages restored. ${firstError}`,
        tone: "error",
        jobIds: failedJobIds,
      });
    } else {
      setToast({ message: `${restoredTotal.toLocaleString()} messages restored.`, tone: "success" });
    }
  }

  async function inviteBetaMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInviteBusy(true);
    try {
      const response = await fetch("/api/admin/invitations", {
        method: "POST",
        headers: { ...actionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ email: inviteEmail }),
      });
      const payload = (await response.json()) as { error?: string; email?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not create the invitation.");
      setInviteEmail("");
      await loadBetaMembers();
      setToast({
        message: `${payload.email ?? "That Gmail address"} can now join the ClearBox beta. Add it to Google OAuth test users too.`,
        tone: "success",
      });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Invitation failed", tone: "error" });
    } finally {
      setInviteBusy(false);
    }
  }

  async function revokeBetaMember(member: BetaMember) {
    if (!window.confirm(`Revoke ClearBox beta access for ${member.email}? Their sessions, linked tokens, and indexed ClearBox data will be removed.`)) {
      return;
    }
    setInviteBusy(true);
    try {
      const response = await fetch("/api/admin/invitations", {
        method: "DELETE",
        headers: { ...actionHeaders, "content-type": "application/json" },
        body: JSON.stringify({ email: member.email }),
      });
      const payload = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(payload.error ?? "Could not revoke beta access.");
      await loadBetaMembers();
      setToast({ message: `Beta access revoked for ${member.email}.`, tone: "success" });
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : "Revocation failed", tone: "error" });
    } finally {
      setInviteBusy(false);
    }
  }

  async function disconnect() {
    if (!window.confirm("Disconnect every Gmail account and remove all locally indexed metadata? Your Gmail messages will not be deleted.")) return;
    try {
      const response = await fetch("/api/auth/disconnect", { method: "POST", headers: actionHeaders });
      const payload = (await response.json()) as {
        error?: string;
        googleAccessRevoked?: boolean;
      };
      if (!response.ok) throw new Error(payload.error ?? "Disconnect failed. Please retry.");
      if (!payload.googleAccessRevoked) {
        window.alert("ClearBox removed its local data and access. Google did not confirm every token revocation, so also remove ClearBox from your Google Account permissions.");
      }
      window.location.assign("/");
    } catch (error) {
      setToast({
        message: error instanceof Error ? error.message : "Disconnect failed. Please retry.",
        tone: "error",
      });
    }
  }

  if (!dashboard) {
    return (
      <main className="loading-shell" aria-label="Loading Clearbox">
        <div className="loading-mark"><span /><span /><span /></div>
        <p>Preparing your inbox view…</p>
      </main>
    );
  }

  const totalCleanableCount = cleanupTarget
    ? Math.max(0, cleanupTarget.count - cleanupTarget.protectedCount)
    : 0;
  const conversationMessages = detail ? [...detail.messages].reverse() : [];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#top" aria-label="Clearbox home">
          <span className="brand-mark"><i /><i /><i /></span>
          <span>clearbox</span>
        </a>
        <nav className="side-nav" aria-label="Main navigation">
          <a className="active" href="#senders"><span>⌂</span>Overview</a>
          <a href="#senders"><span>◎</span>Senders</a>
          <a href="#senders"><span>✓</span>Review</a>
        </nav>
        <div className="sidebar-bottom">
          <div className="safety-mini">
            <span className="safety-icon">✓</span>
            <div><strong>Safe cleanup</strong><small>Trash only, never permanent</small></div>
          </div>
          <button className="nav-button" type="button" onClick={() => setSetupOpen(true)}><span>⚙</span>Setup</button>
        </div>
      </aside>

      <main className="main" id="top">
        <header className="topbar">
          <div>
            <p className="eyebrow">INVITE-ONLY INBOX ORGANIZER</p>
            <h1>Your inbox, finally in perspective.</h1>
          </div>
          <div className="top-actions">
            {dashboard.connected ? (
              <>
                <button className="sync-button" type="button" onClick={runSync} disabled={syncing}>
                  <span className={syncing ? "spin" : ""}>↻</span>{syncing ? "Scanning…" : "Sync inbox"}
                </button>
                <button
                  className="add-account-button"
                  type="button"
                  onClick={() => (window.location.href = "/api/auth/google/start")}
                  disabled={syncing}
                >+ Add Gmail</button>
                <button className="account-pill" type="button" onClick={disconnect} title="Disconnect all Gmail accounts">
                  <span>{dashboard.user?.email[0].toUpperCase()}</span>
                  <i>{dashboard.accounts.length} Gmail {dashboard.accounts.length === 1 ? "account" : "accounts"}</i>
                </button>
              </>
            ) : (
              <button
                className="connect-button"
                type="button"
                onClick={() => dashboard.configured ? (window.location.href = "/api/auth/google/start") : setSetupOpen(true)}
              >
                <span className="google-g">G</span>Join with invited Gmail
              </button>
            )}
          </div>
        </header>

        <section className="status-row" aria-label="Connection status">
          <span className={`mode-badge ${dashboard.connected ? "live" : "demo"}`}>
            <i />{dashboard.connected ? "Live beta workspace" : "Invite-only beta"}
          </span>
          <span>Last synced: {relativeTime(dashboard.lastSyncedAt)}</span>
          <span>
            {dashboard.syncScope}
            {dashboard.connected && ` · ${selectedAccount || `${dashboard.accounts.length} accounts`}`}
          </span>
        </section>

        {!dashboard.connected && (
          <section className="connect-callout">
            <div className="callout-visual" aria-hidden="true">
              <span>428</span><i /><i /><i />
            </div>
            <div>
              <p className="eyebrow">PRIVATE BETA ACCESS</p>
              <h2>See who fills your inbox.</h2>
              <p>Join with the exact Gmail address invited by the ClearBox administrator. Every beta member gets an isolated workspace; headers are indexed securely and previews are never stored.</p>
            </div>
            <button
              type="button"
              onClick={() => dashboard.configured ? (window.location.href = "/api/auth/google/start") : setSetupOpen(true)}
            >Join the beta <span>→</span></button>
          </section>
        )}

        {dashboard.connected && dashboard.stats.total === 0 && (
          <section className="first-sync">
            <div className="first-sync-icon">↻</div>
            <div><strong>Your Gmail is connected</strong><p>Run the metadata-only scan to build your sender list from the entire Inbox.</p></div>
            <button type="button" onClick={runSync} disabled={syncing}>{syncing ? "Scanning…" : "Scan entire Inbox"}</button>
          </section>
        )}

        <section className="stat-grid" aria-label="Mailbox summary">
          <article className="stat-card primary">
            <div><span>Indexed messages</span><strong>{dashboard.stats.total.toLocaleString()}</strong></div>
            <span className="stat-spark"><i /><i /><i /><i /><i /></span>
            <small>From the full Inbox selection</small>
          </article>
          <article className="stat-card">
            <div><span>Unique senders</span><strong>{dashboard.stats.senders.toLocaleString()}</strong></div>
            <span className="stat-symbol">◎</span>
            <small>Sorted by who sends the most</small>
          </article>
          <article className="stat-card">
            <div><span>Still unread</span><strong>{dashboard.stats.unread.toLocaleString()}</strong></div>
            <span className="stat-symbol coral">•</span>
            <small>Across all indexed senders</small>
          </article>
          <article className="stat-card protected-card">
            <div><span>Protected</span><strong>{dashboard.stats.protected.toLocaleString()}</strong></div>
            <span className="stat-symbol shield">✓</span>
            <small>Starred or important messages</small>
          </article>
        </section>

        <section className="workspace" id="senders">
          <div className="sender-panel">
            <div className="panel-heading">
              <div><p className="eyebrow">SENDER RANKING</p><h2>Who sends you the most?</h2></div>
              <span className="result-count">{visibleSenders.length} senders</span>
            </div>
            <div className="controls">
              <label className="search-box">
                <span>⌕</span>
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search sender or email" />
              </label>
              {dashboard.connected && (
                <label className="sort-control account-filter">
                  <span>Mailbox</span>
                  <select
                    value={selectedAccount}
                    onChange={(event) => {
                      setSelectedAccount(event.target.value);
                      setSelected(null);
                      setDetail(null);
                    }}
                  >
                    <option value="">All {dashboard.accounts.length} accounts</option>
                    {dashboard.accounts.map((account) => (
                      <option value={account.email} key={account.email}>{account.email}</option>
                    ))}
                  </select>
                </label>
              )}
              <label className="sort-control">
                <span>Sort by</span>
                <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)}>
                  <option value="count">Most emails</option>
                  <option value="unread">Most unread</option>
                  <option value="latest">Most recent</option>
                </select>
              </label>
            </div>
            <div className="table-head" aria-hidden="true">
              <span>Sender</span><span>Latest</span><span>Unread</span><span>Messages</span><span />
            </div>
            <div className="sender-list">
              {visibleSenders.map((sender, index) => (
                <button
                  type="button"
                  key={sender.email}
                  className={`sender-row ${selected?.email === sender.email ? "selected" : ""}`}
                  onClick={() => {
                    setDetail(null);
                    setSelected(sender);
                  }}
                >
                  <span className={`avatar tone-${senderTone(sender.email)}`}>{senderInitials(sender.name)}</span>
                  <span className="sender-identity">
                    <strong>{sender.name}</strong><small>{sender.email}</small>
                    {index < 3 && <i className="rank-chip">#{index + 1}</i>}
                    {!selectedAccount && sender.accountCount > 1 && (
                      <i className="account-count-chip">{sender.accountCount} accounts</i>
                    )}
                  </span>
                  <span className="latest-cell">{relativeTime(sender.latestAt)}</span>
                  <span className="unread-cell">{sender.unread ? <i>{sender.unread}</i> : <small>—</small>}</span>
                  <span className="count-cell"><strong>{sender.count.toLocaleString()}</strong><small> emails</small></span>
                  <span className="row-arrow">›</span>
                </button>
              ))}
              {!visibleSenders.length && <div className="empty-state">No senders match “{query}”.</div>}
            </div>
          </div>

        </section>

        <footer>
          <span>Clearbox invite-only beta</span>
          <span>Headers indexed · previews fetched live · Trash, never permanent delete</span>
          <nav className="legal-links" aria-label="Legal and privacy">
            <a href="/privacy">Privacy</a>
            <a href="/data-deletion">Data deletion</a>
          </nav>
        </footer>
      </main>

      {selected && (
        <div
          className="conversation-backdrop"
          role="presentation"
          onMouseDown={() => {
            setSelected(null);
            setDetail(null);
          }}
        >
          <section
            className="conversation-page"
            role="dialog"
            aria-modal="true"
            aria-labelledby="conversation-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="conversation-header">
              <button
                className="conversation-back"
                type="button"
                autoFocus
                onClick={() => {
                  setSelected(null);
                  setDetail(null);
                }}
              ><span aria-hidden="true">←</span><i>Sender list</i></button>
              <div className="conversation-sender">
                <span className={`avatar large tone-${senderTone(selected.email)}`}>
                  {senderInitials(selected.name)}
                </span>
                <div>
                  <p className="eyebrow">SENDER CONVERSATION</p>
                  <h2 id="conversation-title">{selected.name}</h2>
                  <span>{selected.email}</span>
                </div>
              </div>
              <div className="conversation-stats" aria-label="Sender statistics">
                <span><strong>{selected.count.toLocaleString()}</strong> total</span>
                <span><strong>{selected.unread.toLocaleString()}</strong> unread</span>
                <span><strong>{selected.protectedCount.toLocaleString()}</strong> protected</span>
              </div>
            </header>

            <div className="conversation-context">
              <div>
                <strong>Latest 10 emails</strong>
                <span>Oldest at the top, newest at the bottom</span>
              </div>
              <p>
                <span>ⓘ</span>
                {dashboard.connected
                  ? "Short previews are fetched live from Gmail only while this page is open. They are not saved locally."
                  : "These sample previews demonstrate how your Gmail sender conversation will look."}
              </p>
            </div>

            <div className="conversation-stream" ref={conversationStreamRef} aria-live="polite">
              {loadingDetail && (
                <div className="conversation-loading">
                  <i /><i /><i />
                  <span>Loading the latest email previews…</span>
                </div>
              )}
              {!loadingDetail && conversationMessages.map((message) => {
                const isProtected = Boolean(message.isStarred || message.isImportant);
                return (
                  <article
                    className={`mail-bubble ${message.isUnread ? "is-unread" : ""}`}
                    key={`${message.accountEmail}:${message.id}`}
                  >
                    <div className="bubble-avatar" aria-hidden="true">{senderInitials(selected.name).slice(0, 1)}</div>
                    <div className="bubble-content">
                      <div className="bubble-meta">
                        <strong>{selected.name}</strong>
                        <time>{relativeTime(message.receivedAt)}</time>
                      </div>
                      <h3>{message.subject}</h3>
                      <p>{message.preview}</p>
                      <div className="bubble-footer">
                        <span>{message.accountEmail}</span>
                        {message.isUnread && <i>Unread</i>}
                        {isProtected ? (
                          <i className="bubble-protected">★ Protected</i>
                        ) : (
                          <button
                            type="button"
                            onClick={() => trashSingle(message.id, message.accountEmail)}
                            disabled={!dashboard.connected}
                            aria-label={`Move ${message.subject} to Trash`}
                          >Move to Trash</button>
                        )}
                      </div>
                    </div>
                  </article>
                );
              })}
              {!loadingDetail && !conversationMessages.length && (
                <div className="conversation-empty">No indexed emails are available for this sender.</div>
              )}
            </div>

            <footer className="conversation-actions">
              <div>
                <strong>Ready to decide?</strong>
                <span>Starred and important emails always stay protected.</span>
              </div>
              <button className="conversation-keep" type="button" onClick={() => {
                setSelected(null);
                setDetail(null);
              }}>Keep for now</button>
              <button className="conversation-review" type="button" onClick={() => setCleanupTarget(selected)}>
                Review cleanup
                <span>{compactNumber.format(Math.max(0, selected.count - selected.protectedCount))}</span>
              </button>
            </footer>
          </section>
        </div>
      )}

      {cleanupTarget && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => !cleaning && setCleanupTarget(null)}>
          <section className="modal" role="dialog" aria-modal="true" aria-labelledby="cleanup-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setCleanupTarget(null)} disabled={cleaning}>×</button>
            <span className={`avatar modal-avatar tone-${senderTone(cleanupTarget.email)}`}>{senderInitials(cleanupTarget.name)}</span>
            <p className="eyebrow">CLEANUP PREVIEW</p>
            <h2 id="cleanup-title">Move all {totalCleanableCount.toLocaleString()} messages to Trash?</h2>
            <p className="modal-copy">From <strong>{cleanupTarget.name}</strong> · {cleanupTarget.email}</p>
            <p className="modal-scope">
              {selectedAccount ? `In ${selectedAccount}` : `Across ${cleanupTarget.accountCount} connected account${cleanupTarget.accountCount === 1 ? "" : "s"}`}
            </p>
            <div className="modal-breakdown">
              <div><span>Will move to Trash</span><strong>{totalCleanableCount.toLocaleString()}</strong></div>
              <div><span>Will stay protected</span><strong>{cleanupTarget.protectedCount.toLocaleString()}</strong></div>
            </div>
            {cleaning && (
              <div className="cleanup-progress" role="status" aria-live="polite">
                <span style={{ width: `${Math.min(100, (cleaningProgress / Math.max(1, totalCleanableCount)) * 100)}%` }} />
                <small>{cleaningProgress.toLocaleString()} of {totalCleanableCount.toLocaleString()} moved</small>
              </div>
            )}
            <ul className="safety-list">
              <li><span>✓</span>Nothing is permanently deleted</li>
              <li><span>✓</span>Starred and important messages stay put</li>
              <li><span>✓</span>Large cleanups continue automatically in recoverable batches</li>
              <li><span>✓</span>You can undo this action for 10 minutes</li>
            </ul>
            <button className="confirm-cleanup" type="button" onClick={trashSender} disabled={cleaning || totalCleanableCount === 0}>
              {cleaning ? `Moving all… ${cleaningProgress.toLocaleString()} completed` : dashboard.connected ? `Move all ${totalCleanableCount.toLocaleString()} to Trash` : "Connect Gmail to continue"}
            </button>
            <button className="cancel-cleanup" type="button" onClick={() => setCleanupTarget(null)} disabled={cleaning}>Keep these messages</button>
          </section>
        </div>
      )}

      {setupOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={() => setSetupOpen(false)}>
          <section className="modal setup-modal" role="dialog" aria-modal="true" aria-labelledby="setup-title" onMouseDown={(event) => event.stopPropagation()}>
            <button className="modal-close" type="button" onClick={() => setSetupOpen(false)}>×</button>
            {!dashboard.configured ? (
              <>
                <p className="eyebrow">ONE-TIME OPERATOR SETUP</p>
                <h2 id="setup-title">Configure the private beta</h2>
                <p className="modal-copy">Add these values to the server environment. They are never entered by beta members.</p>
                <div className="code-block">
                  <span>GOOGLE_CLIENT_ID=…</span>
                  <span>GOOGLE_CLIENT_SECRET=…</span>
                  <span>BETA_ADMIN_EMAIL=…</span>
                  <span>APP_ENCRYPTION_KEY=…</span>
                </div>
                <ol className="setup-steps">
                  <li><span>1</span>Enable Gmail API and configure an External OAuth consent screen.</li>
                  <li><span>2</span>Add the beta administrator as a Google OAuth test user.</li>
                  <li><span>3</span>Add this site&apos;s <code>/api/auth/google/callback</code> URL as an authorized redirect.</li>
                  <li><span>4</span>Keep credentials in Cloudflare secrets, never in GitHub build variables.</li>
                </ol>
                <a className="confirm-cleanup setup-link" href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Open Google Cloud Console <span>↗</span></a>
              </>
            ) : !dashboard.connected ? (
              <>
                <p className="eyebrow">INVITE-ONLY BETA</p>
                <h2 id="setup-title">Use your invited Gmail</h2>
                <p className="modal-copy">ClearBox accepts only addresses invited by the beta administrator. Sign in with that exact Google account to create your isolated workspace.</p>
                <ul className="safety-list beta-safety-list">
                  <li><span>✓</span>Your mailbox metadata is isolated from every other beta member.</li>
                  <li><span>✓</span>Email bodies and attachments are not stored.</li>
                  <li><span>✓</span>Cleanup uses Gmail Trash and protects Starred or Important messages.</li>
                </ul>
                <button className="confirm-cleanup" type="button" onClick={() => (window.location.href = "/api/auth/google/start")}>Continue with invited Gmail</button>
                <p className="beta-help">If Google blocks access, ask the administrator to add your address to the project&apos;s OAuth test users.</p>
              </>
            ) : dashboard.user?.role === "admin" ? (
              <>
                <p className="eyebrow">BETA ADMINISTRATION</p>
                <h2 id="setup-title">Invite beta members</h2>
                <p className="modal-copy">Invite the exact Gmail address they will use. Then add the same address to Google OAuth test users while the consent screen is in Testing.</p>
                <form className="invite-form" onSubmit={inviteBetaMember}>
                  <label htmlFor="invite-email">Gmail address</label>
                  <div>
                    <input
                      id="invite-email"
                      type="email"
                      autoComplete="off"
                      maxLength={254}
                      required
                      value={inviteEmail}
                      onChange={(event) => setInviteEmail(event.target.value)}
                      placeholder="friend@gmail.com"
                      disabled={inviteBusy}
                    />
                    <button type="submit" disabled={inviteBusy || !inviteEmail.trim()}>{inviteBusy ? "Saving…" : "Invite"}</button>
                  </div>
                </form>
                <div className="beta-member-heading">
                  <strong>Beta access</strong>
                  <span>{betaMembers.filter((member) => member.role === "member" && member.status !== "revoked").length}/{betaMemberLimit} members</span>
                </div>
                <div className="beta-member-list">
                  {betaMembers.map((member) => (
                    <div className="beta-member" key={member.email}>
                      <span className={`beta-member-status ${member.status}`} aria-label={member.status} />
                      <div><strong>{member.email}</strong><small>{member.role === "admin" ? "Administrator" : member.status === "active" ? "Joined" : member.status === "invited" ? "Invited" : "Revoked"}</small></div>
                      {member.role !== "admin" && member.status !== "revoked" && (
                        <button type="button" onClick={() => revokeBetaMember(member)} disabled={inviteBusy}>Revoke</button>
                      )}
                    </div>
                  ))}
                  {!betaMembers.length && <p className="beta-help">Loading beta access…</p>}
                </div>
                <a className="oauth-test-link" href="https://console.cloud.google.com/auth/audience" target="_blank" rel="noreferrer">Manage Google OAuth test users <span>↗</span></a>
              </>
            ) : (
              <>
                <p className="eyebrow">YOUR BETA WORKSPACE</p>
                <h2 id="setup-title">Private by default</h2>
                <p className="modal-copy">Signed in as <strong>{dashboard.user?.email}</strong>. Your indexed metadata, linked Gmail accounts, and cleanup jobs are scoped only to your beta workspace.</p>
                <ul className="safety-list beta-safety-list">
                  <li><span>✓</span>Link up to five Gmail accounts you control.</li>
                  <li><span>✓</span>Other beta members cannot see or modify your data.</li>
                  <li><span>✓</span>Disconnect removes your indexed metadata from ClearBox.</li>
                </ul>
                <button className="confirm-cleanup" type="button" onClick={() => setSetupOpen(false)}>Back to my workspace</button>
              </>
            )}
          </section>
        </div>
      )}

      {toast && (
        <div className={`toast ${toast.tone ?? ""}`} role="status">
          <span>{toast.tone === "error" ? "!" : "✓"}</span>
          <p>{toast.message}</p>
          {toast.jobIds?.length && <button type="button" onClick={() => undoCleanup(toast.jobIds!)}>Undo</button>}
          <button className="toast-close" type="button" onClick={() => setToast(null)}>×</button>
        </div>
      )}
    </div>
  );
}
