// Core sync pipeline barrel — preserves the @/lib/sync.server import
// path that every caller and test in the codebase already uses. The
// real logic lives in focused submodules under ./sync/:
//
//   account-context      loadAccountContext + 5s cache, invalidate hooks
//   account-lock         per-process coalescing lock for syncSinceHistory
//   backfill             backfillRecent + backfillWindow + startBackfillJob
//                          + tickBackfillJobs + cancelBackfillJob
//   backoff              retry-policy tables + computeBackoffSeconds
//   classify             classifyParsedEmail + ClassificationResult
//   dlq                  isTransientDlqError + replayTransientDlq
//   filter-engine        applyFilter + matchByFilters (pure)
//   folder-learn         learnFromLinkedLabel + regenerateFolderProfile
//                          + bumpEmailsSinceLearn + loadOlderFromLabel
//                          + recordManualMove
//   forward-retry        retryForwardAttempts (atomic claim via SQL RPC)
//   history              syncSinceHistory + bootstrapAccount
//                          + bumpHistoryAndWatch + applyLabelChange
//   history-id           gmailHistoryIdGreater (BigInt comparison)
//   process-message      processGmailMessage + ProcessTimings
//   queue                enqueueMessageJob / enqueueMessageJobs
//                          + runMessageJobs + retryMessageJob
//   reconcile            reconcileLocalInbox
//   types                Folder, Filter, RuleNode, OverrideException,
//                          GmailAccount

export { withAccountLock } from "./sync/account-lock";
export {
  type AccountContext,
  loadAccountContext,
  invalidateAccountContext,
  invalidateAccountContextForUser,
} from "./sync/account-context";
export {
  backfillRecent,
  backfillWindow,
  startBackfillJob,
  cancelBackfillJob,
  tickBackfillJobs,
} from "./sync/backfill";
export { computeBackoffSeconds } from "./sync/backoff";
export {
  classifyParsedEmail,
  classifyByRules,
  classifyByAi,
  type ClassificationResult,
  type RulesClassification,
} from "./sync/classify";
export { isTransientDlqError, replayTransientDlq } from "./sync/dlq";
export {
  bumpEmailsSinceLearn,
  learnFromLinkedLabel,
  loadOlderFromLabel,
  regenerateFolderProfile,
} from "./sync/folder-learn";
export { retryForwardAttempts } from "./sync/forward-retry";
export { syncSinceHistory } from "./sync/history";
export { gmailHistoryIdGreater } from "./sync/history-id";
export {
  processGmailMessage,
  applyFolderActions,
  type ProcessTimings,
  type ActionFolder,
} from "./sync/process-message";
export {
  enqueueMessageJob,
  enqueueMessageJobs,
  runMessageJobs,
  retryMessageJob,
} from "./sync/queue";
export { reconcileLocalInbox } from "./sync/reconcile";
