# R23 provider-event wake-up fix

A trusted customer Answer, SDP connection event, or Hang-up previously committed to the server without waking the connected operator room. R23 already understood a direct room wake, but those provider-event paths relied on its next status poll. This fix sends the existing content-free operator wake immediately after the event transaction commits.

The hint only asks the phone to fetch authenticated current state. It cannot answer, end, transfer, or mark audio Connected. A terminal event during transfer targets the exact source and destination operator identities; the customer receives no control packet. Duplicate event IDs and repeated same-state events do not send additional wakes. Failed database commits send none, and unavailable hint delivery cannot block the webhook or durable cleanup. No new idle polling, database listener, or database read was added to event handling.

Status authentication and its independent session lookup now run concurrently through the existing authenticated lookup helper. Authentication still gates every response, and a rejected credential cannot see lookup results.

This is a backend update for the existing signed R23 APK. No Android rebuild or Odoo embed change is required. The published Odoo embed was separately compared with the current repository scripts and matches. AI remains disabled.

Validation passed: 1,011 backend/browser checks, 19 real-room media scenarios, and the hold/private-consultation/recording check. The three new event-to-room wake measurements were 117 ms (SDP), 121 ms (Answer), and 121 ms (Hang-up) in the isolated run. Details are recorded in [provider-event-verification.json](provider-event-verification.json). The simulator uses real SFU/WebRTC audio, generated tones and a Firestore emulator; provider events and the WhatsApp connector are synthetic. These measurements are not physical handset or Meta/FCM end-to-end latency.

The review also confirmed existing call priorities: the device picker prefetches and uses a bounded cache, local mute/speaker actions do not await a backend request, terminal controls have their own request lane, and transfer signaling does not wait for notes or recording archival. SDK audio-release and genuine media/ownership checks remain required. Provider transport, network and handset wake-up delays still prevent a universal instantaneous or sub-two-second guarantee.
