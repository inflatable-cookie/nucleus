//! Host-independent application service boundary.

use nucleus_core::PersistenceRecordId;

/// Engine-visible state domains for the first read-model migration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineStateDomain {
    Projects,
    Tasks,
    Workspaces,
}

/// Engine read-model query scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineReadScope {
    Get(PersistenceRecordId),
    List,
    UnsupportedIndex,
}

/// Engine read-model record set.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EngineReadRecordSet<R> {
    pub domain: EngineStateDomain,
    pub records: Vec<R>,
}

/// Repository port used by host-independent read-model services.
pub trait EngineStateRecordReader {
    type Error;
    type Record;

    fn get(
        &self,
        domain: EngineStateDomain,
        id: &PersistenceRecordId,
    ) -> Result<Option<Self::Record>, Self::Error>;

    fn list(&self, domain: EngineStateDomain) -> Result<Vec<Self::Record>, Self::Error>;
}

/// First engine read-model service.
#[derive(Clone, Debug)]
pub struct EngineReadModelService<R> {
    reader: R,
}

impl<R> EngineReadModelService<R>
where
    R: EngineStateRecordReader,
{
    pub fn new(reader: R) -> Self {
        Self { reader }
    }

    pub fn read(
        &self,
        domain: EngineStateDomain,
        scope: EngineReadScope,
    ) -> Result<EngineReadRecordSet<R::Record>, EngineReadModelError<R::Error>> {
        let records = match scope {
            EngineReadScope::Get(id) => match self
                .reader
                .get(domain.clone(), &id)
                .map_err(EngineReadModelError::Reader)?
            {
                Some(record) => vec![record],
                None => {
                    return Err(EngineReadModelError::NotFound { id });
                }
            },
            EngineReadScope::List => self
                .reader
                .list(domain.clone())
                .map_err(EngineReadModelError::Reader)?,
            EngineReadScope::UnsupportedIndex => Vec::new(),
        };

        Ok(EngineReadRecordSet { domain, records })
    }
}

/// Engine read-model failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum EngineReadModelError<E> {
    NotFound { id: PersistenceRecordId },
    Reader(E),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Debug)]
    struct FixtureReader {
        records: Vec<(EngineStateDomain, PersistenceRecordId, &'static str)>,
    }

    impl EngineStateRecordReader for FixtureReader {
        type Error = &'static str;
        type Record = &'static str;

        fn get(
            &self,
            domain: EngineStateDomain,
            id: &PersistenceRecordId,
        ) -> Result<Option<Self::Record>, Self::Error> {
            Ok(self
                .records
                .iter()
                .find_map(|(record_domain, record_id, value)| {
                    if *record_domain == domain && record_id == id {
                        Some(*value)
                    } else {
                        None
                    }
                }))
        }

        fn list(&self, domain: EngineStateDomain) -> Result<Vec<Self::Record>, Self::Error> {
            Ok(self
                .records
                .iter()
                .filter_map(|(record_domain, _id, value)| {
                    if *record_domain == domain {
                        Some(*value)
                    } else {
                        None
                    }
                })
                .collect())
        }
    }

    #[test]
    fn read_model_lists_domain_records_through_reader_port() {
        let service = EngineReadModelService::new(FixtureReader {
            records: vec![
                (
                    EngineStateDomain::Projects,
                    PersistenceRecordId("project:1".to_owned()),
                    "project-one",
                ),
                (
                    EngineStateDomain::Tasks,
                    PersistenceRecordId("task:1".to_owned()),
                    "task-one",
                ),
            ],
        });

        let records = service
            .read(EngineStateDomain::Projects, EngineReadScope::List)
            .expect("list projects");

        assert_eq!(records.records, vec!["project-one"]);
    }

    #[test]
    fn read_model_reports_missing_record_without_fabricating_empty_get() {
        let service = EngineReadModelService::new(FixtureReader {
            records: Vec::new(),
        });
        let missing_id = PersistenceRecordId("project:missing".to_owned());

        let error = service
            .read(
                EngineStateDomain::Projects,
                EngineReadScope::Get(missing_id.clone()),
            )
            .expect_err("missing record should fail");

        assert_eq!(error, EngineReadModelError::NotFound { id: missing_id });
    }
}
