//! Ratchet on nucleus-server's module count (contract 022 / audit band).
//!
//! The server must shrink as engine and orchestration absorb its logic.
//! Raising the ceiling requires a deliberate edit here; lowering it as
//! modules migrate out is encouraged.

// Baseline at ratchet introduction (2026-07-18). Lower it as modules
// migrate out; never raise it without a contract-022 discussion.
const MODULE_CEILING: usize = 322;

#[test]
fn server_top_level_module_count_does_not_grow() {
    let lib = include_str!("../src/lib.rs");
    let count = lib
        .lines()
        .filter(|line| line.starts_with("pub mod ") || line.starts_with("mod "))
        .count();

    assert!(
        count <= MODULE_CEILING,
        "nucleus-server declares {count} top-level modules (ceiling {MODULE_CEILING}); \
         move logic toward nucleus-engine/nucleus-orchestration instead of adding modules"
    );
}
