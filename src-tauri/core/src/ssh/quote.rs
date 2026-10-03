//! Safe construction of remote shell commands.

/// Quote a string for POSIX `sh` using single quotes.
pub fn sh_quote(s: &str) -> String {
    if !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:@%+,".contains(c)) {
        return s.to_string();
    }
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Run a script with `sh -c` regardless of the user's login shell (fish, csh…)
/// and with a predictable locale so output can be parsed.
pub fn sh_script(script: &str) -> String {
    format!("env LC_ALL=C LANG=C sh -c {}", sh_quote(script))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quoting() {
        assert_eq!(sh_quote("abc"), "abc");
        assert_eq!(sh_quote("/var/www/my site"), "'/var/www/my site'");
        assert_eq!(sh_quote("it's"), "'it'\\''s'");
        assert_eq!(sh_quote(""), "''");
        assert_eq!(sh_quote("a;rm -rf /"), "'a;rm -rf /'");
        assert_eq!(sh_quote("$(id)"), "'$(id)'");
    }
}
