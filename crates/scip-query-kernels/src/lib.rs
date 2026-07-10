use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

pub fn leaf_name(raw: &str) -> String {
    if let Some(local) = raw.strip_prefix("local ") {
        return local.to_string();
    }

    let Some(descriptors) = descriptor_input(raw) else {
        return String::new();
    };

    let mut parser = DescriptorParser::new(descriptors);
    let mut last = String::new();
    while let Some(name) = parser.next_name() {
        last = name;
    }
    last
}

fn descriptor_input(raw: &str) -> Option<&str> {
    let mut rest = raw;
    let (_, after_scheme) = rest.split_once(' ')?;
    rest = after_scheme;
    let (_, after_manager) = rest.split_once(' ')?;
    rest = after_manager;

    if let Some(after_tick) = rest.strip_prefix('`') {
        let closing = after_tick.find('`')?;
        rest = after_tick.get(closing + 1..)?;
        rest = rest.strip_prefix(' ')?;
    } else {
        let (_, after_package) = rest.split_once(' ')?;
        rest = after_package;
    }

    let (_, descriptors) = rest.split_once(' ')?;
    Some(descriptors)
}

struct DescriptorParser<'a> {
    input: &'a str,
    index: usize,
}

impl<'a> DescriptorParser<'a> {
    fn new(input: &'a str) -> Self {
        Self { input, index: 0 }
    }

    fn next_name(&mut self) -> Option<String> {
        while self.index < self.input.len() {
            if self.current_byte() == b'[' {
                let start = self.index + 1;
                if let Some(close) = self.find_from(start, b']') {
                    self.index = close + 1;
                    return Some(self.input[start..close].to_string());
                }
                self.index = self.input.len();
                return Some(self.input[start..].to_string());
            }

            if self.current_byte() == b'(' && self.parameter_starts_here() {
                let start = self.index + 1;
                if let Some(close) = self.find_from(start, b')') {
                    if self.input.as_bytes().get(close + 1) != Some(&b'.') {
                        self.index = close + 1;
                        return Some(self.input[start..close].to_string());
                    }
                }
            }

            let name = if self.current_byte() == b'`' {
                self.backtick_name()
            } else {
                self.unescaped_name()
            };

            if self.index >= self.input.len() {
                return (!name.is_empty()).then_some(name);
            }

            match self.current_byte() {
                b'(' => {
                    if let Some(close) = self.find_from(self.index + 1, b')') {
                        self.index = if self.input.as_bytes().get(close + 1) == Some(&b'.') {
                            close + 2
                        } else {
                            close + 1
                        };
                    } else {
                        self.index += 1;
                    }
                    return Some(name);
                }
                b'/' | b'#' | b'.' | b'[' | b':' | b'!' => {
                    self.index += 1;
                    return Some(name);
                }
                _ => {
                    self.index += 1;
                }
            }
        }
        None
    }

    fn backtick_name(&mut self) -> String {
        let start = self.index + 1;
        if let Some(close) = self.find_from(start, b'`') {
            self.index = close + 1;
            self.input[start..close].to_string()
        } else {
            self.index = self.input.len();
            self.input[start..].to_string()
        }
    }

    fn unescaped_name(&mut self) -> String {
        let start = self.index;
        while self.index < self.input.len() && !is_suffix_byte(self.current_byte()) {
            self.index += 1;
        }
        self.input[start..self.index].to_string()
    }

    fn parameter_starts_here(&self) -> bool {
        self.index == 0
            || self
                .input
                .as_bytes()
                .get(self.index.saturating_sub(1))
                .is_some_and(|byte| is_suffix_byte(*byte))
    }

    fn current_byte(&self) -> u8 {
        self.input.as_bytes()[self.index]
    }

    fn find_from(&self, start: usize, needle: u8) -> Option<usize> {
        self.input
            .as_bytes()
            .get(start..)?
            .iter()
            .position(|byte| *byte == needle)
            .map(|offset| start + offset)
    }
}

fn is_suffix_byte(byte: u8) -> bool {
    matches!(byte, b'/' | b'#' | b'.' | b'(' | b'[' | b':' | b'!')
}

#[derive(Debug, Deserialize)]
pub struct ConsumerClassifyRequest {
    pub definitions: Vec<ConsumerDefinitionInput>,
    pub file_usages: HashMap<String, FileUsageInput>,
    #[serde(default)]
    pub reexport_only_leaves: HashMap<String, HashSet<String>>,
}

#[derive(Debug, Deserialize)]
pub struct ConsumerDefinitionInput {
    pub symbol_id: i64,
    pub leaf: String,
    pub consumer_files: Vec<ConsumerFileInput>,
}

