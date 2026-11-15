------------------------------- MODULE Gate -------------------------------
EXTENDS Naturals, Sequences

CONSTANTS
    Agents,       \* agents that can claim the conversation and propose actions
    People,       \* people who can take over, review and approve
    Payloads,     \* what an action does, such as the text of a reply
    MaxTime,      \* the last value the clock reaches
    ClaimTTL,     \* how long a claim lasts after it is taken or renewed
    MaxClaims,    \* how many claims and takeovers one behaviour may have
    MaxMessages,  \* how many customer messages arrive
    MaxProposals, \* how many proposals the gate accepts
    MaxTampers,   \* how many times something outside the lifecycle changes a stored action
    MaxResends    \* how many times a person may send one proposal again

None == "none"

Actors == Agents \cup People

Statuses == {"pending", "stale", "approved", "done", "uncertain", "refused"}

VARIABLES
    now,                   \* the injected Clock
    version,               \* the conversation version, one more for each customer message
    claim,                 \* the conversation's one claim; epoch is its fencing token
    work,                  \* what each agent read before its slow AI step
    proposals,             \* every proposal the gate accepted, in order
    tampers,               \* stored actions changed outside the lifecycle so far
    writtenByNonHolder,    \* TRUE once a proposal was accepted or edited by an actor without the live claim
    claimTakenFromHolder,  \* TRUE once an agent took the claim while someone held it live
    acceptedStale,         \* TRUE once a proposal was accepted while based on an older version
    approvedStale          \* TRUE once a proposal was approved while based on an older version

vars == <<now, version, claim, work, proposals, tampers,
          writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

Approvers == People

AfterLostOutcome == "uncertain"

Holds(x) == claim.owner = x /\ now < claim.expires

ClaimGuard == ~(now < claim.expires)

EditGuard(a) == Holds(a)

SubmitGuard(a) ==
    /\ work[a].epoch = claim.epoch
    /\ now < claim.expires
    /\ work[a].version = version

ApproveGuard(x, i) == proposals[i].payload = proposals[i].reviewed[x]

ExecuteGuard(i) == proposals[i].payload = proposals[i].approvedPayload

OnCustomerMessage(p) == IF p.status = "pending" THEN [p EXCEPT !.status = "stale"] ELSE p

Proposal ==
    [version : 0..MaxMessages, payload : Payloads, status : Statuses,
     reviewed : [Approvers -> Payloads \cup {None}],
     approvedPayload : Payloads \cup {None}, approvedBy : Approvers \cup {None},
     effects : Nat, ran : SUBSET Payloads, resends : 0..MaxResends]

TypeOK ==
    /\ now \in 0..MaxTime
    /\ version \in 0..MaxMessages
    /\ claim \in [owner : Actors \cup {None}, epoch : 0..MaxClaims, expires : 0..(MaxTime + ClaimTTL)]
    /\ work \in [Agents -> [busy : BOOLEAN, epoch : 0..MaxClaims, version : 0..MaxMessages]]
    /\ Len(proposals) <= MaxProposals
    /\ \A i \in DOMAIN proposals : proposals[i] \in Proposal
    /\ tampers \in 0..MaxTampers
    /\ {writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale} \subseteq BOOLEAN

Idle == [busy |-> FALSE, epoch |-> 0, version |-> 0]

Init ==
    /\ now = 0
    /\ version = 0
    /\ claim = [owner |-> None, epoch |-> 0, expires |-> 0]
    /\ work = [a \in Agents |-> Idle]
    /\ proposals = <<>>
    /\ tampers = 0
    /\ writtenByNonHolder = FALSE
    /\ claimTakenFromHolder = FALSE
    /\ acceptedStale = FALSE
    /\ approvedStale = FALSE

Set(i, field, value) == [proposals EXCEPT ![i][field] = value]


Tick ==
    /\ now < MaxTime
    /\ now' = now + 1
    /\ UNCHANGED <<version, claim, work, proposals, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

CustomerWrites ==
    /\ version < MaxMessages
    /\ version' = version + 1
    /\ proposals' = [i \in DOMAIN proposals |-> OnCustomerMessage(proposals[i])]
    /\ UNCHANGED <<now, claim, work, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

