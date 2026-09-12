# Fediverse Enhancement Proposal drafts

This directory holds FEP drafts developed in the open from Aurboda's running
federation code, before submission to the
[FEP process](https://codeberg.org/fediverse/fep).

- **[quantpub.md](./quantpub.md)** — _QuantPub: federated personal metrics for
  quantified-self sharing_. A vendor-neutral generalisation of Aurboda's
  federated feed: the `quant:Exercise` / `quant:Observation` vocabulary, the
  out-of-band structured-payload pattern (well-known discovery, structured post
  endpoint, data-driven public series endpoint, capability tokens), and the
  privacy model — scalar/series/geography sharing each a separate explicit
  opt-in — as normative requirements. Tracked in
  [issue #905](https://github.com/fiddur/aurboda/issues/905); the working name
  (QuantPub vs. Personal Metrics Vocabulary / MetricPub) is open for community
  input. Aurboda's own implementation of the pattern is documented in
  [docs/features/feed.md](../features/feed.md).
- **[quantpub-reddit-draft.md](./quantpub-reddit-draft.md)** — draft of the
  r/QuantifiedSelf outreach post (issue #905 step 3), kept in-repo for review;
  not itself a FEP. Placeholders mark the screenshots and links to fill in
  before posting.
