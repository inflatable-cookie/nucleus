The Rust engine's Effigy checks and release builds use Oxide's shared build
cache. Release staging keeps the installed binary and board assets in the
configured builds root so Cargo cache cleanup leaves the current and rollback releases
available.
