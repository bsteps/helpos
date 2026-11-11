----------------------------- MODULE SendReply -----------------------------
EXTENDS Naturals

CONSTANTS
    Workers,          \* worker processes that can run a send attempt at the same time
    RetryLimit,       \* sendReplyRetry.limit: retries after the first attempt
    MaxPersonRetries, \* how many times a person may call retrySend
    Faults,           \* the faults this run allows, a subset of AllFaults
    MaxFaults         \* how many fault events one behaviour may have

AllFaults == {"commit_fails", "smtp_reply_lost", "worker_dies", "lease_expires", "give_up_fails"}

VARIABLES
    status,         \* drafts.status, as committed
    job,            \* the send-reply pg-boss job, one per draft (singletonKey = draft id)
    worker,         \* the send attempt each worker is running
    lockHolder,     \* the worker whose transaction holds the draft row lock, or 0
    delivered,      \* how many times SMTP accepted the reply: copies the customer got
    personRetries,  \* how many times a person called retrySend
    sentUnapproved, \* TRUE once SMTP accepted the reply while the draft was not approved
    faults          \* fault events so far

vars == <<status, job, worker, lockHolder, delivered, personRetries, sentUnapproved, faults>>

Statuses == {"pending", "approved", "sent", "send_failed", "discarded"}
JobStates == {"none", "queued", "active", "completed", "failed"}
Pcs == {"idle", "claimed", "sending", "committing", "giving_up", "settling_complete", "settling_fail"}

MarkSendFailedFrom == {"approved"}

ToldItWent == {"sent"}

TypeOK ==
    /\ status \in Statuses
    /\ job.state \in JobStates /\ job.tries \in 0..RetryLimit /\ job.claimed \in BOOLEAN
    /\ worker \in [Workers -> [pc : Pcs, tries : 0..RetryLimit, gen : Nat]]
    /\ lockHolder \in Workers \cup {0}
    /\ delivered \in Nat /\ personRetries \in 0..MaxPersonRetries /\ faults \in 0..MaxFaults

CanFault(f) == f \in Faults /\ faults < MaxFaults

JobLive == job.state \in {"queued", "active"}

SendSettled == ~JobLive /\ \A w \in Workers : worker[w].pc = "idle"

\* app_enqueue with singletonKey: a job not yet completed or failed is reused.
Enqueue ==
    IF JobLive THEN job
    ELSE [state |-> "queued", tries |-> 0, claimed |-> FALSE, gen |-> job.gen + 1]

\* pg-boss settles an attempt only while the job is still active under that attempt
\* (its attempt fence on id and retry_count). A stale attempt's settle changes nothing.
Settle(w, outcome) ==
    IF job.state = "active" /\ job.gen = worker[w].gen /\ job.tries = worker[w].tries
    THEN [job EXCEPT !.state =
            IF outcome = "complete" THEN "completed"
            ELSE IF job.tries < RetryLimit THEN "queued" ELSE "failed"]
    ELSE job

Release(w) == IF lockHolder = w THEN 0 ELSE lockHolder

Init ==
    /\ status = "pending"
    /\ job = [state |-> "none", tries |-> 0, claimed |-> FALSE, gen |-> 0]
    /\ worker = [w \in Workers |-> [pc |-> "idle", tries |-> 0, gen |-> 0]]
    /\ lockHolder = 0
    /\ delivered = 0
    /\ personRetries = 0
    /\ sentUnapproved = FALSE
    /\ faults = 0


PersonApproves ==
    /\ status = "pending"
    /\ lockHolder = 0
    /\ status' = "approved"
    /\ job' = Enqueue
    /\ UNCHANGED <<worker, lockHolder, delivered, personRetries, sentUnapproved, faults>>

PersonRetriesSend ==
    /\ personRetries < MaxPersonRetries
    /\ \/ /\ status = "send_failed"
          /\ lockHolder = 0
          /\ status' = "approved"
       \/ /\ status = "approved"
          /\ UNCHANGED status
    /\ job' = Enqueue
    /\ personRetries' = personRetries + 1
    /\ UNCHANGED <<worker, lockHolder, delivered, sentUnapproved, faults>>

PersonDiscards ==
    /\ status \in {"pending", "send_failed"}
    /\ lockHolder = 0
    /\ status' = "discarded"
    /\ UNCHANGED <<job, worker, lockHolder, delivered, personRetries, sentUnapproved, faults>>


WorkerClaimsJob(w) ==
    /\ worker[w].pc = "idle"
    /\ job.state = "queued"
    /\ LET tries == IF job.claimed THEN job.tries + 1 ELSE job.tries
       IN /\ job' = [job EXCEPT !.state = "active", !.tries = tries, !.claimed = TRUE]
          /\ worker' = [worker EXCEPT ![w] = [pc |-> "claimed", tries |-> tries, gen |-> job.gen]]
    /\ UNCHANGED <<status, lockHolder, delivered, personRetries, sentUnapproved, faults>>

AttemptAlive ==
    \E w \in Workers :
        worker[w].pc # "idle" /\ worker[w].gen = job.gen /\ worker[w].tries = job.tries

\* The supervisor fails an active job whose lease ran out: retried, or failed on its last
\* attempt. It never calls onGiveUp. With its worker dead this always happens in the end;
\* with its worker still running, it is the lease_expires fault.
JobLeaseExpires ==
    /\ job.state = "active"
    /\ \/ ~AttemptAlive /\ UNCHANGED faults
       \/ AttemptAlive /\ CanFault("lease_expires") /\ faults' = faults + 1
    /\ job' = [job EXCEPT !.state = IF job.tries < RetryLimit THEN "queued" ELSE "failed"]
    /\ UNCHANGED <<status, worker, lockHolder, delivered, personRetries, sentUnapproved>>


