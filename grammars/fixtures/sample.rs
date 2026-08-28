use std::collections::HashMap;

#[derive(Debug, Clone)]
pub struct Config<'a> {
    entries: HashMap<&'a str, u32>,
}

impl<'a> Config<'a> {
    pub fn get(&self, key: &str) -> Option<u32> {
        self.entries.get(key).copied()
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let cfg = Config { entries: HashMap::new() };
    let value = cfg.get("port").unwrap_or(8080);
    println!("port = {value}");
    Ok(())
}
