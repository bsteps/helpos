\* Retry admits an uncertain attempt without a human request.
\* runs with: commit_fails
\* breaks: NoResendWithoutPerson

WorkerLocksAndChecks(w) ==
    /\ worker[w].pc = "claimed"
    /\ lockHolder = 0
    /\ IF status = "approved" \/ status = "send_uncertain"
       THEN /\ requested' = FALSE
            /\ status' = "send_uncertain"
            /\ worker' = [worker EXCEPT ![w].pc = "prepared", ![w].marker = personRetries, ![w].resend = requested]
       ELSE /\ worker' = [worker EXCEPT ![w].pc = "settling_complete"]
            /\ UNCHANGED <<requested, status>>
    /\ UNCHANGED <<job, lockHolder, delivered, personRetries, sentUnapproved, faults>>