\* The attempt throws: the transaction rolls back, then consume() runs onGiveUp on the last
\* attempt, or pg-boss queues a retry.
Fail(w) ==
    /\ lockHolder' = Release(w)
    /\ IF worker[w].tries >= RetryLimit
       THEN /\ worker' = [worker EXCEPT ![w].pc = "giving_up"]
            /\ job' = job
       ELSE /\ worker' = [worker EXCEPT ![w].pc = "settling_fail"]
            /\ job' = job

\* select ... for update on the draft, then the status checks. A draft that is sent, or not
\* approved, returns. Otherwise the outbound message and markSent are written in the
\* transaction, under the lock, before the send.
WorkerLocksAndChecks(w) ==
    /\ worker[w].pc = "claimed"
    /\ lockHolder = 0
    /\ IF status = "approved"
       THEN /\ lockHolder' = w
            /\ worker' = [worker EXCEPT ![w].pc = "sending"]
            /\ job' = job
       ELSE /\ worker' = [worker EXCEPT ![w].pc = "settling_complete"]
            /\ job' = job
            /\ UNCHANGED lockHolder
    /\ UNCHANGED <<status, delivered, personRetries, sentUnapproved, faults>>

SmtpAccepts(w) ==
    /\ worker[w].pc = "sending"
    /\ delivered' = delivered + 1
    /\ sentUnapproved' = (sentUnapproved \/ status # "approved")
    /\ worker' = [worker EXCEPT ![w].pc = "committing"]
    /\ UNCHANGED <<status, job, lockHolder, personRetries, faults>>

\* The mail server is down or refuses the message: nothing went out.
SmtpRejects(w) ==
    /\ worker[w].pc = "sending"
    /\ Fail(w)
    /\ UNCHANGED <<status, delivered, personRetries, sentUnapproved, faults>>

\* The server accepted the message, but its reply never reached transport.send.
SmtpReplyLost(w) ==
    /\ worker[w].pc = "sending"
    /\ CanFault("smtp_reply_lost")
    /\ delivered' = delivered + 1
    /\ sentUnapproved' = (sentUnapproved \/ status # "approved")
    /\ faults' = faults + 1
    /\ Fail(w)
    /\ UNCHANGED <<status, personRetries>>

TransactionCommits(w) ==
    /\ worker[w].pc = "committing"
    /\ status' = "sent"
    /\ lockHolder' = Release(w)
    /\ worker' = [worker EXCEPT ![w].pc = "settling_complete"]
    /\ job' = job
    /\ UNCHANGED <<delivered, personRetries, sentUnapproved, faults>>

TransactionCommitFails(w) ==
    /\ worker[w].pc = "committing"
    /\ CanFault("commit_fails")
    /\ faults' = faults + 1
    /\ Fail(w)
    /\ UNCHANGED <<status, delivered, personRetries, sentUnapproved>>


GiveUpMarksFailed(w) ==
    /\ worker[w].pc = "giving_up"
    /\ lockHolder = 0
    /\ status' = IF status \in MarkSendFailedFrom THEN "send_failed" ELSE status
    /\ worker' = [worker EXCEPT ![w].pc = "settling_fail"]
    /\ job' = job
    /\ UNCHANGED <<lockHolder, delivered, personRetries, sentUnapproved, faults>>

GiveUpFails(w) ==
    /\ worker[w].pc = "giving_up"
    /\ CanFault("give_up_fails")
    /\ faults' = faults + 1
    /\ worker' = [worker EXCEPT ![w].pc = "settling_fail"]
    /\ job' = job
    /\ UNCHANGED <<status, lockHolder, delivered, personRetries, sentUnapproved>>

\* The worker process dies mid-attempt: Postgres rolls its transaction back and frees the
\* lock, and the job stays active until its lease runs out.
WorkerDies(w) ==
    /\ worker[w].pc # "idle"
    /\ CanFault("worker_dies")
    /\ faults' = faults + 1
    /\ lockHolder' = Release(w)
    /\ worker' = [worker EXCEPT ![w].pc = "idle"]
    /\ UNCHANGED <<status, job, delivered, personRetries, sentUnapproved>>

JobSettles(w) ==
    /\ worker[w].pc \in {"settling_complete", "settling_fail"}
    /\ job' = Settle(w, IF worker[w].pc = "settling_complete" THEN "complete" ELSE "fail")
    /\ worker' = [worker EXCEPT ![w].pc = "idle"]
    /\ UNCHANGED <<status, lockHolder, delivered, personRetries, sentUnapproved, faults>>

Next ==
    \/ PersonApproves \/ PersonRetriesSend \/ PersonDiscards
    \/ JobLeaseExpires
    \/ \E w \in Workers :
        \/ WorkerClaimsJob(w) \/ WorkerLocksAndChecks(w)
        \/ SmtpAccepts(w) \/ SmtpRejects(w) \/ SmtpReplyLost(w)
        \/ TransactionCommits(w) \/ TransactionCommitFails(w)
        \/ GiveUpMarksFailed(w) \/ GiveUpFails(w)
        \/ WorkerDies(w) \/ JobSettles(w)

Spec == Init /\ [][Next]_vars


\* The customer gets a reply at most once, unless a person asked to send it again.
NoResendWithoutPerson == delivered <= 1 + personRetries

\* Once nothing is left running, a reply that went out is shown as sent.
NoHiddenDelivery == (delivered > 0 /\ SendSettled) => status \in ToldItWent

\* An approved reply is always still being sent, or shown to a person.
NoSilentStall == status = "approved" => ~SendSettled

\* A reply goes out only while its draft is approved.
SentOnlyWhenApproved == ~sentUnapproved

=============================================================================
