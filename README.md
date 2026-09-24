# Harpers TFT Tracker — schema 9

Cloudflare Worker collects official Riot match results every five minutes.
GitHub Actions deploys `main` after `node verify.cjs` passes.

## Data and analysis

- Raw Riot responses remain private in `TFT_KV` for 90 days.
- `recent.json` contains up to 20 detailed results and compact history (up to 300).
- Korean labels use official Riot Data Dragon with exact ID matching. No fuzzy,
  digit-stripped or cross-set aliases. Unknown IDs stay unknown. Missing roles and
  item categories are explicitly unverified, not inferred from names.
- Known match patches select the corresponding Data Dragon build; unknown patches
  may use current labels but are explicitly marked `patch_verified: false`.
- `review_evidence` records opponent final-board overlap and review signals, not
  simultaneous scouting or proven mistakes. Final gold is not a reroll timeline.
- `similar_boards` searches only the local recent archive. Comparisons require
  the same known build, set, queue and game type; level within one, last round
  within three and matching equipped unit/star. Unknown patches disable comparison.
  Examples are descriptive, small and selected; they are not meta win-rate estimates.

## Monitoring

`/health` and GitHub `health.json` expose last attempt, last successful Riot check,
last successful sync, pending migration count and a sanitized error stage.
`recent.json.generated_at` describes content publication, NOT collector liveness.
Check heartbeat age independently; `/health` flags attempts older than 20 minutes.
On Riot HTTP 429 the Worker honors Retry-After across scheduled runs. GitHub failure
does not prevent Riot data storage; publication retries on the next run.
If GitHub itself fails, its health mirror may be stale: consult the Worker `/health`.

`review_status` deliberately separates collection/evidence from notification delivery.
ChatGPT does not expose a delivery receipt to this Worker. Both notification request
and delivery confirmation are null, not fabricated success or a pending queue to
re-send forever. Notification deduplication remains in the ChatGPT task's report history.

## Deployment and migration

Existing `TFT_KV`, Riot and GitHub secrets are reused; no new secret is required.
Up to five existing records are migrated each successful scheduled run, using private
raw archives where available. Old history outside the recent window is not automatically
reprocessed. No claims of shop, purchase, reroll, bench or placement timeline are made.

Verify schema 9 in `/latest` or `recent.json`, and a recent `last_riot_check_at` in
`health.json`. The health file can change when there are no new matches.
