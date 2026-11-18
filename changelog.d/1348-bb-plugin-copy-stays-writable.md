A BB update needs no Nucleus action. `nucleus bb install` hands BB an owner-writable
copy of the packaged plugin, so BB's own frontend rebuild (what a BB 0.49 → 0.50.1
update does to every installed plugin) lands in it instead of failing with `EACCES`
and leaving the plugin without a frontend until someone ran `chmod -R u+w` and
reloaded it by hand. What is checked stays the Nucleus build identity the plugin
carries, not that bundle: `nucleus bb status` and the service's own build check
compare only `nucleus-build.json` against the running service, so a bundle BB
rebuilt itself is never a mismatch. A reinstall still installs a fresh copy rather
than editing the installed one in place.
