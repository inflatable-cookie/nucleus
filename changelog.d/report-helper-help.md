`nucleus helper report --help` no longer hangs. It prints the report fields and an
example heredoc and exits without reading stdin, and every other helper answers
`--help` and `-h` the same way. The report helper also stops waiting for input it
will never get: a terminal, an empty stdin or a pipe that stays silent for 10
seconds ends it with an error that says how to pipe the report JSON. A report
refused for a wrong or missing field now names the field to use (for example
`head`, not `headSha`) and repeats the accepted shape.
