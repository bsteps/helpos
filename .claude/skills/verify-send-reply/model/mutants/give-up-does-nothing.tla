\* handleSendGaveUp no longer calls markSendFailed.
\* runs with: no faults
\* breaks: NoSilentStall

GiveUpMarksFailed(w) ==
    /\ worker[w].pc = "giving_up"
    /\ lockHolder = 0
    /\ worker' = [worker EXCEPT ![w].pc = "settling_fail"]
    /\ job' = job
    /\ UNCHANGED <<status, lockHolder, delivered, personRetries, sentUnapproved, faults>>
