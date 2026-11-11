\* draftTransitions.markSendFailed also accepts a sent draft: from: ["approved", "sent"].
\* runs with: lease_expires
\* breaks: NoHiddenDelivery

MarkSendFailedFrom == {"approved", "sent"}
