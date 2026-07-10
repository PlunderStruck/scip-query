use std::io::{self, Read};

use scip_query_kernels::{classify_consumers, leaf_name, ConsumerClassifyRequest};

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("leaf-name") => run_leaf_name(),
        Some("consumer-classify") => run_consumer_classify(),
        _ => Err("usage: scip-query-kernels <leaf-name|consumer-classify> < input".to_string()),
    }
}

fn read_stdin() -> Result<String, String> {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .map_err(|error| format!("failed to read stdin: {error}"))?;
    Ok(input)
}

fn run_leaf_name() -> Result<(), String> {
    let input = read_stdin()?;

    for line in input.lines() {
        println!("{}", leaf_name(line));
    }
    Ok(())
}

fn run_consumer_classify() -> Result<(), String> {
    let input = read_stdin()?;
    let request: ConsumerClassifyRequest = serde_json::from_str(&input)
        .map_err(|error| format!("failed to parse consumer classify JSON: {error}"))?;
    let response = classify_consumers(&request);
    serde_json::to_writer(io::stdout(), &response)
        .map_err(|error| format!("failed to write consumer classify JSON: {error}"))?;
    println!();
    Ok(())
}
