\* A submit checks the claim but not that the conversation is still at the version the agent read.
\* breaks: LatestVersionOnly

SubmitGuard(a) ==
    /\ work[a].epoch = claim.epoch
    /\ now < claim.expires