#[derive(Debug, Deserialize)]
pub struct ConsumerFileInput {
    pub file: String,
    #[serde(default)]
    pub sources: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct FileUsageInput {
    #[serde(default)]
    pub imported_leaves: HashSet<String>,
    #[serde(default)]
    pub used_leaves: HashSet<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ConsumerClassifyResponse {
    pub entries: Vec<ConsumerDefinitionOutput>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ConsumerDefinitionOutput {
    pub symbol_id: i64,
    pub real_consumers: Vec<String>,
    pub barrel_consumers: usize,
    pub import_only_consumers: usize,
    pub files: Vec<ConsumerFileOutput>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct ConsumerFileOutput {
    pub file: String,
    pub sources: Vec<String>,
    pub classification: ConsumerClassification,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum ConsumerClassification {
    Real,
    ReexportOnly,
    ImportOnly,
}

pub fn classify_consumers(request: &ConsumerClassifyRequest) -> ConsumerClassifyResponse {
    let mut entries = Vec::with_capacity(request.definitions.len());
    for definition in &request.definitions {
        entries.push(classify_definition_consumers(definition, request));
    }
    ConsumerClassifyResponse { entries }
}

fn classify_definition_consumers(
    definition: &ConsumerDefinitionInput,
    request: &ConsumerClassifyRequest,
) -> ConsumerDefinitionOutput {
    let mut real_consumers = Vec::with_capacity(definition.consumer_files.len());
    let mut barrel_consumers = 0;
    let mut import_only_consumers = 0;
    let mut files = Vec::with_capacity(definition.consumer_files.len());

    for consumer in &definition.consumer_files {
        let classification = classify_consumer_file(&definition.leaf, &consumer.file, request);
        match classification {
            ConsumerClassification::Real => real_consumers.push(consumer.file.clone()),
            ConsumerClassification::ReexportOnly => barrel_consumers += 1,
            ConsumerClassification::ImportOnly => import_only_consumers += 1,
        }
        files.push(ConsumerFileOutput {
            file: consumer.file.clone(),
            sources: consumer.sources.clone(),
            classification,
        });
    }

    ConsumerDefinitionOutput {
        symbol_id: definition.symbol_id,
        real_consumers,
        barrel_consumers,
        import_only_consumers,
        files,
    }
}

fn classify_consumer_file(
    leaf: &str,
    consumer_file: &str,
    request: &ConsumerClassifyRequest,
) -> ConsumerClassification {
    if leaf.is_empty() {
        return ConsumerClassification::Real;
    }
    if request
        .reexport_only_leaves
        .get(consumer_file)
        .is_some_and(|leaves| leaves.contains(leaf))
    {
        return ConsumerClassification::ReexportOnly;
    }
    if request.file_usages.get(consumer_file).is_some_and(|usage| {
        usage.imported_leaves.contains(leaf) && !usage.used_leaves.contains(leaf)
    }) {
        return ConsumerClassification::ImportOnly;
    }
    ConsumerClassification::Real
}

#[cfg(test)]
mod tests {
    use std::collections::{HashMap, HashSet};

    use super::{
        classify_consumers, leaf_name, ConsumerClassification, ConsumerClassifyRequest,
        ConsumerClassifyResponse, ConsumerDefinitionInput, ConsumerDefinitionOutput,
        ConsumerFileInput, ConsumerFileOutput, FileUsageInput,
    };

    #[test]
    fn extracts_leaf_names_from_scip_symbols() {
        let cases = [
            (
                "scip-typescript npm @vega/api 0.1.3 src/modules/auth/`auth.service.ts`/AuthService#login().",
                "login",
            ),
            (
                "rust-analyzer cargo my-crate 0.1.0 src/`lib.rs`/MyStruct#new().",
                "new",
            ),
            (
                "scip-typescript npm pkg 1.0.0 `file.ts`/Generic#[T]",
                "T",
            ),
            (
                "scip-typescript npm pkg 1.0.0 `file.ts`/MyClass#method().(param)",
                "param",
            ),
            ("local 42", "42"),
        ];

        for (raw, expected) in cases {
            assert_eq!(leaf_name(raw), expected);
        }
    }

    #[test]
    fn classifies_definition_consumers_from_file_usage() {
        let request = ConsumerClassifyRequest {
            definitions: vec![ConsumerDefinitionInput {
                symbol_id: 7,
                leaf: "target".to_string(),
                consumer_files: vec![
                    ConsumerFileInput {
                        file: "src/real.ts".to_string(),
                        sources: vec!["indexed".to_string()],
                    },
                    ConsumerFileInput {
                        file: "src/import-only.ts".to_string(),
                        sources: vec!["indexed".to_string(), "source-fallback".to_string()],
                    },
                    ConsumerFileInput {
                        file: "src/barrel.ts".to_string(),
                        sources: vec!["indexed".to_string()],
                    },
                ],
            }],
            file_usages: HashMap::from([
                (
                    "src/real.ts".to_string(),
                    FileUsageInput {
                        imported_leaves: HashSet::from(["target".to_string()]),
                        used_leaves: HashSet::from(["target".to_string()]),
                    },
                ),
                (
                    "src/import-only.ts".to_string(),
                    FileUsageInput {
                        imported_leaves: HashSet::from(["target".to_string()]),
                        used_leaves: HashSet::new(),
                    },
                ),
            ]),
            reexport_only_leaves: HashMap::from([(
                "src/barrel.ts".to_string(),
                HashSet::from(["target".to_string()]),
            )]),
        };

        assert_eq!(
            classify_consumers(&request),
            ConsumerClassifyResponse {
                entries: vec![ConsumerDefinitionOutput {
                    symbol_id: 7,
                    real_consumers: vec!["src/real.ts".to_string()],
                    barrel_consumers: 1,
                    import_only_consumers: 1,
                    files: vec![
                        ConsumerFileOutput {
                            file: "src/real.ts".to_string(),
                            sources: vec!["indexed".to_string()],
                            classification: ConsumerClassification::Real,
                        },
                        ConsumerFileOutput {
                            file: "src/import-only.ts".to_string(),
                            sources: vec!["indexed".to_string(), "source-fallback".to_string()],
                            classification: ConsumerClassification::ImportOnly,
                        },
                        ConsumerFileOutput {
                            file: "src/barrel.ts".to_string(),
                            sources: vec!["indexed".to_string()],
                            classification: ConsumerClassification::ReexportOnly,
                        },
                    ],
                }],
            },
        );
    }
}
