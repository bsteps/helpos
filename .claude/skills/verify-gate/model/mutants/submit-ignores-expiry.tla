\* A submit checks the claim's epoch but not when it expires, so an owner whose claim ran out still writes.
\* breaks: OneWriter

SubmitGuard(a) ==
    /\ work[a].epoch = claim.epoch
    /\ work[a].version = version
