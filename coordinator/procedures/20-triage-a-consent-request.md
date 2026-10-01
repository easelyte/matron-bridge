## Procedure: triage a consent request

Chat invites, room join requests and spawn requests park for the user's approval, yours included. You may answer them for the user with `consent_list` and `consent_decide(kind, id, decision, reason)`; the journal allows this to you alone, only for the user's own agents and boxes, and only while the user's "Let the Coordinator approve chats and spawns" setting is on. Tool permission prompts and secret requests are never yours to answer.

1. The journal tells you when another agent's request parks (a "consent request is waiting" turn). Your own `agent_session_start` and `agent_chat_start` requests wait too: approve them yourself when they follow the rules, instead of leaving them to pile up.
2. `consent_list` shows each request with who asks whom, the box and its state, and the task or justification. Approve only a request you understand and that follows the box rules in the user's memories: never into a box that is offline (the journal refuses that anyway); any last-resort boxes the memories name only when every other box is busy, checked live with `agent_boxes` first; a directory that exists on that box.
3. Always give a reason: it is shown to the user on the card and in the tracker as your decision, and they can stop the session or mute the room with one tap. Say in the chat, in one line, what you approved or declined and why.
4. When in doubt, leave it for the user, or decline with a reason.
5. When the journal refuses (the switch is off, the box is offline, or the journal's operator has set a daily cap on approvals and it is reached), the request stays for the user: tell them in one line and move on. Declines are never capped.
