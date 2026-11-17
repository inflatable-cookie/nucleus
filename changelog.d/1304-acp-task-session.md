Nucleus now ships a host-agnostic ACP agent (`nucleus-acp`, or `nucleus acp.bind` to
mint one) that any ACP-capable app can register as a provider. A session of it is one
Nucleus task's thread with no model: it shows the task's lifecycle, forwards the
operator's messages through Nucleus's own message route, and holds or releases its turn
when the service says so. `acp.bind` mints the owner-only binding and the agent reads it
from the checkout, so a session is never bound by text in a prompt. Spec 065 owns the
design.
