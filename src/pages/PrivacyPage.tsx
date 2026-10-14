import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ShieldCheck } from 'lucide-react';

// Privacy policy satisfying YouTube API Services Developer Policies III.A.2:
// every clause (a)-(i) is addressed, including the YouTube API Services
// notice, Google Privacy Policy link, data-use/sharing explanations, and
// third-party content/cookies disclosures.

export const PrivacyPage: React.FC = () => {
  return (
    <div className="legal-page">
      <header className="legal-header">
        <Link to="/" className="legal-back" aria-label="Back to lobby">
          <ArrowLeft size={16} aria-hidden="true" />
          Back to JAM
        </Link>
        <div className="legal-title-row">
          <ShieldCheck size={20} aria-hidden="true" />
          <h1>Privacy Policy</h1>
        </div>
        <p className="legal-updated">Last updated: September 23, 2026</p>
      </header>

      <article className="legal-content">
        <section>
          <h2>Summary</h2>
          <p>
            JAM (“we”, “us”) is a synchronized listening rooms app. This policy explains what
            information we access, collect, store, and share — including information related to your
            use of YouTube through our app — and how you can control it. By using JAM you must agree
            to this policy before accessing the app’s features.
          </p>
        </section>

        <section>
          <h2>1. YouTube API Services notice (required disclosure)</h2>
          <p>
            JAM uses <strong>YouTube API Services</strong> — specifically the YouTube embedded
            player (IFrame Player API) and YouTube’s official oEmbed endpoint — to render video
            thumbnails and titles, determine playability and content restrictions, and play content
            inside the room player. Your use of JAM is also governed by the{' '}
            <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">
              YouTube Terms of Service
            </a>
            .
          </p>
          <p>
            This app’s use of information received from Google APIs will adhere to the{' '}
            <a href="http://www.google.com/policies/privacy" target="_blank" rel="noopener noreferrer">
              Google Privacy Policy
            </a>
            , including the Google API Services User Data Policy.
          </p>
        </section>

        <section>
          <h2>2. Information we access, collect, and store</h2>
          <ul>
            <li>
              <strong>Account data</strong> — email address and sign-in identifiers, if you create
              or use an account (processed by our authentication provider, InsForge).
            </li>
            <li>
              <strong>Display profile</strong> — the display name you choose, stored in your browser
              and used to label you in rooms.
            </li>
            <li>
              <strong>Session data</strong> — a random session identifier and member tokens (browser
              storage only) that prove your presence in a room. Room passwords you enter are never
              stored in readable form.
            </li>
            <li>
              <strong>Room activity</strong> — messages you send, songs you request or upvote, and
              playback sync events, stored for the lifetime of the room (rooms and their data
              self-delete after 24 hours).
            </li>
            <li>
              <strong>YouTube API Data</strong> — video IDs, titles, authors, and thumbnail URLs
              resolved through YouTube’s official oEmbed endpoint. We do not download, cache, or
              store YouTube audio/video content.
            </li>
            <li>
              <strong>Technical data</strong> — IP address (used for rate limiting bot checks) and
              basic request metadata on our edge functions.
            </li>
          </ul>
        </section>

        <section>
          <h2>3. How we use and share information</h2>
          <ul>
            <li>To operate rooms: sync playback, deliver chat, and rank the collaborative queue.</li>
            <li>To keep the service safe: bot checks (Cloudflare Turnstile) and per-IP rate limits.</li>
            <li>
              <strong>Shared with YouTube:</strong> when the embedded player loads and when
              playback occurs, basic data (including cookies/device information, depending on your
              browser settings) is shared with YouTube for playback, fraud prevention, and platform
              integrity. If Autoplay were enabled, this sharing would begin at page load — JAM never
              enables Autoplay; playback only starts after your explicit action.
            </li>
            <li>
              <strong>Shared with infrastructure providers:</strong> InsForge (database, realtime,
              auth), Cloudflare (hosting, Turnstile, and — where enabled — Insights analytics), and
              Google Fonts/YouTube (fonts and the player), strictly to deliver the app.
            </li>
            <li>We do not sell your personal information.</li>
          </ul>
        </section>

        <section>
          <h2>4. Third-party content and advertisements</h2>
          <p>
            JAM displays third-party content — principally videos embedded from YouTube. JAM does
            not currently serve third-party advertisements. If that changes, this policy will be
            updated to disclose that third parties may serve content, including advertisements,
            before any such ads are enabled.
          </p>
        </section>

        <section>
          <h2>5. Cookies and similar technologies</h2>
          <p>
            We use browser storage (localStorage/sessionStorage) for session and preference data.
            Third parties whose content we embed — including the YouTube player and Cloudflare
            Turnstile — may place or access cookies or similar technologies on your device, subject
            to their own policies. You can control cookies through your browser settings; blocking
            them may affect sign-in or playback.
          </p>
        </section>

        <section>
          <h2>6. Data retention and deletion</h2>
          <p>
            Rooms and all room-scoped data (chat, queue, playback state, presence) are deleted
            automatically after 24 hours. You may request deletion of any account-scoped data we
            hold at any time (see Contact) — we will act on verified requests within 7 calendar
            days. Deleting data in JAM does not delete copies stored by YouTube; manage those
            directly with YouTube.
          </p>
        </section>

        <section>
          <h2>7. Google account authorization (Authorized Data)</h2>
          <p>
            JAM does <strong>not</strong> request access to your Google account and never accesses
            YouTube Authorized Data (no Google sign-in, no channel or playlist writes). If we ever
            add such features, this policy will explain the scopes and how to revoke access via{' '}
            <a
              href="https://security.google.com/settings/security/permissions"
              target="_blank"
              rel="noopener noreferrer"
            >
              Google’s security settings page
            </a>{' '}
            before those features launch.
          </p>
        </section>

        <section>
          <h2>8. Children’s privacy</h2>
          <p>
            We look up the Made-For-Kids status of embedded videos where YouTube provides it and
            reduce tracking accordingly. JAM is not directed at children under 13 (or the
            equivalent minimum age in your jurisdiction); do not use JAM if you are below that age
            without a parent or guardian’s consent.
          </p>
        </section>

        <section>
          <h2>9. Contact</h2>
          <p>
            Questions or deletion requests:{' '}
            <a href="https://github.com/AnujPatel-28/JAM/issues" target="_blank" rel="noopener noreferrer">
              open an issue on the JAM GitHub repository
            </a>
            . We will respond as soon as reasonably possible.
          </p>
        </section>
      </article>
    </div>
  );
};
