# Profile Cost is removed and Weight is a five-stop rotation slider

The profile editor no longer has a Cost rating or a numeric Weight stepper
(Tom, 2026-11-21). Weight is now a five-stop slider in the former Cost position,
beside Capability: Fewest, Fewer, Default, More and Most, with Default at the
centre for every new profile.

- **What a stop does.** Each notch moves the profile's relative rotation share by
  one fixed step from Default (80%, 90%, 100%, 110%, 120%). It only orders
  rotation among profiles already eligible; it never admits or excludes one and
  is not a percentage of all work. Equal weights now rotate equally whatever a
  profile's old cost.
- **One rule everywhere.** Selection and the routing diagnostics use the same
  share. Cost-only filters in non-delivery routing and transient recovery are
  gone, as is the cost wording in recovery prompts and diagnostics.
- **Saved profiles.** Existing profiles and recorded diagnostics still load: the
  old weight 1 reads as Default, 2 as More and 3–10 as Most (a deliberate
  compression of the old range), and the old Cost value is discarded. Nothing
  stored is rewritten; the next profile save writes only the new form.
