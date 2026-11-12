\* The second transaction sends after a person confirmed the attempt.
\* runs with: no faults
\* breaks: SentOnlyWhenApproved

WorkerRechecksMarker(w) ==
    /\ worker[w].pc = "prepared"
    /\ lockHolder = 0
    /\ IF TRUE
       THEN /\ lockHolder' = w
            /\ worker' = [worker EXCEPT ![w].pc = "sending"]
       ELSE /\ worker' = [worker EXCEPT ![w].pc = "settling_complete"]
            /\ UNCHANGED lockHolder
    /\ UNCHANGED <<requested, status, job, delivered, personRetries, sentUnapproved, faults>>
