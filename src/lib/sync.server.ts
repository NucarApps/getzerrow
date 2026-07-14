// Public surface of the sync pipeline. Every implementation lives in
// `./sync/*` — this file only re-exports so existing call sites keep
// their `import { x } from "@/lib/sync.server"` paths.
//
// Sub-modules (import from these directly for new code):
//   ./sync/account-context   AccountContext, loadAccountContext, invalidate*
//   ./sync/account-lock      withAccountLock (per-account in-process coalescing)
//   ./sync/backfill          backfillRecent, backfillWindow, startBackfillJob,
//                             cancelBackfillJob, tickBackfillJobs
//   ./sync/backoff           computeBackoffSeconds + retry constants
//   ./sync/catchup           bulkCatchupClaim (webhook-drain claim RPC)
//   ./sync/classify          classifyByRules, classifyParsedEmail
//   ./sync/dlq               isTransientDlqError, replayTransientDlq
//   ./sync/enqueue           enqueueMessageJob, enqueueMessageJobs, retryMessageJob
//   ./sync/folder-learn      recordManualMove, regenerateFolderProfile,
//                             bumpEmailsSinceLearn, learnFromLinkedLabel,
//                             loadOlderFromLabel
//   ./sync/forward-retry     retryForwardAttempts
//   ./sync/history           syncSinceHistory, bootstrapAccount, applyLabelChange
//   ./sync/history-events    collectAddedMessages
//   ./sync/history-id        gmailHistoryIdGreater (BigInt comparison)
//   ./sync/process-message   processGmailMessage, applyFolderActions
//   ./sync/read-state        syncReadState
//   ./sync/reconcile         reconcileLocalInbox
//   ./sync/rescue            rescueStrandedEmails
//   ./sync/run-jobs          runMessageJobs (queue drainer)

export { withAccountLock } from "./sync/account-lock";
export { computeBackoffSeconds } from "./sync/backoff";
export { gmailHistoryIdGreater } from "./sync/history-id";
export { isTransientDlqError, replayTransientDlq } from "./sync/dlq";
export { retryForwardAttempts } from "./sync/forward-retry";
export { rescueStrandedEmails } from "./sync/rescue";
export { bulkCatchupClaim, type CatchupResult } from "./sync/catchup";
export { classifyByRules, classifyParsedEmail, type ClassificationResult } from "./sync/classify";
export { syncReadState } from "./sync/read-state";
export {
  type AccountContext,
  loadAccountContext,
  invalidateAccountContext,
  invalidateAccountContextForUser,
} from "./sync/account-context";
export { reconcileLocalInbox } from "./sync/reconcile";
export {
  regenerateFolderProfile,
  bumpEmailsSinceLearn,
  learnFromLinkedLabel,
  loadOlderFromLabel,
} from "./sync/folder-learn";
export { processGmailMessage, type ProcessTimings } from "./sync/process-message";
export {
  backfillRecent,
  backfillWindow,
  startBackfillJob,
  cancelBackfillJob,
  tickBackfillJobs,
} from "./sync/backfill";
export { syncSinceHistory } from "./sync/history";
export { enqueueMessageJob, enqueueMessageJobs, retryMessageJob } from "./sync/enqueue";
export { runMessageJobs } from "./sync/run-jobs";
