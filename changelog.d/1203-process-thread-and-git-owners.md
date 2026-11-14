Process custody, thread archive and Git now have one owner per mechanism, and no
module in those areas is a grab bag: the host process table read, the pure sweep
selection, the owned-tool provider proof and the terminal sweep are separate
modules; process identity search, group custody, the Darwin `ps` reads and the
CPU sampler are separate modules with one `/proc` stat parser and one `lstart`
parser; the thread archive's durable effect, its closeout lane, its replacement
lanes and the ownership rule that was inline in four places are separate modules;
and `core/git/index.ts` is a re-export barrel over the runner, remote, checkout,
submission, dispatch, stash and proof owners. An unreadable host process table is
now a typed unknown that leaves the durable sweep intent owed instead of reading
as an empty pass, an unreadable ancestry is named instead of read as divergence,
an undecodable owned-tool event is skipped instead of read as a run id, and
archive retryability comes from the transport owner rather than a message regex.
Behaviour is otherwise unchanged.