\* One conditional update, which takes the claim only when no claim is live.
Claim(a) ==
    /\ ClaimGuard
    /\ claim.epoch < MaxClaims
    /\ claim' = [owner |-> a, epoch |-> claim.epoch + 1, expires |-> now + ClaimTTL]
    /\ claimTakenFromHolder' = (claimTakenFromHolder \/ Holds(claim.owner))
    /\ UNCHANGED <<now, version, work, proposals, tampers,
                   writtenByNonHolder, acceptedStale, approvedStale>>

PersonTakesOver(p) ==
    /\ claim.epoch < MaxClaims
    /\ claim' = [owner |-> p, epoch |-> claim.epoch + 1, expires |-> now + ClaimTTL]
    /\ UNCHANGED <<now, version, work, proposals, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

Renew(x) ==
    /\ Holds(x)
    /\ claim' = [claim EXCEPT !.expires = now + ClaimTTL]
    /\ UNCHANGED <<now, version, work, proposals, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

AgentReads(a) ==
    /\ Holds(a)
    /\ ~work[a].busy
    /\ work' = [work EXCEPT ![a] = [busy |-> TRUE, epoch |-> claim.epoch, version |-> version]]
    /\ UNCHANGED <<now, version, claim, proposals, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

\* The guard and the insert are one conditional write. An accepted proposal replaces the
\* pending ones, as createReply discards them. The ghost flags record the true state, not the
\* guard's answer.
AgentSubmits(a, x) ==
    /\ work[a].busy
    /\ Len(proposals) < MaxProposals
    /\ work' = [work EXCEPT ![a] = Idle]
    /\ IF SubmitGuard(a)
       THEN /\ proposals' =
                  [i \in DOMAIN proposals |->
                      IF proposals[i].status = "pending"
                      THEN [proposals[i] EXCEPT !.status = "stale"]
                      ELSE proposals[i]]
                  \o <<[version |-> work[a].version, payload |-> x, status |-> "pending",
                        reviewed |-> [r \in Approvers |-> None],
                        approvedPayload |-> None, approvedBy |-> None,
                        effects |-> 0, ran |-> {}, resends |-> 0]>>
            /\ writtenByNonHolder' = (writtenByNonHolder \/ ~Holds(a))
            /\ acceptedStale' = (acceptedStale \/ work[a].version # version)
       ELSE UNCHANGED <<proposals, writtenByNonHolder, acceptedStale>>
    /\ UNCHANGED <<now, version, claim, tampers, claimTakenFromHolder, approvedStale>>

AgentEdits(a, i, x) ==
    /\ i \in DOMAIN proposals
    /\ EditGuard(a)
    /\ proposals[i].status = "pending"
    /\ proposals[i].payload # x
    /\ proposals' = Set(i, "payload", x)
    /\ writtenByNonHolder' = (writtenByNonHolder \/ ~Holds(a))
    /\ UNCHANGED <<now, version, claim, work, tampers,
                   claimTakenFromHolder, acceptedStale, approvedStale>>

Review(r, i) ==
    /\ i \in DOMAIN proposals
    /\ proposals[i].status = "pending"
    /\ proposals[i].reviewed[r] # proposals[i].payload
    /\ proposals' = [proposals EXCEPT ![i].reviewed[r] = proposals[i].payload]
    /\ UNCHANGED <<now, version, claim, work, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

Approve(r, i) ==
    /\ i \in DOMAIN proposals
    /\ proposals[i].status = "pending"
    /\ ApproveGuard(r, i)
    /\ proposals' = [proposals EXCEPT ![i].status = "approved",
                                      ![i].approvedPayload = proposals[i].payload,
                                      ![i].approvedBy = r]
    /\ approvedStale' = (approvedStale \/ proposals[i].version # version)
    /\ UNCHANGED <<now, version, claim, work, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale>>

