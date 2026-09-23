------------------------- MODULE ExitDelivery -------------------------
EXTENDS Naturals

CONSTANT RetryBusy
VARIABLES lock, process, pending, shutdown
vars == <<lock, process, pending, shutdown>>

\* Begin during one unrelated repository transaction. It eventually releases.
Init == /\ lock = TRUE /\ process = "live"
        /\ pending = FALSE /\ shutdown = FALSE
Reap == /\ process = "live"
        /\ process' = "reaped" /\ pending' = TRUE
        /\ UNCHANGED <<lock, shutdown>>
Release == /\ lock /\ lock' = FALSE
           /\ UNCHANGED <<process, pending, shutdown>>
Attempt == /\ pending
           /\ IF lock
                 THEN /\ pending' = RetryBusy
                      /\ UNCHANGED shutdown
                 ELSE /\ pending' = FALSE /\ shutdown' = TRUE
           /\ UNCHANGED <<lock, process>>
Next == Reap \/ Release \/ Attempt

\* Fairness: the process exits, the unrelated lock releases, and the callback
\* is scheduled again. Permanent I/O failure and daemon crash are excluded.
Spec == Init /\ [][Next]_vars
        /\ WF_vars(Reap) /\ WF_vars(Release) /\ WF_vars(Attempt)
TypeOK == /\ lock \in BOOLEAN /\ pending \in BOOLEAN /\ shutdown \in BOOLEAN
          /\ process \in {"live", "reaped"}
ShutdownMeansReaped == shutdown => process = "reaped"
ExitEventuallyRecorded == (process = "reaped") ~> shutdown
=======================================================================
