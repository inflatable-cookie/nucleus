The local web board now keeps a stable loopback URL across service restarts, pairs
browser links into persistent HttpOnly sessions, and reconnects reads and live
updates when the service returns. Busy preferred ports fall back with a clear
notice, and `nucleus ui --revoke` clears all paired sessions.
