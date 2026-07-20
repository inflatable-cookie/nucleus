use serde_json::Value;
use swallowtail_runtime::{OperationContent, SchemaDocument, ToolDeclaration};

const MAXIMUM_TOOL_COUNT: usize = 16;
const MAXIMUM_TOOL_SCHEMA_BYTES: usize = 512 * 1024;

pub(super) fn tool_declarations(specs: Vec<Value>) -> Result<Vec<ToolDeclaration>, String> {
    if specs.len() > MAXIMUM_TOOL_COUNT {
        return Err("too many Nucleus dynamic tools for the Codex session".to_owned());
    }
    specs
        .into_iter()
        .map(|spec| {
            if spec.get("type").and_then(Value::as_str) != Some("function") {
                return Err("Nucleus dynamic tool is not a function declaration".to_owned());
            }
            let name = spec
                .get("name")
                .and_then(Value::as_str)
                .ok_or_else(|| "Nucleus dynamic tool has no name".to_owned())?;
            let description = spec
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let schema = spec
                .get("inputSchema")
                .ok_or_else(|| format!("Nucleus dynamic tool {name} has no input schema"))?;
            let schema = serde_json::to_vec(schema)
                .map_err(|_| format!("Nucleus dynamic tool {name} schema is invalid"))?;
            let declaration = ToolDeclaration::new(
                name,
                SchemaDocument::inline(schema, MAXIMUM_TOOL_SCHEMA_BYTES)
                    .map_err(|error| error.to_string())?,
                "application/schema+json",
                "json-schema-2020-12",
            )
            .map_err(|error| error.to_string())?;
            if description.is_empty() {
                Ok(declaration)
            } else {
                Ok(declaration.with_description(
                    OperationContent::new(description).map_err(|error| error.to_string())?,
                ))
            }
        })
        .collect()
}
