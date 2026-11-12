`tell` now returns once its message is recorded, waiting only briefly for a fast delivery. Slow
deliveries continue in the background, and receipts include their recorded time. Retrying the same
tell returns its recorded outcome without sending twice; timeout text explains this behavior.
