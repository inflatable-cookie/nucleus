Intake-owned review-entry workspaces outside Queue allocation roots now pass
admission when their recorded workspace ID and directory match the immutable
review-entry record. Their own volume is checked, and closeout still archives
the workspace entry.
