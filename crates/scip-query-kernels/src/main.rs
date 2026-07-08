use std::io::{self, Read};

use scip_query_kernels::leaf_name;

fn main() {
    let mut args = std::env::args().skip(1);
    match args.next().as_deref() {
        Some("leaf-name") => run_leaf_name(),
        _ => {
            eprintln!("usage: scip-query-kernels leaf-name < symbols.txt");
            std::process::exit(2);
        }
    }
}

fn run_leaf_name() {
    let mut input = String::new();
    io::stdin()
        .read_to_string(&mut input)
        .expect("failed to read stdin");

    for line in input.lines() {
        println!("{}", leaf_name(line));
    }
}
