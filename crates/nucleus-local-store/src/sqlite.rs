//! SQLite backend for first server-local storage domains.
//!
//! Module index over the SQLite surface: the backend adapter, the repository,
//! connection hygiene, schema, and table mapping.

mod backend;
mod connection;
mod kinds;
mod repository;
mod schema;
mod table;
#[cfg(test)]
mod tests;

pub use backend::{SqliteBackend, SqliteStoreBoundary};
pub use repository::SqliteRepository;