Tamper(i, x) ==
    /\ i \in DOMAIN proposals
    /\ tampers < MaxTampers
    /\ proposals[i].status \in {"approved", "uncertain"}
    /\ proposals[i].payload # x
    /\ proposals' = Set(i, "payload", x)
    /\ tampers' = tampers + 1
    /\ UNCHANGED <<now, version, claim, work,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

Execute(i) ==
    /\ i \in DOMAIN proposals
    /\ proposals[i].status = "approved"
    /\ ExecuteGuard(i)
    /\ proposals' = [proposals EXCEPT ![i].status = "done",
                                      ![i].effects = @ + 1,
                                      ![i].ran = @ \cup {proposals[i].payload}]
    /\ UNCHANGED <<now, version, claim, work, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

\* The effect may or may not have happened, and the executor can't tell which.
ExecuteOutcomeLost(i) ==
    /\ i \in DOMAIN proposals
    /\ proposals[i].status = "approved"
    /\ ExecuteGuard(i)
    /\ \E happened \in BOOLEAN :
          proposals' = [proposals EXCEPT
                           ![i].status = AfterLostOutcome,
                           ![i].effects = @ + (IF happened THEN 1 ELSE 0),
                           ![i].ran = @ \cup (IF happened THEN {proposals[i].payload} ELSE {})]
    /\ UNCHANGED <<now, version, claim, work, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

ExecuteRefuses(i) ==
    /\ i \in DOMAIN proposals
    /\ proposals[i].status = "approved"
    /\ ~ExecuteGuard(i)
    /\ proposals' = Set(i, "status", "refused")
    /\ UNCHANGED <<now, version, claim, work, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

PersonResends(i) ==
    /\ i \in DOMAIN proposals
    /\ proposals[i].status = "uncertain"
    /\ proposals[i].resends < MaxResends
    /\ proposals' = [proposals EXCEPT ![i].status = "approved", ![i].resends = @ + 1]
    /\ UNCHANGED <<now, version, claim, work, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

PersonConfirms(i) ==
    /\ i \in DOMAIN proposals
    /\ proposals[i].status = "uncertain"
    /\ proposals' = Set(i, "status", "done")
    /\ UNCHANGED <<now, version, claim, work, tampers,
                   writtenByNonHolder, claimTakenFromHolder, acceptedStale, approvedStale>>

Next ==
    \/ Tick \/ CustomerWrites
    \/ \E a \in Agents : Claim(a) \/ AgentReads(a) \/ \E x \in Payloads : AgentSubmits(a, x)
    \/ \E p \in People : PersonTakesOver(p)
    \/ \E x \in Actors : Renew(x)
    \/ \E i \in 1..MaxProposals :
          \/ Execute(i) \/ ExecuteOutcomeLost(i) \/ ExecuteRefuses(i)
          \/ PersonResends(i) \/ PersonConfirms(i)
          \/ \E r \in Approvers : Review(r, i) \/ Approve(r, i)
          \/ \E x \in Payloads : Tamper(i, x) \/ \E a \in Agents : AgentEdits(a, i, x)

Spec == Init /\ [][Next]_vars


\* Every accepted or edited proposal came from the actor holding the live claim at that moment,
\* and no agent takes the claim from someone who holds it live.
OneWriter == ~writtenByNonHolder /\ ~claimTakenFromHolder

\* No proposal is accepted or approved while based on an older conversation version.
LatestVersionOnly == ~acceptedStale /\ ~approvedStale

\* What ran is exactly what was approved, and what was approved is exactly what the approver
\* reviewed.
ApprovedMeansThatAction ==
    \A i \in DOMAIN proposals :
        /\ proposals[i].ran \subseteq {proposals[i].approvedPayload}
        /\ proposals[i].approvedBy # None =>
              proposals[i].approvedPayload = proposals[i].reviewed[proposals[i].approvedBy]

\* An action takes effect at most once per approval plus person resends.
NoAutomaticResend ==
    \A i \in DOMAIN proposals :
        proposals[i].effects <= (IF proposals[i].approvedBy = None THEN 0 ELSE 1) + proposals[i].resends

\* Every approval was made by a person.
OnlyPeopleApprove == \A i \in DOMAIN proposals : proposals[i].approvedBy \in People \cup {None}

=============================================================================
