The environment a spawned service reads from its host now comes from one service
composition owner instead of Paseo-named options shared with the roll. A
T3Code-only or host-less install rolls exactly as before, a Paseo fixture still
points its service at a private Paseo home, and the installer's isolated startup
proof reads a private host config. The explicit Paseo registration and reload
routes are unchanged; `nucleus recover-previous` names the connected host's
reload command instead of presuming Paseo.
