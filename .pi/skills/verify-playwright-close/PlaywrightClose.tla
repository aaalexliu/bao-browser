------------------------- MODULE PlaywrightClose -------------------------
EXTENDS Naturals, FiniteSets

CONSTANT ReuseCompletion

Callers == {"disconnect", "close", "closeAgain"}
Stages == {"absent", "queued", "request", "release", "detach", "settled"}

VARIABLES phase, completion, returned, jobs
vars == <<phase, completion, returned, jobs>>

Init ==
  /\ phase = "running"
  /\ completion = "none"
  /\ returned = [c \in Callers |-> "none"]
  /\ jobs = [c \in Callers |-> "absent"]

Request(c) ==
  /\ returned[c] = "none"
  /\ IF phase = "settled" \/ (phase = "closing" /\ ReuseCompletion)
        THEN /\ returned' = [returned EXCEPT ![c] = completion]
             /\ UNCHANGED <<phase, completion, jobs>>
        ELSE /\ returned' = [returned EXCEPT ![c] = c]
             /\ completion' = c
             /\ phase' = "closing"
             /\ jobs' = [jobs EXCEPT ![c] = "queued"]

Start(c) ==
  /\ jobs[c] = "queued"
  /\ jobs' = [jobs EXCEPT ![c] = "request"]
  /\ UNCHANGED <<phase, completion, returned>>

BrowserCloseReturns(c) ==
  /\ jobs[c] = "request"
  /\ jobs' = [jobs EXCEPT ![c] = "release"]
  /\ UNCHANGED <<phase, completion, returned>>

ReleaseReturns(c) ==
  /\ jobs[c] = "release"
  /\ jobs' = [jobs EXCEPT ![c] = "detach"]
  /\ UNCHANGED <<phase, completion, returned>>

Settle(c) ==
  /\ jobs[c] \in {"request", "release", "detach"}
  /\ jobs' = [jobs EXCEPT ![c] = "settled"]
  /\ phase' = "settled"
  /\ completion' = c
  /\ UNCHANGED returned

Done ==
  /\ \A c \in Callers : returned[c] # "none" /\ jobs[c] \in {"absent", "settled"}
  /\ UNCHANGED vars

Next ==
  (\E c \in Callers : Request(c))
  \/ (\E c \in Callers : Start(c))
  \/ (\E c \in Callers : BrowserCloseReturns(c))
  \/ (\E c \in Callers : ReleaseReturns(c))
  \/ (\E c \in Callers : Settle(c))
  \/ Done

TypeOK ==
  /\ phase \in {"running", "closing", "settled"}
  /\ completion \in Callers \cup {"none"}
  /\ returned \in [Callers -> Callers \cup {"none"}]
  /\ jobs \in [Callers -> Stages]

OneShutdownCompletion ==
  /\ Cardinality({c \in Callers : jobs[c] # "absent"}) <= 1
  /\ Cardinality({returned[c] : c \in Callers} \ {"none"}) <= 1

=============================================================================
