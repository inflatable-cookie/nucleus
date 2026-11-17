### BB host: operator install route

The Nucleus package ships the built BB plugin, and `nucleus bb install` installs it
into the operator's BB under plugin ID `nucleus`; `nucleus bb status` reports the
installed plugin against the running service's build, and `nucleus bb uninstall`
removes it. The plugin is pinned to the service build: after a roll, a connection
from another build is refused with a message naming both builds and the fix, and
the board shows the BB host unavailable with that reason. No other plugin is read,
written or removed, and a namesake plugin with ID `nucleus` is refused rather than
overwritten. The README's BB section carries the operator steps.
