export const metadata = {
  title: "Data deletion — Clearbox",
  description: "How to disconnect Gmail and delete data from Clearbox.",
};

export default function DataDeletionPage() {
  return (
    <main className="policy-shell">
      <Link className="policy-back" href="/">← Clearbox</Link>
      <p className="eyebrow">ACCOUNT CONTROL</p>
      <h1>Delete your Clearbox data</h1>
      <p className="policy-updated">Disconnecting is self-service and immediate.</p>

      <section>
        <h2>From your beta workspace</h2>
        <ol>
          <li>Sign in to Clearbox.</li>
          <li>Select the account control in the top-right corner.</li>
          <li>Confirm <strong>Disconnect every Gmail account</strong>.</li>
        </ol>
        <p>Clearbox removes your sessions, encrypted refresh tokens, linked account records, indexed message metadata, and cleanup records even if Google&apos;s revocation service is temporarily unavailable. It also asks Google to revoke every connected grant and tells you when Google Account permissions still need to be removed manually.</p>
      </section>

      <section>
        <h2>If you cannot sign in</h2>
        <p>Ask the beta administrator who invited you to revoke your beta access. Revocation removes the linked tokens and indexed Clearbox data for your workspace.</p>
      </section>

      <section>
        <h2>Remove Google authorization directly</h2>
        <p>You can also remove Clearbox from your Google Account&apos;s third-party access page. This prevents future Gmail API access but does not by itself delete already indexed Clearbox metadata, so use the Clearbox disconnect or administrator revocation as well.</p>
        <a className="policy-action" href="https://myaccount.google.com/permissions" target="_blank" rel="noreferrer">Open Google Account permissions ↗</a>
      </section>
    </main>
  );
}
import Link from "next/link";
