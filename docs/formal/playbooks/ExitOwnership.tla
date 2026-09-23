------------------------- MODULE ExitOwnership -------------------------
EXTENDS Naturals

CONSTANT GuardInsideTransaction
VARIABLES lifecycle, alive, reaped, replacing, callback, restate, shutdown
vars == <<lifecycle, alive, reaped, replacing, callback, restate, shutdown>>

CapacityStates == {"Starting", "Running", "Interrupted", "Finishing"}

Init == /\ lifecycle = "Running"
        /\ alive = {"old"}
        /\ reaped = FALSE
        /\ replacing = FALSE
        /\ callback = "waiting"
        /\ restate = "idle"
        /\ shutdown = FALSE

\* The reader publishes its reap/drain proof before committing durable exit.
ReapOld == /\ "old" \in alive
           /\ alive' = alive \ {"old"}
           /\ reaped' = TRUE
           /\ UNCHANGED <<lifecycle, replacing, callback, restate, shutdown>>

CheckExit == /\ reaped /\ ~replacing /\ callback = "waiting"
             /\ callback' = "checked"
             /\ UNCHANGED <<lifecycle, alive, reaped, replacing, restate, shutdown>>

BeginRestate == /\ restate = "idle"
                /\ replacing' = TRUE
                /\ restate' = "flagged"
                /\ UNCHANGED <<lifecycle, alive, reaped, callback, shutdown>>

\* Each durable transition is atomic under the repository mutation lock.
ReserveRestate == /\ restate = "flagged" /\ lifecycle = "Running"
                  /\ lifecycle' = "Interrupted"
                  /\ restate' = "reserved"
                  /\ UNCHANGED <<alive, reaped, replacing, callback, shutdown>>

AbortRestate == /\ restate = "flagged" /\ lifecycle # "Running"
                /\ restate' = "done"
                /\ replacing' = FALSE
                /\ UNCHANGED <<lifecycle, alive, reaped, callback, shutdown>>

PrepareReplacement == /\ restate = "reserved" /\ reaped
                      /\ lifecycle' = "Starting"
                      /\ restate' = "prepared"
                      /\ UNCHANGED <<alive, reaped, replacing, callback, shutdown>>

\* Same session ID, different process. Its old replacing flag stays TRUE.
SpawnReplacement == /\ restate = "prepared" /\ lifecycle = "Starting"
                    /\ lifecycle' = "Running"
                    /\ alive' = alive \cup {"new"}
                    /\ restate' = "done"
                    /\ UNCHANGED <<reaped, replacing, callback, shutdown>>

CommitOldExit == /\ callback = "checked"
                 /\ callback' = "done"
                 /\ IF GuardInsideTransaction /\ replacing
                       THEN UNCHANGED <<lifecycle, shutdown>>
                       ELSE /\ lifecycle' = "Failed"
                            /\ shutdown' = TRUE
                 /\ UNCHANGED <<alive, reaped, replacing, restate>>

Next == ReapOld \/ CheckExit \/ BeginRestate \/ ReserveRestate
        \/ AbortRestate \/ PrepareReplacement \/ SpawnReplacement \/ CommitOldExit

Spec == Init /\ [][Next]_vars
TypeOK == /\ lifecycle \in CapacityStates \cup {"Failed"}
          /\ alive \subseteq {"old", "new"}
          /\ reaped \in BOOLEAN /\ replacing \in BOOLEAN /\ shutdown \in BOOLEAN
          /\ callback \in {"waiting", "checked", "done"}
          /\ restate \in {"idle", "flagged", "reserved", "prepared", "done"}
ShutdownMeansStopped == shutdown => alive = {}
LiveKeepsCapacity == alive # {} => lifecycle \in CapacityStates
=======================================================================
