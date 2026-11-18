`nucleus t3 install`, `status` and `uninstall` connect a T3Code environment in
one command: they mint the service's orchestration-only bearer, register the
installed `nucleus-acp` command as the `nucleus` ACP provider through T3's own
settings route, report each fact without a secret, and remove exactly what they
added. The service adopts the connection without a restart, and a provider
instance that is not this install's is refused by name rather than overwritten.
