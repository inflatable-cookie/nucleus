The Nucleus CLI gets its default transport from the shared client owner now, not
from the Paseo integration, so a T3Code-only or host-less checkout reaches the
service through the same connection, roll wait and compiled or source load as
before. The Paseo adapter supplies only the explicit `--via-paseo` bridge and
its own caller environment decoding, and nothing falls back from one transport
to the other.
