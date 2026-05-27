// Pure label-merge helper used by the Gmail history sync path.
//
// Gmail history events carry a snapshot of `message.labelIds` taken BEFORE
// the labelsAdded / labelsRemoved deltas were applied. We need to replay
// the deltas locally so the persisted raw_labels match the post-event
// state — otherwise rows archived in Gmail (labelsRemoved: ['INBOX'])
// keep INBOX in raw_labels and the Inbox view (which filters by
// raw_labels.includes('INBOX')) keeps showing them.

export type LabelPatch = {
  raw_labels?: string[];
  is_archived?: boolean;
  is_read?: boolean;
};

export function removeLabelsFromCurrent(
  currentLabels: string[] | null | undefined,
  labelsToRemove: string[],
): string[] {
  const remove = new Set(labelsToRemove);
  return (currentLabels ?? []).filter((label) => !remove.has(label));
}

export function computeLabelPatch(
  currentLabels: string[] | undefined,
  added: string[],
  removed: string[],
): LabelPatch {
  const patch: LabelPatch = {};
  if (currentLabels) {
    const next = new Set(currentLabels);
    for (const l of removed) next.delete(l);
    for (const l of added) next.add(l);
    patch.raw_labels = Array.from(next);
  }
  if (removed.includes("INBOX")) patch.is_archived = true;
  if (added.includes("INBOX")) patch.is_archived = false;
  if (removed.includes("UNREAD")) patch.is_read = true;
  if (added.includes("UNREAD")) patch.is_read = false;
  return patch;
}
