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

#[cfg(test)]
mod tests {
    use super::leaf_name;

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
}
