import Link from "next/link";

export const metadata = {
  title: "Privacy — Clearbox",
  description: "How the Clearbox invite-only beta handles Gmail data.",
};

export default function PrivacyPage() {
  return (
    <main className="policy-shell">
      <Link className="policy-back" href="/">← Clearbox</Link>
      <p className="eyebrow">INVITE-ONLY BETA</p>
      <h1>Privacy policy</h1>
      <p className="policy-updated">Effective August 5, 2026</p>

      <section>
        <h2>What Clearbox accesses</h2>
        <p>Clearbox uses Google OAuth and the Gmail API only after you grant permission. It stores your Gmail address, an encrypted OAuth refresh token, message and thread identifiers, sender, subject, date, and Gmail labels needed to build the sender dashboard.</p>
        <p>Inbox synchronization does not request or store full message bodies or attachments. Short Gmail preview text is fetched only when you open a sender and is not stored in the Clearbox database.</p>
      </section>

      <section>
        <h2>How the data is used</h2>
        <p>Your data is used only to group Inbox messages by sender, show mailbox statistics and recent previews, and carry out cleanup actions you explicitly confirm. Clearbox does not sell Gmail data, use it for advertising, or allow other beta members to access it.</p>
      </section>

      <section>
        <h2>Storage and isolation</h2>
        <p>The beta runs on Cloudflare Workers and D1. Refresh tokens are encrypted before storage and session tokens are stored only as hashes. Every mailbox, message, preview, and cleanup query is scoped to the authenticated beta workspace.</p>
      </section>

      <section>
        <h2>Cleanup and deletion</h2>
        <p>Clearbox moves messages to Gmail Trash; it does not permanently delete Gmail messages. Starred and Important messages are excluded by the server. Disconnecting removes your linked tokens, sessions, indexed metadata, and cleanup records from Clearbox even if Google&apos;s revocation service is temporarily unavailable. Clearbox also asks Google to revoke every connected grant and tells you when Google Account permissions still need to be removed manually. Administrator revocation removes the same locally stored Clearbox data.</p>
        <p><Link href="/data-deletion">Read the data deletion instructions.</Link></p>
      </section>

      <section>
        <h2>Limited beta access</h2>
        <p>Only addresses invited by the beta administrator may create a workspace. While the Google OAuth project remains in Testing, invited members must also be listed as Google OAuth test users and may need to reconnect when Google test authorization expires.</p>
      </section>

      <section>
        <h2>Changes and questions</h2>
        <p>This policy may be updated as the beta changes. Material changes should be shared with beta members before broader data use is introduced. For questions, contact the beta administrator who provided your invitation.</p>
      </section>
    </main>
  );
}
