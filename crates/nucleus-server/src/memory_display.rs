use nucleus_memory::MemorySensitivityStorage;

pub(crate) const MEMORY_DISPLAY_TITLE_LIMIT: usize = 160;
pub(crate) const MEMORY_DISPLAY_SUMMARY_LIMIT: usize = 600;

pub(crate) struct ProjectMemoryDisplay {
    pub title: Option<String>,
    pub summary: Option<String>,
    pub redacted: bool,
    pub truncated: bool,
}

pub(crate) fn project_memory_display(
    title: &str,
    summary: &str,
    sensitivity: &MemorySensitivityStorage,
) -> ProjectMemoryDisplay {
    if !matches!(
        sensitivity,
        MemorySensitivityStorage::PublicProject | MemorySensitivityStorage::InternalProject
    ) {
        return ProjectMemoryDisplay {
            title: None,
            summary: None,
            redacted: true,
            truncated: false,
        };
    }

    let (title, title_truncated) = bounded_display_text(title, MEMORY_DISPLAY_TITLE_LIMIT);
    let (summary, summary_truncated) = bounded_display_text(summary, MEMORY_DISPLAY_SUMMARY_LIMIT);
    ProjectMemoryDisplay {
        title,
        summary,
        redacted: false,
        truncated: title_truncated || summary_truncated,
    }
}

fn bounded_display_text(value: &str, limit: usize) -> (Option<String>, bool) {
    let value = value.trim();
    if value.is_empty() {
        return (None, false);
    }

    let truncated = value.chars().count() > limit;
    let bounded = value.chars().take(limit).collect();
    (Some(bounded), truncated)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn visible_project_content_is_trimmed_and_unicode_bounded() {
        let title = format!("  {}  ", "🧠".repeat(MEMORY_DISPLAY_TITLE_LIMIT + 1));
        let display = project_memory_display(
            &title,
            "  Durable project context.  ",
            &MemorySensitivityStorage::InternalProject,
        );

        assert_eq!(
            display.title.as_deref().unwrap().chars().count(),
            MEMORY_DISPLAY_TITLE_LIMIT
        );
        assert_eq!(display.summary.as_deref(), Some("Durable project context."));
        assert!(!display.redacted);
        assert!(display.truncated);
    }

    #[test]
    fn sensitive_content_is_absent_and_explicitly_redacted() {
        for sensitivity in [
            MemorySensitivityStorage::UserPrivate,
            MemorySensitivityStorage::SecretAdjacent,
            MemorySensitivityStorage::Restricted,
        ] {
            let display = project_memory_display("Private title", "Private summary", &sensitivity);
            assert_eq!(display.title, None);
            assert_eq!(display.summary, None);
            assert!(display.redacted);
            assert!(!display.truncated);
        }
    }
}
