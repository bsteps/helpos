\* handleSendReply admits sent drafts and calls SMTP before its database writes.
\* runs with: lease_expires
\* breaks: NoResendWithoutPerson SentOnlyWhenApproved

WorkerLocksAndChecks(w) ==
    /\ worker[w].pc = "claimed"
    /\ lockHolder = 0
    /\ IF status \in {"approved", "sent"}
       THEN /\ lockHolder' = w
            /\ worker' = [worker EXCEPT ![w].pc = "sending"]
            /\ job' = job
       ELSE /\ worker' = [worker EXCEPT ![w].pc = "settling_complete"]
            /\ job' = job
            /\ UNCHANGED lockHolder
    /\ UNCHANGED <<requested, status, delivered, personRetries, sentUnapproved, faults>>

TransactionCommits(w) ==
    /\ worker[w].pc = "committing"
    /\ IF status = "approved"
       THEN /\ status' = "sent"
            /\ lockHolder' = Release(w)
            /\ worker' = [worker EXCEPT ![w].pc = "settling_complete"]
            /\ job' = job
       ELSE /\ Fail(w)
            /\ UNCHANGED status
    /\ UNCHANGED <<requested, delivered, personRetries, sentUnapproved, faults>>
