//! AGENTS.md idioms source for the route-path opt-in (Contract 056).
//!
//! Parses a project's `AGENTS.md` into Project-scoped static idioms. The
//! memory system joins the same source as a secondary layer once it is
//! implemented; this module owns the parse and the layering seam.

use std::path::Path;
use std::sync::Arc;

use swallowtail_idioms::{
    BoundedText, Idiom, IdiomConstraint, IdiomId, IdiomScope, MonotonicInstant, Provenance,
    StaticRulesSource,
};
use swallowtail_runtime::IdiomSessionOption;

/// Maximum idioms folded from AGENTS.md into one session.
pub const MAX_AGENTS_MD_IDIOMS: usize = 8;
/// Maximum bytes of one AGENTS.md line kept as an idiom.
const MAX_LINE_BYTES: usize = 512;
/// Provenance source reference for AGENTS.md idioms.
const AGENTS_MD_SOURCE: &str = "AGENTS.md";

/// The route opt-in wiring for one session: an optional registered source
/// and an optional session option.
pub struct IdiomWiring {
    source: Option<Arc<dyn swallowtail_idioms::IdiomSource>>,
    option: Option<IdiomSessionOption>,
}

impl IdiomWiring {
    /// Returns the registered source, when enabled and AGENTS.md exists.
    #[must_use]
    pub fn source(&self) -> Option<Arc<dyn swallowtail_idioms::IdiomSource>> {
        self.source.clone()
    }

    /// Returns the session option, when enabled and AGENTS.md exists.
    #[must_use]
    pub fn option(&self) -> Option<IdiomSessionOption> {
        self.option.clone()
    }
}

/// Resolves the idioms opt-in wiring for one session.
///
/// When enabled and an `AGENTS.md` exists, the parsed records become a
/// static source and the session option is set. Disabled or absent file
/// yields no source and no option — the default route behavior.
#[must_use]
pub fn wiring(project_root: &Path, enabled: bool) -> IdiomWiring {
    if !enabled {
        return IdiomWiring {
            source: None,
            option: None,
        };
    }
    let records = agents_md_idioms(project_root, MonotonicInstant::from_ticks(0));
    if records.is_empty() {
        return IdiomWiring {
            source: None,
            option: None,
        };
    }
    IdiomWiring {
        source: Some(Arc::new(StaticRulesSource::new(records))),
        option: IdiomSessionOption::new(IdiomScope::Project, MAX_AGENTS_MD_IDIOMS).ok(),
    }
}

/// Reads the project's `AGENTS.md` idioms, or an empty set when the file is
/// absent.
///
/// Sections and bullet items become Text idioms with static provenance,
/// Project scope, full confidence, and deterministic line-derived ids. The
/// output is capped at `MAX_AGENTS_MD_IDIOMS` in file order.
pub fn agents_md_idioms(project_root: &Path, at: MonotonicInstant) -> Vec<Idiom> {
    let path = project_root.join("AGENTS.md");
    let Ok(content) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    let mut records = Vec::new();
    let mut in_code_fence = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code_fence = !in_code_fence;
            continue;
        }
        if in_code_fence {
            continue;
        }
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        if records.len() >= MAX_AGENTS_MD_IDIOMS {
            break;
        }
        let text = trimmed.trim_start_matches(['-', '*', ' ']).trim();
        let Ok(text) = BoundedText::new(text, MAX_LINE_BYTES) else {
            continue;
        };
        let Ok(id) = IdiomId::new(format!("agents-md:{}", records.len())) else {
            continue;
        };
        let Ok(constraint) = IdiomConstraint::text(text.as_str().to_owned()) else {
            continue;
        };
        let Ok(source) = BoundedText::new(AGENTS_MD_SOURCE, 256) else {
            continue;
        };
        let Ok(idiom) = Idiom::new(
            id,
            IdiomScope::Project,
            constraint,
            100,
            at,
            Provenance::Static(source),
        ) else {
            continue;
        };
        records.push(idiom);
    }
    records
}

#[cfg(test)]
mod tests {
    use super::{agents_md_idioms, MAX_AGENTS_MD_IDIOMS};
    use swallowtail_idioms::MonotonicInstant;

    fn at() -> MonotonicInstant {
        MonotonicInstant::from_ticks(0)
    }

    #[test]
    fn absent_file_yields_no_idioms() {
        let dir = std::env::temp_dir().join("nucleus-idioms-absent");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        assert!(agents_md_idioms(&dir, at()).is_empty());
    }

    #[test]
    fn parses_sections_and_bullets_into_static_project_idioms() {
        let dir = std::env::temp_dir().join("nucleus-idioms-parse");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        std::fs::write(
            dir.join("AGENTS.md"),
            "# Project\n\n## Code Style\n\n- Use named exports\n- Prefer small modules\n\n## Skip\n\n```code\n- not a rule\n```\n",
        )
        .expect("fixture write");

        let idioms = agents_md_idioms(&dir, at());
        assert_eq!(idioms.len(), 2);
        assert_eq!(idioms[0].id().as_str(), "agents-md:0");
        assert!(matches!(
            idioms[0].constraint(),
            swallowtail_idioms::IdiomConstraint::Text(text)
                if text.as_str() == "Use named exports"
        ));
        assert!(matches!(
            idioms[0].scope(),
            swallowtail_idioms::IdiomScope::Project
        ));
        assert_eq!(idioms[0].confidence().value(), 100);
    }

    #[test]
    fn caps_the_record_count() {
        let dir = std::env::temp_dir().join("nucleus-idioms-cap");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("fixture dir");
        let mut content = String::new();
        for index in 0..(MAX_AGENTS_MD_IDIOMS + 8) {
            content.push_str(&format!("- rule number {index}\n"));
        }
        std::fs::write(dir.join("AGENTS.md"), content).expect("fixture write");

        let idioms = agents_md_idioms(&dir, at());
        assert_eq!(idioms.len(), MAX_AGENTS_MD_IDIOMS);
    }
}
