# R25: video invitations, call restoration and attended handover

R24 opened video in the same task as singleTask MainActivity. Returning to chat could destroy the WebView and end the room; reopening from the video button/notification also omitted its invitation extras. R25 gives video a separate task and a single in-process session descriptor, reused by both entry points. A new explicit call after process death can replace only that enrolled device's abandoned room.

The video button now sends one customer invitation through the existing authenticated Odoo message_post path, bound to the chat and user at the original tap. Duplicate callbacks, chat changes, closed WhatsApp windows and ambiguous send responses do not resend or retarget the message. Operator capabilities never enter customer messages. Odoo confirmation is shown as invitation sent, not handset delivery confirmation.

New customer invitations use a 144-bit random /v/ path under 70 characters. Link previews can resolve the page without claiming a participant. Joining still needs a deliberate customer action and camera/microphone permission. A customer permission refusal cannot claim the link and block opening it in Chrome. R24 fragment links remain supported. Short links expire with their in-memory room; a Render restart still expires pending invitations.

The video screen starts the operator camera after native permission, shows the selected customer, invitation status, waiting state and compact controls, and provides chat, copy/share and End actions. End works while relay preparation is still pending. Embedded Android browsers without media access receive a user-clicked Chrome handoff.

Attended handover previously released hold audio as soon as Complete selected the customer route, before the destination's verified media readiness. Hold now continues until ownership commits. The old source leg closes before applying any new microphone routing, and reports Transferred. Regression coverage checks that source cleanup cannot end the new owner and that the destination retains its joined leg.

Validation uses synthetic customers only. The separate Render verifier tests real local WebRTC peers and hold/private/conference/Complete audio, without production account credentials. Automated tests do not certify physical phones, WhatsApp link handling, external TURN media paths or a fixed real-network latency cap.
