\* handleSendReply as a `steps` handler: one transaction reads and checks the draft, the
\* send happens outside any transaction, and a second transaction runs markSent.
\* runs with: lease_expires
\* breaks: NoResendWithoutPerson SentOnlyWhenApproved

WorkerLocksAndChecks(w) ==
    /\ worker[w].pc = "claimed"
    /\ lockHolder = 0
    /\ IF status = "approved"
       THEN /\ worker' = [worker EXCEPT ![w].pc = "sending"]
            /\ job' = job
       ELSE /\ worker' = [worker EXCEPT ![w].pc = "settling_complete"]
            /\ job' = job
    /\ UNCHANGED <<status, lockHolder, delivered, personRetries, sentUnapproved, faults>>

TransactionCommits(w) ==
    /\ worker[w].pc = "committing"
    /\ lockHolder = 0
    /\ IF status = "approved"
       THEN /\ status' = "sent"
            /\ worker' = [worker EXCEPT ![w].pc = "settling_complete"]
            /\ job' = job
            /\ UNCHANGED lockHolder
       ELSE /\ Fail(w)
            /\ UNCHANGED status
    /\ UNCHANGED <<delivered, personRetries, sentUnapproved, faults>>
