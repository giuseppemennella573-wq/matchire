import { Logo } from "@/components/logo";
export const metadata = { title: "Privacy policy" };

const UPDATED = "29 October 2026";

export default function Privacy() {
  return (
    <main className="public stack-lg" style={{ maxWidth: 760 }}>
      <Logo href="/" style={{ padding: "8px 0 0" }} />
      <div className="stack" style={{ gap: 6 }}>
        <h1>Privacy policy</h1>
        <p className="muted">Last updated {UPDATED}</p>
      </div>

      <section className="stack">
        <p>
          Matchire.ai Pte. Ltd. (&quot;Matchire&quot;, &quot;we&quot;) runs Matchire.ai, a booking assistant for event vendors in Singapore.
          This policy explains what personal data we handle, why, and the choices you have. We handle personal data in line with
          Singapore&apos;s Personal Data Protection Act 2012 (PDPA).
        </p>
      </section>

      <section className="stack">
        <h2>Who this covers</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li><b>Vendors</b>: businesses that sign up to use Matchire.</li>
          <li><b>Planners and customers</b>: people who send an enquiry to a vendor that uses Matchire, by WhatsApp, email or a vendor&apos;s enquiry form.</li>
          <li><b>Visitors</b>: people who use our website or request early access.</li>
        </ul>
      </section>

      <section className="stack">
        <h2>What we collect</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li><b>Vendor accounts</b>: name, business name, email address, password (stored only as a secure hash), price lists, settings and calendar entries.</li>
          <li><b>Enquiries and messages</b>: the content of messages planners send to a vendor, their name, phone number or email address, and event details they share (such as date, guest count and budget), plus the replies sent back.</li>
          <li><b>Early-access requests</b>: name, business, business type, email address and WhatsApp number.</li>
          <li><b>Technical data</b>: a login cookie to keep vendors signed in, and standard server logs.</li>
        </ul>
      </section>

      <section className="stack">
        <h2>How we use it</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li>To receive enquiries for vendors, prepare quotes from the vendor&apos;s own prices, draft and send replies, manage date holds and send follow-ups.</li>
          <li>To pass an enquiry to a partner vendor, only when the vendor who received it chooses to refer it.</li>
          <li>To contact people who asked for early access.</li>
          <li>To run, secure and improve the service.</li>
        </ul>
        <p>We do not sell personal data, and we do not use enquiry content for advertising.</p>
      </section>

      <section className="stack">
        <h2>Who processes data for us</h2>
        <ul className="stack" style={{ margin: 0, paddingLeft: 20 }}>
          <li><b>Render</b> hosts the application and its database.</li>
          <li><b>Meta (WhatsApp Business Platform)</b> carries WhatsApp messages between planners and vendors.</li>
          <li><b>Anthropic</b> provides the AI model that reads enquiries and drafts replies. Message content is sent to it for that purpose only.</li>
          <li><b>Google Workspace</b> sends and receives our email, and keeps our daily database backups.</li>
        </ul>
        <p>These providers may process data outside Singapore. We use them under their business terms, which require them to protect the data.</p>
      </section>

      <section className="stack">
        <h2>Vendors and their customers</h2>
        <p>
          When a planner contacts a vendor, the vendor decides how that enquiry is handled, and Matchire processes it on the vendor&apos;s
          behalf. Questions about a specific booking are best sent to the vendor; we will help them respond.
        </p>
      </section>

      <section className="stack">
        <h2>How long we keep it</h2>
        <p>
          We keep vendor account data while the account is open. Enquiries and messages are kept for as long as the vendor needs them for
          their bookings, and deleted when the vendor deletes them or closes their account. Early-access requests are kept until we have
          followed up, or until you ask us to delete them.
        </p>
      </section>

      <section className="stack" id="deletion">
        <h2>Your choices and data deletion</h2>
        <p>
          You can ask to see, correct or delete personal data we hold about you, including WhatsApp conversations, or withdraw consent to
          being contacted. Email <a href="mailto:hello@matchire.ai">hello@matchire.ai</a> from the address or with the phone number concerned,
          and we will respond within 30 days.
        </p>
      </section>

      <section className="stack">
        <h2>Security</h2>
        <p>Data is sent over encrypted connections, passwords are hashed, and access to vendor data is limited to that vendor&apos;s account.</p>
      </section>

      <section className="stack">
        <h2>Requests from authorities</h2>
        <p>
          We review every request from a public authority for legal validity, challenge requests we consider unlawful,
          disclose only the minimum information required, and keep a record of each request and our response.
        </p>
      </section>

      <section className="stack">
        <h2>Contact</h2>
        <p>
          Matchire.ai Pte. Ltd., Singapore<br />
          Data protection contact: Sales department, <a href="mailto:hello@matchire.ai">hello@matchire.ai</a>
        </p>
        <p className="small muted">We may update this policy; the date at the top shows the latest version.</p>
      </section>
    </main>
  );
}
