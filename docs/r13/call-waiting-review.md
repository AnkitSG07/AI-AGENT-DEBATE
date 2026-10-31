# R13 native call waiting review

The native incoming screen now offers **End current & answer** when a different
call is active. **Decline** still applies only to the waiting call and keeps the
current call connected. This is implemented in the actual Activity and service,
with authenticated runtime availability observations and atomic server claims.

## Transition and identity

The button captures the active service's client attempt ID and ownership leg
when displayed. A delayed tap cannot adopt a replacement call or a later leg of
the same transferred call.

The transition first reads the exact waiting call from the authenticated status
route. The current audio continues during this check. An ended, already owned,
mismatched or expired incoming call, an invalid transfer invitation, or a failed
status request does not end the current call. After the asynchronous read, the
Activity checks the captured attempt, ownership leg, enrollment identity and
current screen again before invoking local End.

After End, the Activity reads status again. It waits for the old service instance
to be destroyed and for the durable reservation to permit the exact next call.
A local End acknowledgement, or merely closing the old microphone, is not proof
that the server has released the device. The waiting transition is bounded to
30 seconds and offers an explicit retry if cleanup or connectivity remains
unresolved. New intents, terminal alerts, enrollment changes and destruction
invalidate pending continuations. A late microphone permission result cannot
start a canceled or replacement call.

Ordinary incoming calls use the `deviceAvailable` observation. A valid transfer
already reserves its target, so it uses the separate `deviceAvailableForCall`
observation. That transfer field requires the current target's exact live
invitation reservation, canonical call ID, transfer ID, expiry, source ownership,
user and enrollment binding. A missing, old or unrelated reservation is not
treated as permission to free another call. Both observations remain advisory:
the server's atomic Accept operation is the final authority.

An outgoing request whose provider ID has not arrived can reserve the device
after an earlier availability read. The native service handles that narrow
`DEVICE_BUSY` race for an explicitly accepted ordinary incoming call by retrying
the same request ID for at most 15 seconds, bounded further by the incoming
alert's expiry. It does not redial, start the microphone before a join is issued,
or automatically reject an unowned waiting customer on exhaustion.

If the old call ends naturally and the waiting call has also ended, the screen
can offer an explicit callback. Switching to that dialer clears waiting cleanup
state, so pressing **Call** starts a new outgoing attempt rather than trying to
answer a terminal incoming call.

## Executed evidence

The current Android release suite executed **185 tests in 21 suites**, with zero
failures, errors or skips. Its **21 new waiting-call Activity/service cases** are
in `NativeRoomWaitingCallTest`. They exercise the actual production classes
under Robolectric; media and network effects are explicitly synthetic.

| Boundary | Named regression examples |
| --- | --- |
| Correct End, cleanup wait and single Answer | `endCurrentStopsOnlyCapturedAudioThenWaitsForDurableAvailabilityBeforeOneAnswer`; `freeServerObservationStillWaitsForClosedServiceDestruction` |
| Preserve the active call on failed or stale preflight | `failedIncomingPreflightPreservesCurrentAudioAndRequiresExplicitRetry`; `customerEndDuringPreflightPreservesExistingCall`; `serverEndedWaitingCallNeverStartsAfterOldAudioStops` |
| Captured active identity | `staleButtonCannotEndAReplacementAttempt`; `staleButtonCannotEndTheSameCallTransferredBackOnAnotherLeg`; `delayedPreflightCannotEndAReplacementActiveAttempt` |
| Waiting identity and other ownership | `mismatchedStatusCannotAuthorizeWaitingCallAnswer`; `callAnsweredOnAnotherPhoneNeverStartsHere`; `changedTransferInvitationCannotBeAcceptedAfterEndingSourceCall` |
| Exact transfer reservation | `exactWaitingTransferCanUseItsOwnInviteReservationWithoutClaimingDeviceGloballyFree`; `mismatchedTransferReservationPreservesCurrentCallDespiteValidLookingInvitation` |
| Terminal and permission races | `terminalNotificationDuringWaitingPermissionPromptWinsOverLateGrant`; `waitingCustomerEndDuringOldCallCleanupPreventsAnswer`; `cancelledWaitingAlertCannotEndCurrentCallWhenButtonIsTapped` |
| Replacement screen or enrollment | `delayedWaitingStatusCannotAnswerAfterReplacementIntent`; `replacementEnrollmentCancelsDelayedWaitingAuthorization` |
| Decline, compatibility and callback | `decliningWaitingCallKeepsCurrentAudioConnected`; `missingAvailabilityFromOldBackendFailsVisiblyWithoutSpeculativeAccept`; `endedWaitingCallCanBecomeExplicitCallbackAfterOldServiceEnds` |

Three additional current service lifecycle tests cover bounded `DEVICE_BUSY`
retry, cancellation before another retry and reuse of the exact request key.
Eight runtime availability tests cover own-device isolation, pending outgoing
reservations, durable cleanup, failed storage reads, stale observations,
busy-to-success replay, the exact live invitation and an invalid-reservation
matrix. The final actual local SFU/Firestore media suite also exercises ordinary
and exact invitation availability observations through the real HTTP routes.

Authoritative results:

- `android/operatorhub/verification/r13/recovered-system/android-junit/TEST-com.smarthandicrafts.operatorhub.NativeRoomWaitingCallTest.xml`
- `android/operatorhub/verification/r13/recovered-system/android-junit/TEST-com.smarthandicrafts.operatorhub.NativeRoomLifecycleRegressionTest.xml`
- `verification/r13/final/tests__simulator-media-r13__device-availability.test.mjs.tap`
- `verification/r13/current-media/raw/verification.json`

These results establish local control, identity and cleanup behavior. They do
not establish physical microphone shutdown latency, FCM delivery, Meta calling
permission, Bluetooth behavior, or a live two-phone waiting/transfer call. The
ordinary **End call** control remains a direct local stop; the combined waiting
action intentionally verifies the waiting call before ending the current one.
