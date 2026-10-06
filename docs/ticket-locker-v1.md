# Ticket Locker V1

## Goal

Ticket Locker is an opt-in booking assistant layered on top of 12306-MCP.

The intended workflow is:

1. Query direct and interline inventory.
2. Produce exactly 3 or 5 ranked candidate plans when possible.
3. Present those plans to the user.
4. The user explicitly selects one or more plan IDs and orders them.
5. Only the selected plan IDs are armed.
6. At execution time, re-query live inventory for the armed plan.
7. Submit plans strictly in the user's authorized order.
8. Stop all lower-priority submissions as soon as one plan enters the 12306 queue.
9. Stop all submissions immediately after a seat/order is locked.
10. The user completes payment in the official 12306 app/site.

## Hard invariants

- PLAN-FIRST: generating a candidate does not authorize booking.
- EXPLICIT-AUTHORIZATION: only IDs stored in an ArmedManifest may submit.
- SERIAL-PRIORITY: P1 > P3 > P2 means exactly that order; no racing.
- QUEUE-STOPS-FALLBACK: entering the queue blocks all lower-priority plans.
- LOCK-STOPS-ALL: once an order is locked, all further submissions stop.
- NO-UNAUTHORIZED-FALLBACK: an unselected plan never becomes eligible just because it has inventory.
- LIVE-PRECHECK: inventory is re-queried immediately before submission.
- NO-CREDENTIALS-IN-GIT: login cookies and local passenger state are ignored by git.
- NO-BYPASS: CAPTCHA, device verification, risk controls, or other human verification are not bypassed.

## Planner

Example:

    node build/ticket-locker-cli.js plan       --date 2026-10-07       --from 吉安西       --to 昆山南       --count 5       --hubs 黄山北,杭州东,上海虹桥,南京南       --out ticket-plan.json

The planner combines direct results with 12306 interline searches, then deduplicates and ranks executable plans.

## Arm

Example:

    node build/ticket-locker-cli.js arm       --plan-file ticket-plan.json       --select P1,P3,P2       --out ticket-plan.armed.json

This authorizes exactly P1 > P3 > P2.

## Session

QR login uses the current official 12306 flow:

- /passport/web/create-qr64
- /passport/web/checkqr
- /passport/web/auth/uamtk
- /otn/uamauthclient

The resulting cookie jar is stored locally with mode 0600 under .ticket-locker/ and must not be committed.

## Execution status model

The booking adapter returns one of:

- HARD_FAIL: this plan cannot proceed; advance to the next authorized plan.
- RETRYABLE_FAIL: retry only this plan within the configured retry budget.
- QUEUED: 12306 accepted the submission into its queue; stop all fallback plans.
- LOCKED: a pending-payment order/seat was obtained; stop everything.
- NEED_HUMAN: a verification step is required; stop automation and hand off.

## Current V1 status

Implemented and tested:

- 3/5-plan generation
- multi-hub interline discovery
- deterministic ranking
- explicit arm manifests
- unauthorized-plan blocking
- strict priority serialization
- queue-stops-fallback
- lock-stops-all
- live seat precheck
- QR session creation/check
- local cookie-jar persistence

Next integration step:

- authenticated passenger selection
- official direct-order submission adapter
- official interline-order submission adapter
- queue polling and locked-order detection
