import React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, FileText } from 'lucide-react';

// Terms of use. Developer Policies III.A.1 require (1) a link to YouTube's
// Terms of Service and (2) a statement in our own terms that users of the
// client agree to be bound by the YouTube Terms of Service.

export const TermsPage: React.FC = () => {
  return (
    <div className="legal-page">
      <header className="legal-header">
        <Link to="/" className="legal-back" aria-label="Back to lobby">
          <ArrowLeft size={16} aria-hidden="true" />
          Back to JAM
        </Link>
        <div className="legal-title-row">
          <FileText size={20} aria-hidden="true" />
          <h1>Terms of Use</h1>
        </div>
        <p className="legal-updated">Last updated: September 23, 2026</p>
      </header>

      <article className="legal-content">
        <section>
          <h2>YouTube Terms of Service (required)</h2>
          <p>
            JAM plays music through the official YouTube embedded player.{' '}
            <strong>By using JAM, you agree to be bound by the YouTube Terms of Service</strong> at{' '}
            <a href="https://www.youtube.com/t/terms" target="_blank" rel="noopener noreferrer">
              youtube.com/t/terms
            </a>
            , which form part of these terms.
          </p>
        </section>

        <section>
          <h2>1. The service</h2>
          <p>
            JAM provides temporary, shared listening rooms (up to five participants) with a
            collaborative song queue, chat, and synchronized playback of YouTube videos. Rooms and
            their data expire and are deleted 24 hours after creation. The service is provided
            “as is” without warranties of any kind.
          </p>
        </section>

        <section>
          <h2>2. Your conduct</h2>
          <ul>
            <li>Use JAM only for lawful purposes and in a way that respects others.</li>
            <li>
              Do not request, queue, or share content you have no right to share, or content that
              violates YouTube’s Community Guidelines or third-party rights.
            </li>
            <li>No harassment, hate speech, spam, or automated abuse of the service.</li>
            <li>
              Do not attempt to circumvent rate limits, access controls, or technical restrictions
              of JAM or YouTube.
            </li>
          </ul>
        </section>

        <section>
          <h2>3. Hosts and moderation</h2>
          <p>
            The room host controls playback and the queue (skipping, removing, or playing tracks).
            Hosts are responsible for the rooms they create. We may remove rooms or restrict
            accounts that violate these terms.
          </p>
        </section>

        <section>
          <h2>4. Content and ownership</h2>
          <p>
            Videos are streamed via YouTube’s embedded player under YouTube’s terms — JAM does not
            host, download, or redistribute YouTube content. Your messages, requests, and uploaded
            material remain yours; you grant JAM the limited license needed to display them inside
            the room for its lifetime (at most 24 hours).
          </p>
        </section>

        <section>
          <h2>5. Changes and termination</h2>
          <p>
            We may update these terms (the revision date above will change) or discontinue the
            service. Continued use after an update constitutes acceptance of the revised terms.
          </p>
        </section>

        <section>
          <h2>6. Contact</h2>
          <p>
            Questions about these terms:{' '}
            <a href="https://github.com/AnujPatel-28/JAM/issues" target="_blank" rel="noopener noreferrer">
              open an issue on the JAM GitHub repository
            </a>
            .
          </p>
        </section>
      </article>
    </div>
  );
};
